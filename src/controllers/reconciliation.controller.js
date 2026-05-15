import { asyncHandler } from "../helpers/asyncHandler.js";
import {
  listReconciliationRecords,
  seedReconciliationFromPendingGl,
  manualMatchReconciliation,
  moveToSuspense,
  markReconciliationSettled,
} from "../services/reconciliation.service.js";

export const listReconciliationHandler = asyncHandler(async (req, res) => {
  const { clearingAccountCode, reconciliationStatus, limit, skip } = req.query;
  const result = await listReconciliationRecords({
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
    clearingAccountCode,
    createdBy: req.ctx?.userId,
  });
  res.created(result);
});

export const manualMatchHandler = asyncHandler(async (req, res) => {
  const { recordId, matchedGlDocNo } = req.body;
  const rec = await manualMatchReconciliation({
    recordId,
    matchedGlDocNo,
    matchedBy: req.ctx?.userId,
  });
  res.success(rec);
});

export const suspenseHandler = asyncHandler(async (req, res) => {
  const { recordId, suspenseReason } = req.body;
  const rec = await moveToSuspense({
    recordId,
    suspenseReason,
    matchedBy: req.ctx?.userId,
  });
  res.success(rec);
});

export const settleReconciliationHandler = asyncHandler(async (req, res) => {
  const rec = await markReconciliationSettled({
    recordId: req.params.recordId,
  });
  res.success(rec);
});
