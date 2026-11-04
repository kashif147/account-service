import { asyncHandler } from "../helpers/asyncHandler.js";
import * as ddRunService from "../services/directDebitRun.service.js";
import * as azureBlob from "../services/azure.blob.service.js";
import { captureForwardHeaders } from "../services/directDebitUpstream.client.js";
import {
  canReadBankData,
  runForCaller,
  runItemForCaller,
} from "../helpers/bankDataAccess.js";

// PDP P3 (Q2, owner item O5 = mask): every response that echoes a run or its items goes through
// runForCaller / runItemForCaller. Plaintext creditor / debtor bank details and the PAIN.008 XML only for a
// caller holding payments.bank:read (helpers/bankDataAccess.js); the download route is gated in the router.
const runOut = (req, run) => runForCaller(run, canReadBankData(req));

function tenantId(req) {
  return req.ctx?.tenantId ?? req.tenantId ?? req.user?.tenantId;
}

function actorId(req) {
  return req.ctx?.userId ?? req.user?.id ?? req.user?.userId ?? "unknown";
}

export const createRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.createDirectDebitRun({
    tenantId: tenantId(req),
    runType: req.body.runType,
    periodStartDate: req.body.periodStartDate,
    periodEndDate: req.body.periodEndDate,
    collectionDate: req.body.collectionDate,
    submissionDueDate: req.body.submissionDueDate,
    creditorSnapshot: req.body.creditorSnapshot || {},
    createdBy: actorId(req),
    req,
  });
  res.created({ run: runOut(req, run) });
});

export const prepareRun = asyncHandler(async (req, res) => {
  const forwardHeaders = captureForwardHeaders(req);
  const run = await ddRunService.queuePrepareJob(
    req.params.id,
    tenantId(req),
    actorId(req),
    forwardHeaders,
  );
  res.status(202).json({
    status: "success",
    message: "Prepare job queued",
    data: {
      run: runOut(req, run),
      prepareJob: run.prepareJob,
    },
    timestamp: new Date().toISOString(),
  });
});

export const getPrepareStatus = asyncHandler(async (req, res) => {
  const run = await ddRunService.getDirectDebitRun(
    req.params.id,
    tenantId(req),
  );
  res.success({
    runId: String(run._id),
    runNo: run.runNo,
    status: run.status,
    prepareJob: run.prepareJob || { status: "idle" },
    totals: run.totals,
  });
});

export const validateRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.validateDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
  );
  res.success({ run: runOut(req, run) });
});

export const approveRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.approveDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body.notes,
  );
  res.success({ run: runOut(req, run) });
});

export const generatePain008 = asyncHandler(async (req, res) => {
  const { run, xml } = await ddRunService.generatePain008ForRun(
    req.params.id,
    tenantId(req),
    actorId(req),
  );
  // The raw PAIN.008 XML carries every debtor IBAN: echoed only with the bank-data permission.
  const allowed = canReadBankData(req);
  res.success({
    run: runForCaller(run, allowed),
    xml: allowed && req.query.includeXml === "1" ? xml : undefined,
  });
});

export const markSubmitted = asyncHandler(async (req, res) => {
  const run = await ddRunService.markRunSubmitted(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body,
  );
  res.success({ run: runOut(req, run) });
});

export const cancelRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.cancelDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body.reason,
  );
  res.success({ run: runOut(req, run) });
});

export const deleteRun = asyncHandler(async (req, res) => {
  const result = await ddRunService.deleteDirectDebitRun(
    req.params.id,
    tenantId(req),
  );
  res.success(result);
});

export const importPain002 = asyncHandler(async (req, res) => {
  const result = await ddRunService.importPain002ForRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body,
  );
  res.success({ ...result, run: runOut(req, result.run) });
});

export const listRuns = asyncHandler(async (req, res) => {
  const result = await ddRunService.listDirectDebitRuns(tenantId(req), {
    status: req.query.status,
    limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });
  const allowed = canReadBankData(req);
  res.success({ ...result, items: result.items.map((r) => runForCaller(r, allowed)) });
});

export const getRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.getDirectDebitRun(
    req.params.id,
    tenantId(req),
  );
  res.success({ run: runOut(req, run) });
});

export const listItems = asyncHandler(async (req, res) => {
  const result = await ddRunService.listDirectDebitRunItems(
    req.params.id,
    tenantId(req),
    {
      status: req.query.status,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 500,
      skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
    },
  );
  const allowed = canReadBankData(req);
  res.success({ ...result, items: result.items.map((i) => runItemForCaller(i, allowed)) });
});

export const downloadPain008 = asyncHandler(async (req, res) => {
  const run = await ddRunService.getDirectDebitRun(
    req.params.id,
    tenantId(req),
  );
  if (!run.pain008?.blobPath) {
    return res.status(404).json({ message: "No generated file" });
  }
  const buf = await azureBlob.downloadBlobToBuffer(run.pain008.blobPath);
  res.setHeader("Content-Type", "application/xml");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${run.pain008.fileName || "pain008.xml"}"`,
  );
  res.send(buf);
});
