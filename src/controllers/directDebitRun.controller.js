import { asyncHandler } from "../helpers/asyncHandler.js";
import * as ddRunService from "../services/directDebitRun.service.js";
import * as azureBlob from "../services/azure.blob.service.js";

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
  res.created({ run });
});

export const prepareRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.prepareDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req,
  );
  res.success({ run });
});

export const validateRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.validateDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
  );
  res.success({ run });
});

export const approveRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.approveDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body.notes,
  );
  res.success({ run });
});

export const generatePain008 = asyncHandler(async (req, res) => {
  const { run, xml } = await ddRunService.generatePain008ForRun(
    req.params.id,
    tenantId(req),
    actorId(req),
  );
  res.success({ run, xml: req.query.includeXml === "1" ? xml : undefined });
});

export const markSubmitted = asyncHandler(async (req, res) => {
  const run = await ddRunService.markRunSubmitted(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body,
  );
  res.success({ run });
});

export const cancelRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.cancelDirectDebitRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body.reason,
  );
  res.success({ run });
});

export const importPain002 = asyncHandler(async (req, res) => {
  const result = await ddRunService.importPain002ForRun(
    req.params.id,
    tenantId(req),
    actorId(req),
    req.body,
  );
  res.success(result);
});

export const listRuns = asyncHandler(async (req, res) => {
  const result = await ddRunService.listDirectDebitRuns(tenantId(req), {
    status: req.query.status,
    limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });
  res.success(result);
});

export const getRun = asyncHandler(async (req, res) => {
  const run = await ddRunService.getDirectDebitRun(
    req.params.id,
    tenantId(req),
  );
  res.success({ run });
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
  res.success(result);
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
