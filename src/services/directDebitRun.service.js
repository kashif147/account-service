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
  buildPain008Xml,
  groupItemsForPain008,
  validatePain008Inputs,
} from "./pain008.service.js";
import { matchPain002ToItems, parsePain002Xml } from "./pain002.service.js";
import { publishDomainEvent } from "../rabbitMQ/index.js";

function pushAudit(run, action, actorId, details = {}) {
  run.auditTrail = run.auditTrail || [];
  run.auditTrail.push({
    at: new Date(),
    action,
    actorId: actorId || null,
    details,
  });
}

async function nextRunNo(tenantId) {
  const year = new Date().getFullYear();
  const prefix = `DD-${year}-`;
  const last = await DirectDebitRun.findOne({
    tenantId,
    runNo: new RegExp(`^${prefix}`),
  })
    .sort({ runNo: -1 })
    .select("runNo")
    .lean();
  let seq = 1;
  if (last?.runNo) {
    const part = parseInt(String(last.runNo).split("-").pop(), 10);
    if (Number.isFinite(part)) seq = part + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
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

  const runNo = await nextRunNo(tenantId);
  const run = await DirectDebitRun.create({
    tenantId,
    runNo,
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
        details: { runNo, runType },
      },
    ],
  });
  return run;
}

export async function prepareDirectDebitRun(runId, tenantId, actorId) {
  const run = await DirectDebitRun.findOne({ _id: runId, tenantId });
  if (!run) throw AppError.notFound("Direct debit run not found");
  assertStatus(run, ["DRAFT", "VALIDATED"], "prepare");

  await DirectDebitRunItem.deleteMany({ tenantId, runId: run._id });

  const { included, excluded } = await buildEligibilityItems({
    tenantId,
    run,
    actorId,
  });

  const docs = [
    ...included,
    ...excluded.map((e) => ({
      tenantId,
      runId: run._id,
      memberId: e.memberId || "UNKNOWN",
      profileId: e.profileId,
      subscriptionId: e.subscriptionId,
      amountEur: 0,
      currency: "EUR",
      endToEndId: `EXC-${String(e.profileId).slice(-8)}-${run.runNo}`.slice(0, 35),
      status: "EXCLUDED",
      exclusionReason: e.exclusionReason,
      memberSnapshot: {},
      mandateSnapshot: {},
      collectionPeriod: {
        startDate: run.periodStartDate,
        endDate: run.periodEndDate,
      },
    })),
  ];

  if (docs.length) {
    await DirectDebitRunItem.insertMany(docs, { ordered: false });
  }

  const items = await DirectDebitRunItem.find({ tenantId, runId: run._id }).lean();
  run.totals = computeRunTotals(items);
  run.status = "DRAFT";
  run.validationSummary = { isValid: false, errors: [], warnings: [] };
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
  run.status = errors.length === 0 ? "VALIDATED" : "DRAFT";
  pushAudit(run, "VALIDATED", actorId, {
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
  const blocks = groupItemsForPain008(
    items.map((i) => i.toObject()),
    run.creditorSnapshot,
    collectionDate,
  );

  const msgId = `SDD-${run.runNo}-${Date.now()}`.replace(/\s+/g, "");
  const creDtTm = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  const built = buildPain008Xml({
    msgId,
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
    msgId: built.msgId,
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

  const items = await DirectDebitRunItem.find({
    tenantId,
    runId: run._id,
    status: { $in: ["SUBMITTED", "FILED", "UNPAID", "REJECTED", "PAID"] },
  }).lean();

  const { matches, unmatched, fileRejected, fileRejectCode } = matchPain002ToItems(
    parsed,
    items,
    { collectionDate: run.collectionDate, receivedDate },
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
