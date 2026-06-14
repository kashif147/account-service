import { asyncHandler } from "../helpers/asyncHandler.js";
import {
  createCreditNoteDraft,
  approveCreditNote,
  cancelCreditNote,
  getCreditNote,
  listCreditNotes,
} from "../services/creditNote.service.js";

export const createCreditNote = asyncHandler(async (req, res) => {
  const {
    docNo,
    memberId,
    invoiceDocNo,
    amount,
    periodBucket,
    reason,
    notes,
    date,
  } = req.body;

  const cents = Math.round(Number(amount));
  const result = await createCreditNoteDraft({
    docNo,
    memberId,
    invoiceDocNo,
    amount: cents,
    periodBucket,
    reason,
    notes,
    effectiveDate: date,
    createdBy: req.ctx?.userId,
    tenantId: req.ctx?.tenantId ?? req.tenantId,
    profileId: req.body?.profileId,
  });

  res.created({
    ...result.creditNote,
    message: "Credit note saved as Draft; approve to post GL",
  });
});

export const approveCreditNoteHandler = asyncHandler(async (req, res) => {
  const { docNo } = req.params;
  const result = await approveCreditNote({
    docNo,
    approvedBy: req.ctx?.userId,
    userId: req.ctx?.userId,
    tenantId: req.ctx?.tenantId ?? req.tenantId,
    profileId: req.body?.profileId,
  });
  res.success(result);
});

export const cancelCreditNoteHandler = asyncHandler(async (req, res) => {
  const { docNo } = req.params;
  const cn = await cancelCreditNote({
    docNo,
    cancelledBy: req.ctx?.userId,
    tenantId: req.ctx?.tenantId ?? req.tenantId,
    profileId: req.body?.profileId,
  });
  res.success(cn);
});

export const getCreditNoteHandler = asyncHandler(async (req, res) => {
  const cn = await getCreditNote(req.params.docNo);
  res.success(cn);
});

export const listCreditNotesHandler = asyncHandler(async (req, res) => {
  const { memberId, status, limit, skip } = req.query;
  const result = await listCreditNotes({
    memberId,
    status,
    limit: limit ? parseInt(limit, 10) : 50,
    skip: skip ? parseInt(skip, 10) : 0,
  });
  res.success(result);
});
