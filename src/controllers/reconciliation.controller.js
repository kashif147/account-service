import { asyncHandler } from "../helpers/asyncHandler.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import {
  listReconciliationRecords,
  seedReconciliationFromPendingGl,
  importBankReconciliationLines,
  runAutoMatchReconciliation,
  manualMatchReconciliation,
  moveToSuspense,
  markReconciliationSettled,
  getReconciliationDashboard,
} from "../services/reconciliation.service.js";

export const reconciliationDashboardHandler = asyncHandler(async (req, res) => {
  const dashboard = await getReconciliationDashboard({
    tenantId: requireTenantId(req),
  });
  res.success(dashboard);
});

export const listReconciliationHandler = asyncHandler(async (req, res) => {
  const { clearingAccountCode, reconciliationStatus, limit, skip } = req.query;
  const result = await listReconciliationRecords({
    tenantId: requireTenantId(req),
    clearingAccountCode,
    reconciliationStatus,
    limit: limit ? parseInt(limit, 10) : 100,
    skip: skip ? parseInt(skip, 10) : 0,
  });
  res.success(result);
});

export const seedReconciliationHandler = asyncHandler(async (req, res) => {
  const { clearingAccountCode } = req.body;
  const result = await seedReconciliationFromPendingGl({
    tenantId: requireTenantId(req),
    clearingAccountCode,
    createdBy: req.ctx?.userId,
  });
  res.created(result);
});

export const importBankReconciliationHandler = asyncHandler(async (req, res) => {
  const { clearingAccountCode, batchReference, lines } = req.body;
  const result = await importBankReconciliationLines({
    tenantId: requireTenantId(req),
    clearingAccountCode,
    batchReference,
    lines,
    createdBy: req.ctx?.userId,
  });
  res.created(result);
});

export const autoMatchReconciliationHandler = asyncHandler(async (req, res) => {
  const { clearingAccountCode, apply } = req.body;
  const result = await runAutoMatchReconciliation({
    tenantId: requireTenantId(req),
    clearingAccountCode,
    matchedBy: req.ctx?.userId,
    apply: apply !== false,
  });
  res.success(result);
});

export const manualMatchHandler = asyncHandler(async (req, res) => {
  const { recordId, matchedGlDocNo } = req.body;
  const rec = await manualMatchReconciliation({
    recordId,
    matchedGlDocNo,
    matchedBy: req.ctx?.userId,
    tenantId: requireTenantId(req),
  });
  res.success(rec);
});

export const suspenseHandler = asyncHandler(async (req, res) => {
  const { recordId, suspenseReason } = req.body;
  const rec = await moveToSuspense({
    recordId,
    suspenseReason,
    matchedBy: req.ctx?.userId,
    tenantId: requireTenantId(req),
  });
  res.success(rec);
});

export const settleReconciliationHandler = asyncHandler(async (req, res) => {
  const rec = await markReconciliationSettled({
    recordId: req.params.recordId,
    tenantId: requireTenantId(req),
    actorId: req.ctx?.userId,
  });
  res.success(rec);
});
