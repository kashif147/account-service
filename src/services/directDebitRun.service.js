import crypto from "crypto";
import DirectDebitRun, { OPEN_RUN_STATUSES } from "../models/directDebitRun.model.js";
import DirectDebitRunItem from "../models/directDebitRunItem.model.js";
import { AppError } from "../errors/AppError.js";
import * as azureBlob from "../services/azure.blob.service.js";
import {
  buildEligibilityItems,
  computeRunTotals,
  findDuplicateOpenRun,
} from "./directDebitEligibility.service.js";
import {
  allocateMessageId,
  allocatePaymentInformationId,
  allocateRunNumberParts,
  generateEndToEndId,
  normalizeTenantCode,
  validateSepaReference,
  SEPA_MAX,
} from "./sepaReferenceGenerator.js";
import { resolveTenantCode } from "./tenant.service.client.js";
import {
  buildPain008Xml,
  groupItemsForPain008,
  validatePain008Inputs,
} from "./pain008.service.js";
import { matchPain002ToItems, parsePain002Xml } from "./pain002.service.js";
import { publishDomainEvent } from "../rabbitMQ/index.js";
import logger from "../config/logger.js";

const DD_PREPARE_EXCHANGE = "batch.events";
const DD_PREPARE_REQUESTED = "dd.prepare.requested.v1";
const DD_PREPARE_QUEUED = "batch.process.queued.v1";
const DD_PREPARE_PROGRESS = "batch.process.progress.v1";
const DD_PREPARE_COMPLETED = "batch.process.completed.v1";

async function publishDdPrepareEvent(eventType, run, extra = {}) {
  try {
    await publishDomainEvent(
      eventType,
      {
        kind: "DD_PREPARE",
        batchDetailId: String(run._id),
        runId: String(run._id),
        runNo: run.runNo,
        tenantId: run.tenantId,
        userId: extra.userId || run.prepareJob?.requestedBy || run.createdBy,
        createdBy: run.createdBy,
        batchName: `DD run ${run.runNo}`,
        referenceNumber: run.runNo,
        description: `Direct Debit run ${run.runNo}`,
        ...extra,
      },
      {
        tenantId: run.tenantId || undefined,
        exchange: DD_PREPARE_EXCHANGE,
        routingKey: eventType,
        metadata: { service: "account-service", version: "1.0" },
      },
    );
  } catch (err) {
    logger.warn(
      { runId: String(run._id), eventType, err: err.message },
      "[DD prepare] failed to publish event",
    );
  }
}

function pushAudit(run, action, actorId, details = {}) {
  run.auditTrail = run.auditTrail || [];
  run.auditTrail.push({
    at: new Date(),
    action,
    actorId: actorId || null,
    details: {
      runNo: run.runNo,
      messageId: run.file?.messageId || run.pain008?.msgId || null,
      paymentInformationId:
        run.file?.paymentInformationId || run.pain008?.pmtInfIds?.[0] || null,
      ...details,
    },
  });
}

async function createRunWithRetry(payload, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await DirectDebitRun.create(payload);
    } catch (err) {
      if (err?.code === 11000 && attempt < maxAttempts - 1) {
        const parts = await allocateRunNumberParts({
          tenantId: payload.tenantId,
          tenantCode: payload.tenantCode,
          runType: payload.runType,
          periodEndDate: payload.periodEndDate,
        });
        Object.assign(payload, parts);
        continue;
      }
      throw err;
    }
  }
  throw AppError.conflict("Could not allocate unique DD run number");
}

function assertStatus(run, allowed, action) {
  if (!allowed.includes(run.status)) {
    throw AppError.badRequest(
      `Cannot ${action} run in status ${run.status}; expected one of ${allowed.join(", ")}`,
    );
  }
}

export async function createDirectDebitRun({
  tenantId,
  runType,
  periodStartDate,
  periodEndDate,
  collectionDate,
  submissionDueDate,
  creditorSnapshot,
  createdBy,
  req = null,
}) {
  const periodStart = new Date(periodStartDate);
  const periodEnd = new Date(periodEndDate);
  const collection = new Date(collectionDate);

  const dup = await findDuplicateOpenRun(
    tenantId,
    runType,
    periodStart,
    periodEnd,
    collection,
  );
  if (dup) {
    throw AppError.conflict(
      `An open DD run already exists for this period and collection date (${dup.runNo})`,
    );
  }

  const tenantCodeRaw = await resolveTenantCode(tenantId, req);
  const tenantCode = normalizeTenantCode(tenantCodeRaw, tenantId);
  const { runNo, runSequence, periodKey } = await allocateRunNumberParts({
    tenantId,
    tenantCode,
    runType,
    periodEndDate: periodEnd,
  });

  const run = await createRunWithRetry({
    tenantId,
    runNo,
    runSequence,
    periodKey,
    tenantCode,
    runType,
    periodStartDate: periodStart,
    periodEndDate: periodEnd,
    collectionDate: collection,
    submissionDueDate: submissionDueDate ? new Date(submissionDueDate) : null,
    status: "DRAFT",
    creditorSnapshot: creditorSnapshot || {},
    createdBy,
    updatedBy: createdBy,
    auditTrail: [
      {
        at: new Date(),
        action: "CREATED",
        actorId: createdBy,
        details: {
          runNo,
          runSequence,
          periodKey,
          tenantCode,
          runType,
        },
      },
    ],
  });
  return run;
}

/**
 * Atomically transition the run's prepare job into `queued`, publish a
 * `batch.process.queued.v1` event, and fire the worker with `setImmediate` so
 * the heavy build runs after the HTTP response is sent.
 *
 * The HTTP controller passes a `forwardHeaders` snapshot (from
 * `captureForwardHeaders`) so the worker can call profile-service /
 * subscription-service with the same CRM JWT.
 *
 * Reuses the existing `batch.process.queued.v1` / `batch.process.completed.v1`
 * routing keys so notification-service emits the same toast/socket events we
 * use for Standing Order and Deduction batches.
 */
export async function queuePrepareJob(runId, tenantId, actorId, forwardHeaders = null) {
  const claimed = await DirectDebitRun.findOneAndUpdate(
    {
      _id: runId,
      tenantId,
      status: { $in: ["DRAFT", "VALIDATED"] },
      "prepareJob.status": { $nin: ["queued", "running"] },
    },
    {
      $set: {
        "prepareJob.status": "queued",
        "prepareJob.queuedAt": new Date(),
        "prepareJob.startedAt": null,
        "prepareJob.completedAt": null,
        "prepareJob.requestedBy": actorId || null,
        "prepareJob.errorMessage": null,
        "prepareJob.progress.processed": 0,
        "prepareJob.progress.total": 0,
        "prepareJob.progress.phase": "queued",
        validationSummary: { isValid: false, errors: [], warnings: [] },
      },
      $inc: { "prepareJob.attempts": 1 },
    },
    { new: true },
  );

  if (!claimed) {
    const existing = await DirectDebitRun.findOne({ _id: runId, tenantId })
      .select("status prepareJob")
      .lean();
    if (!existing) throw AppError.notFound("Direct debit run not found");
    if (["queued", "running"].includes(existing.prepareJob?.status)) {
      throw AppError.conflict(
        "Prepare is already in progress for this run",
      );
    }
    throw AppError.badRequest(
      `Cannot prepare run in status ${existing.status}; expected DRAFT or VALIDATED`,
    );
  }

  pushAudit(claimed, "PREPARE_QUEUED", actorId);
  claimed.updatedBy = actorId;
  await claimed.save();

  await publishDdPrepareEvent(DD_PREPARE_QUEUED, claimed, {
    status: "queued",
    totalTransactions: 0,
    processedTransactions: 0,
    failedTransactions: 0,
  });

  // In-process worker: runs after the HTTP response is flushed.
  // setImmediate detaches us from the request/response lifecycle.
  setImmediate(() => {
    executePrepareJob(String(claimed._id), tenantId, forwardHeaders).catch((err) =>
      logger.error(
        { runId: String(claimed._id), err: err.message },
        "[DD prepare] executor threw unexpectedly",
      ),
    );
  });

  return claimed;
}

/**
 * Background worker: builds eligibility items for the queued prepare job.
 * Fired via setImmediate after the HTTP response is sent, or by the cron
 * sweeper (fallback for orphaned jobs).
 *
 * `forwardHeaders` is the snapshot captured at queue time so upstream calls
 * carry the same CRM JWT/tenant headers as the original HTTP request.
 */
export async function executePrepareJob(runId, tenantId, forwardHeaders = null) {
  const claimed = await DirectDebitRun.findOneAndUpdate(
    {
      _id: runId,
      tenantId,
      "prepareJob.status": "queued",
    },
    {
      $set: {
        "prepareJob.status": "running",
        "prepareJob.startedAt": new Date(),
        "prepareJob.progress.phase": "loading",
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await DirectDebitRun.findOne({ _id: runId, tenantId })
      .select("prepareJob status")
      .lean();
    if (!current) {
      return { success: false, message: "Direct debit run not found" };
    }
    if (current.prepareJob?.status === "running") {
      return { success: false, message: "Prepare already running" };
    }
    return {
      success: false,
      message: `Run not in queued state (prepareJob.status=${current.prepareJob?.status})`,
    };
  }

  const actorId = claimed.prepareJob?.requestedBy || claimed.createdBy;

  try {
    await DirectDebitRunItem.deleteMany({ tenantId, runId: claimed._id });

    // Reconstruct a minimal req-like object from the snapshot taken at queue
    // time so the upstream HTTP client can forward the original CRM JWT.
    const workerReq = forwardHeaders
      ? {
          headers: { ...(forwardHeaders.headers || {}) },
          tenantId: forwardHeaders.tenantId || tenantId,
          correlationId: forwardHeaders.correlationId || null,
        }
      : null;

    const { included, excluded } = await buildEligibilityItems({
      tenantId,
      run: claimed,
      actorId,
      req: workerReq,
    });

    await DirectDebitRun.updateOne(
      { _id: claimed._id, tenantId },
      {
        $set: {
          "prepareJob.progress.total": included.length + excluded.length,
          "prepareJob.progress.processed": 0,
          "prepareJob.progress.phase": "writing_items",
        },
      },
    );

    const excludedDocs = excluded.map((e, idx) => {
      const endToEndId = generateEndToEndId({
        membershipNumber: null,
        periodKey: claimed.periodKey,
        runSequence: claimed.runSequence,
        itemSequence: idx + 1,
      });
      return {
        tenantId,
        runId: claimed._id,
        memberId: e.memberId || "UNKNOWN",
        profileId: e.profileId,
        subscriptionId: e.subscriptionId,
        amountEur: 0,
        currency: "EUR",
        endToEndId,
        collection: { endToEndId },
        status: "EXCLUDED",
        exclusionReason: e.exclusionReason,
        memberSnapshot: {},
        mandateSnapshot: {},
        collectionPeriod: {
          startDate: claimed.periodStartDate,
          endDate: claimed.periodEndDate,
        },
      };
    });

    const docs = [...included, ...excludedDocs];

    if (docs.length) {
      const chunkSize = Math.max(
        50,
        parseInt(process.env.DD_PREPARE_INSERT_CHUNK_SIZE || "500", 10),
      );
      let processed = 0;
      for (let i = 0; i < docs.length; i += chunkSize) {
        const slice = docs.slice(i, i + chunkSize);
        await DirectDebitRunItem.insertMany(slice, { ordered: false });
        processed += slice.length;
        await DirectDebitRun.updateOne(
          { _id: claimed._id, tenantId },
          { $set: { "prepareJob.progress.processed": processed } },
        );
        await publishDdPrepareEvent(DD_PREPARE_PROGRESS, claimed, {
          status: "running",
          processedTransactions: processed,
          totalTransactions: docs.length,
          failedTransactions: 0,
        });
      }
    }

    const items = await DirectDebitRunItem.find({
      tenantId,
      runId: claimed._id,
    }).lean();
    const totals = computeRunTotals(items);

    const updatedRun = await DirectDebitRun.findOneAndUpdate(
      { _id: claimed._id, tenantId },
      {
        $set: {
          totals,
          status: "DRAFT",
          validationSummary: { isValid: false, errors: [], warnings: [] },
          "prepareJob.status": "completed",
          "prepareJob.completedAt": new Date(),
          "prepareJob.errorMessage": null,
          "prepareJob.progress.phase": "completed",
          "prepareJob.progress.processed": docs.length,
          "prepareJob.progress.total": docs.length,
        },
        $push: {
          auditTrail: {
            at: new Date(),
            action: "PREPARED",
            actorId: actorId || null,
            details: {
              runNo: claimed.runNo,
              included: included.length,
              excluded: excluded.length,
            },
          },
        },
      },
      { new: true },
    );

    await publishDdPrepareEvent(DD_PREPARE_COMPLETED, updatedRun || claimed, {
      status: "processed",
      processedTransactions: docs.length,
      totalTransactions: docs.length,
      failedTransactions: 0,
      included: included.length,
      excluded: excluded.length,
    });

    return {
      success: true,
      processed: docs.length,
      included: included.length,
      excluded: excluded.length,
    };
  } catch (err) {
    const errMsg = err.message || String(err);
    logger.error(
      { runId: String(claimed._id), err: errMsg },
      "[DD prepare] worker failed",
    );
    const failed = await DirectDebitRun.findOneAndUpdate(
      { _id: claimed._id, tenantId },
      {
        $set: {
          "prepareJob.status": "failed",
          "prepareJob.completedAt": new Date(),
          "prepareJob.errorMessage": errMsg.slice(0, 1000),
          "prepareJob.progress.phase": "failed",
        },
        $push: {
          auditTrail: {
            at: new Date(),
            action: "PREPARE_FAILED",
            actorId: actorId || null,
            details: { runNo: claimed.runNo, error: errMsg.slice(0, 500) },
          },
        },
      },
      { new: true },
    );

    await publishDdPrepareEvent(DD_PREPARE_COMPLETED, failed || claimed, {
      status: "failed",
      processedTransactions: 0,
      totalTransactions: 0,
      failedTransactions: 0,
      message: errMsg.slice(0, 500),
    });

    return { success: false, message: errMsg };
  }
}

/**
 * @deprecated Use `queuePrepareJob` + background worker. Kept for tests that
 * still drive the synchronous path; only safe for small data sets.
 */
export async function prepareDirectDebitRun(runId, tenantId, actorId, req) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["DRAFT", "VALIDATED"], "prepare");

  await DirectDebitRunItem.deleteMany({ tenantId, runId: run._id });

  const { included, excluded } = await buildEligibilityItems({
    tenantId,
    run,
    actorId,
    req,
  });

  const docs = [
    ...included,
    ...excluded.map((e, idx) => {
      const endToEndId = generateEndToEndId({
        membershipNumber: null,
        periodKey: run.periodKey,
        runSequence: run.runSequence,
        itemSequence: idx + 1,
      });
      return {
        tenantId,
        runId: run._id,
        memberId: e.memberId || "UNKNOWN",
        profileId: e.profileId,
        subscriptionId: e.subscriptionId,
        amountEur: 0,
        currency: "EUR",
        endToEndId,
        collection: { endToEndId },
        status: "EXCLUDED",
        exclusionReason: e.exclusionReason,
        memberSnapshot: {},
        mandateSnapshot: {},
        collectionPeriod: {
          startDate: run.periodStartDate,
          endDate: run.periodEndDate,
        },
      };
    }),
  ];

  if (docs.length) {
    await DirectDebitRunItem.insertMany(docs, { ordered: false });
  }

  const items = await DirectDebitRunItem.find({ tenantId, runId: run._id }).lean();
  run.totals = computeRunTotals(items);
  run.status = "DRAFT";
  run.validationSummary = { isValid: false, errors: [], warnings: [] };
  run.prepareJob = {
    ...(run.prepareJob || {}),
    status: "completed",
    completedAt: new Date(),
    progress: { processed: docs.length, total: docs.length, phase: "completed" },
  };
  pushAudit(run, "PREPARED", actorId, {
    included: included.length,
    excluded: excluded.length,
  });
  run.updatedBy = actorId;
  await run.save();
  return run;
}

export async function validateDirectDebitRun(runId, tenantId, actorId) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["DRAFT", "VALIDATED"], "validate");

  const items = await DirectDebitRunItem.find({
    tenantId,
    runId: run._id,
    status: "INCLUDED",
  }).lean();

  const errors = validatePain008Inputs(run.creditorSnapshot);
  const warnings = [];

  for (const item of items) {
    if (!item.mandateSnapshot?.debtorIban) {
      errors.push({
        code: "MISSING_DEBTOR_IBAN",
        message: "Debtor IBAN missing on snapshot",
        memberId: item.memberId,
        profileId: String(item.profileId),
      });
    }
    if (item.amountEur <= 0) {
      errors.push({
        code: "INVALID_AMOUNT",
        message: "Amount must be positive",
        memberId: item.memberId,
        profileId: String(item.profileId),
      });
    }
  }

  if (items.length === 0) {
    errors.push({
      code: "NO_INCLUDED_ITEMS",
      message: "No included members to collect",
    });
  }

  try {
    const collectionDate = run.collectionDate.toISOString().slice(0, 10);
    groupItemsForPain008(items, run.creditorSnapshot, collectionDate);
  } catch (err) {
    errors.push({ code: "PAIN008_GROUPING", message: err.message });
  }

  run.validationSummary = {
    isValid: errors.length === 0,
    errors,
    warnings,
    validatedAt: new Date(),
    validatedBy: actorId,
  };
  run.status = "VALIDATED";
  pushAudit(run, errors.length === 0 ? "VALIDATED" : "VALIDATION_FAILED", actorId, {
    isValid: errors.length === 0,
    errorCount: errors.length,
  });
  run.updatedBy = actorId;
  await run.save();
  return run;
}

export async function approveDirectDebitRun(runId, tenantId, actorId, notes) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["VALIDATED"], "approve");
  if (!run.validationSummary?.isValid) {
    throw AppError.badRequest("Run must pass validation before approval");
  }
  run.status = "APPROVED";
  run.approval = { approvedAt: new Date(), approvedBy: actorId, notes: notes || "" };
  pushAudit(run, "APPROVED", actorId, { notes });
  run.updatedBy = actorId;
  await run.save();
  return run;
}

export async function generatePain008ForRun(runId, tenantId, actorId) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["APPROVED", "FILE_GENERATED"], "generate PAIN.008");

  const items = await DirectDebitRunItem.find({
    tenantId,
    runId: run._id,
    status: "INCLUDED",
  });

  if (!items.length) {
    throw AppError.badRequest("No included items to file");
  }

  const collectionDate = run.collectionDate.toISOString().slice(0, 10);
  const tenantCode = run.tenantCode || normalizeTenantCode(null, tenantId);

  const existingMsgId = run.file?.messageId || run.pain008?.msgId;
  let messageId = existingMsgId;
  if (!messageId) {
    const allocated = await allocateMessageId({
      tenantId,
      tenantCode,
      utcTimestamp: new Date(),
    });
    messageId = allocated.messageId;
  }

  const msgErrors = validateSepaReference(messageId, {
    maxLength: SEPA_MAX.MSG_ID,
    fieldName: "messageId",
  });
  if (msgErrors.length) {
    throw AppError.badRequest(msgErrors.join("; "));
  }

  const duplicateMsg = await DirectDebitRun.findOne({
    tenantId,
    "file.messageId": messageId,
    _id: { $ne: run._id },
  }).lean();
  if (duplicateMsg) {
    throw AppError.conflict(`Duplicate PAIN.008 MsgId ${messageId}`);
  }

  const { paymentInformationId } = await allocatePaymentInformationId({
    tenantId,
    tenantCode,
    collectionDate: run.collectionDate,
  });

  const blocks = groupItemsForPain008(
    items.map((i) => i.toObject()),
    run.creditorSnapshot,
    collectionDate,
    { primaryPaymentInformationId: paymentInformationId },
  );

  const creDtTm = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  const built = buildPain008Xml({
    msgId: messageId,
    creDtTm,
    oin: run.creditorSnapshot.oin,
    blocks,
  });

  const fileName = `${run.runNo}-pain008.xml`;
  const blobPath = `direct-debit/${tenantId}/${run.runNo}/${fileName}`;
  let downloadUrl = null;
  try {
    downloadUrl = await azureBlob.uploadToBlob(
      blobPath,
      Buffer.from(built.xml, "utf8"),
      "application/xml",
      fileName,
    );
  } catch {
    /* local dev without Azure */
  }

  for (const block of blocks) {
    for (const tx of block.transactions) {
      await DirectDebitRunItem.updateOne(
        { _id: tx._id, tenantId },
        {
          $set: {
            status: "FILED",
            "pain008.pmtInfId": block.pmtInfId,
            "pain008.blockSeqTp": block.seqTp,
          },
        },
      );
    }
  }

  run.file = {
    messageId: built.msgId,
    paymentInformationId,
  };
  run.pain008 = {
    msgId: built.msgId,
    fileName,
    fileHash: built.fileHash,
    blobPath,
    downloadUrl,
    generatedAt: new Date(),
    generatedBy: actorId,
    pmtInfIds: built.pmtInfIds,
    nbOfTxs: built.nbOfTxs,
    ctrlSum: Number(built.ctrlSum),
  };
  run.status = "FILE_GENERATED";
  pushAudit(run, "FILE_GENERATED", actorId, {
    messageId: built.msgId,
    paymentInformationId,
    fileHash: built.fileHash,
  });
  run.updatedBy = actorId;
  await run.save();

  const allItems = await DirectDebitRunItem.find({ tenantId, runId: run._id }).lean();
  run.totals = computeRunTotals(allItems);
  await run.save();

  return { run, xml: built.xml };
}

export async function markRunSubmitted(runId, tenantId, actorId, { reference, notes } = {}) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["FILE_GENERATED"], "mark submitted");

  await DirectDebitRunItem.updateMany(
    { tenantId, runId: run._id, status: "FILED" },
    { $set: { status: "SUBMITTED" } },
  );

  run.status = "SUBMITTED";
  run.submission = {
    submittedAt: new Date(),
    submittedBy: actorId,
    reference: reference || run.pain008?.msgId,
    notes: notes || "",
  };
  pushAudit(run, "SUBMITTED", actorId, { reference });
  run.updatedBy = actorId;
  await run.save();
  return run;
}

export async function cancelDirectDebitRun(runId, tenantId, actorId, reason) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  if (["SUBMITTED", "PARTIALLY_RECONCILED", "RECONCILED"].includes(run.status)) {
    throw AppError.badRequest("Cannot cancel a submitted or reconciled run");
  }
  run.status = "CANCELLED";
  run.cancelledAt = new Date();
  run.cancelledBy = actorId;
  run.cancelReason = reason || "";
  pushAudit(run, "CANCELLED", actorId, { reason });
  run.updatedBy = actorId;
  await run.save();
  return run;
}

/** Hard-delete a draft run and its items so the same period can be run again. */
export async function deleteDirectDebitRun(runId, tenantId) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["DRAFT"], "delete");
  await DirectDebitRunItem.deleteMany({ tenantId, runId: run._id });
  await DirectDebitRun.deleteOne({ _id: run._id });
  return { deletedRunId: String(run._id), runNo: run.runNo };
}

export async function importPain002ForRun(runId, tenantId, actorId, { xml, fileName, receivedDate }) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  if (!["SUBMITTED", "PARTIALLY_RECONCILED", "FILE_GENERATED"].includes(run.status)) {
    throw AppError.badRequest("Run must be submitted before PAIN.002 import");
  }

  const parsed = parsePain002Xml(xml);
  if (parsed.originalMsgId && run.pain008?.msgId && parsed.originalMsgId !== run.pain008.msgId) {
    throw AppError.badRequest(
      `PAIN.002 OrgnlMsgId ${parsed.originalMsgId} does not match run MsgId ${run.pain008.msgId}`,
    );
  }

  const runPmtInfId =
    run.file?.paymentInformationId || run.pain008?.pmtInfIds?.[0] || null;

  const items = await DirectDebitRunItem.find({
    tenantId,
    runId: run._id,
    status: { $in: ["SUBMITTED", "FILED", "UNPAID", "REJECTED", "PAID"] },
  }).lean();

  const { matches, unmatched, fileRejected, fileRejectCode } = matchPain002ToItems(
    parsed,
    items,
    {
      collectionDate: run.collectionDate,
      receivedDate,
      runPaymentInformationId: runPmtInfId,
    },
  );

  for (const m of matches) {
    await DirectDebitRunItem.updateOne(
      { _id: m.itemId, tenantId },
      {
        $set: {
          status: "REJECTED",
          pain002: {
            reasonCode: m.reasonCode,
            pain002FileRef: fileName || null,
            pain002MsgId: m.pain002MsgId,
            receivedAt: receivedDate ? new Date(receivedDate) : new Date(),
            settlementPhase: m.settlementPhase,
          },
        },
      },
    );

    try {
      await publishDomainEvent(
        "directdebit.collection.unpaid.v1",
        {
          tenantId,
          runId: String(run._id),
          runNo: run.runNo,
          memberId: items.find((i) => String(i._id) === m.itemId)?.memberId,
          endToEndId: m.endToEndId,
          reasonCode: m.reasonCode,
          amountEur: m.amountEur,
        },
        { tenantId, source: "account-service" },
      );
    } catch {
      /* Rabbit optional */
    }
  }

  const refreshed = await DirectDebitRunItem.find({ tenantId, runId: run._id }).lean();
  run.totals = computeRunTotals(refreshed);
  run.reconciliation = {
    lastPain002ImportAt: new Date(),
    lastPain002FileName: fileName || null,
    cumulativeUnpaidEur: run.totals.unpaidAmountEur + run.totals.rejectedAmountEur,
  };

  const submittedCount = refreshed.filter((i) => i.status === "SUBMITTED").length;
  const rejectedCount = refreshed.filter((i) => i.status === "REJECTED" || i.status === "UNPAID").length;
  const filedCount = refreshed.filter((i) => ["FILED", "SUBMITTED", "PAID"].includes(i.status)).length;

  if (fileRejected) {
    run.status = "PARTIALLY_RECONCILED";
    pushAudit(run, "PAIN002_FILE_REJECT", actorId, { fileRejectCode });
  } else if (rejectedCount > 0 && submittedCount > 0) {
    run.status = "PARTIALLY_RECONCILED";
  } else if (rejectedCount > 0 && submittedCount === 0) {
    run.status = "RECONCILED";
  } else if (filedCount > 0 && rejectedCount === 0) {
    run.status = run.status === "FILE_GENERATED" ? "SUBMITTED" : run.status;
  }

  pushAudit(run, "PAIN002_IMPORTED", actorId, {
    matches: matches.length,
    unmatched: unmatched.length,
    fileName,
    messageId: run.file?.messageId || run.pain008?.msgId,
    paymentInformationId: runPmtInfId,
  });
  run.updatedBy = actorId;
  await run.save();

  return { run, matches, unmatched, fileRejected, fileRejectCode };
}

export async function getDirectDebitRun(runId, tenantId) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId }).lean();
  if (!run) throw AppError.notFound("Direct debit run not found");
  return run;
}

export async function listDirectDebitRuns(tenantId, { status, limit = 50, skip = 0 } = {}) {
  const q = { tenantId };
  if (status) q.status = status;
  const [items, total] = await Promise.all([
    DirectDebitRun.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    DirectDebitRun.countDocuments(q),
  ]);
  return { items, total, limit, skip };
}

export async function listDirectDebitRunItems(runId, tenantId, { status, limit = 500, skip = 0 } = {}) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId }).select("_id").lean();
  if (!run) throw AppError.notFound("Direct debit run not found");
  const q = { tenantId, runId: run._id };
  if (status) q.status = status;
  const [items, total] = await Promise.all([
    DirectDebitRunItem.find(q).sort({ memberId: 1 }).skip(skip).limit(limit).lean(),
    DirectDebitRunItem.countDocuments(q),
  ]);
  return { items, total, limit, skip };
}
