import { asyncHandler } from "../helpers/asyncHandler.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import {
  createJournalAdjustmentDraft,
  approveJournalAdjustment,
  listJournalAdjustments,
} from "../services/journalAdjustment.service.js";

export const createJournalAdjustment = asyncHandler(async (req, res) => {
  const {
    docNo,
    debitAccount,
    creditAccount,
    amount,
    memberId,
    memberName,
    memberProfileId,
    reason,
    notes,
    financialPeriod,
    date,
  } = req.body;

  const adj = await createJournalAdjustmentDraft({
    docNo,
    debitAccount,
    creditAccount,
    amount: Math.round(Number(amount)),
    memberId,
    memberName,
    memberProfileId,
    reason,
    notes,
    financialPeriod,
    effectiveDate: date,
    createdBy: req.ctx?.userId,
    tenantId: requireTenantId(req),
  });

  res.created({
    ...adj,
    message: "Journal adjustment saved as Draft; approve to post GL",
  });
});

export const approveJournalAdjustmentHandler = asyncHandler(async (req, res) => {
  const result = await approveJournalAdjustment({
    docNo: req.params.docNo,
    approvedBy: req.ctx?.userId,
    userId: req.ctx?.userId,
    tenantId: requireTenantId(req),
  });
  res.success(result);
});

export const listJournalAdjustmentsHandler = asyncHandler(async (req, res) => {
  const { limit, skip } = req.query;
  const result = await listJournalAdjustments({
    tenantId: requireTenantId(req),
    limit: limit ? parseInt(limit, 10) : 50,
    skip: skip ? parseInt(skip, 10) : 0,
  });
  res.success(result);
});
