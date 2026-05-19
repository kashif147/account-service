import GL from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";
import { buildMemberApplyCreditEntries } from "../helpers/paymentReceiptAllocation.js";

/**
 * Apply available member credit (2020) against outstanding AR (1400).
 */
export async function applyMemberCreditToInvoices({
  date,
  docNo,
  memberId,
  amount,
  userId,
  memo,
}) {
  const mid = String(memberId || "").trim();
  const cents = Math.round(Number(amount));
  if (!mid) throw AppError.badRequest("memberId is required");
  if (!Number.isInteger(cents) || cents <= 0) {
    throw AppError.badRequest("amount must be a positive integer (cents)");
  }

  const lines = await buildMemberApplyCreditEntries(mid, cents, date);
  if (!lines.length) {
    throw AppError.badRequest(
      "No credit to apply or no outstanding balance on accounts receivable",
    );
  }

  const applied = lines
    .filter((l) => l.accountCode === "1400" && l.dc === "C")
    .reduce((s, l) => s + (Number(l.amount) || 0), 0);

  const existing = await GL.findOne({ docNo }).lean();
  if (existing) {
    throw AppError.conflict(`Document ${docNo} already exists`);
  }

  const out = await postBalancedJournal({
    date,
    userId,
    docType: "Adjustment",
    docNo,
    memo: memo || `Apply member credit (${mid})`,
    lines,
    adjSubType: "apply-member-credit",
  });

  return { ...out, appliedAmount: applied };
}

/**
 * Reverse a member Receipt by posting offsetting GL lines.
 */
export async function reverseMemberReceipt({
  receiptDocNo,
  reversalDocNo,
  memberId,
  userId,
  memo,
}) {
  const docNo = String(receiptDocNo || "").trim();
  const revNo = String(reversalDocNo || "").trim();
  const mid = String(memberId || "").trim();
  if (!docNo || !revNo) {
    throw AppError.badRequest("receiptDocNo and reversalDocNo are required");
  }
  if (!mid) throw AppError.badRequest("memberId is required");

  const original = await GL.findOne({ docNo, docType: "Receipt" }).lean();
  if (!original) {
    throw AppError.notFound(`Receipt ${docNo} not found`);
  }

  const memberTouched = (original.entries || []).some(
    (e) => String(e.memberId || "").trim() === mid,
  );
  if (!memberTouched) {
    throw AppError.badRequest("Receipt does not belong to this member");
  }

  const priorRev = await GL.findOne({
    docNo: revNo,
  }).lean();
  if (priorRev) {
    throw AppError.conflict(`Reversal document ${revNo} already exists`);
  }

  const alreadyReversed = await GL.findOne({
    memo: { $regex: `Reverse receipt ${docNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` },
  }).lean();
  if (alreadyReversed) {
    throw AppError.conflict(`Receipt ${docNo} was already reversed`);
  }

  const lines = (original.entries || []).map((e) => ({
    accountCode: e.accountCode,
    dc: e.dc === "D" ? "C" : "D",
    amount: e.amount,
    memberId: e.memberId,
    applicationId: e.applicationId,
    periodBucket: e.periodBucket,
    categoryName: e.categoryName,
    revenueSubType: e.revenueSubType,
    adjSubType: e.adjSubType,
  }));

  if (!lines.length) {
    throw AppError.badRequest("Receipt has no lines to reverse");
  }

  const out = await postBalancedJournal({
    date: new Date(),
    userId,
    docType: "Adjustment",
    docNo: revNo,
    memo: memo || `Reverse receipt ${docNo}`,
    lines,
    adjSubType: "receipt-reversal",
  });

  return out;
}

/**
 * Reverse a posted WriteOff by posting offsetting GL lines.
 */
function buildWriteOffReversalMemo(docNo, { memo, recoveryNote } = {}) {
  const base = memo?.trim() || `Reverse write-off ${docNo}`;
  const recovery = String(recoveryNote || "").trim();
  if (!recovery) return base;
  return `${base} — Recovery: ${recovery}`;
}

export async function reverseMemberWriteOff({
  writeOffDocNo,
  reversalDocNo,
  memberId,
  userId,
  memo,
  recoveryNote,
}) {
  const docNo = String(writeOffDocNo || "").trim();
  const revNo = String(reversalDocNo || "").trim();
  const mid = String(memberId || "").trim();
  if (!docNo || !revNo) {
    throw AppError.badRequest("writeOffDocNo and reversalDocNo are required");
  }
  if (!mid) throw AppError.badRequest("memberId is required");

  const original = await GL.findOne({ docNo, docType: "WriteOff" }).lean();
  if (!original) {
    throw AppError.notFound(`Write-off ${docNo} not found`);
  }

  const memberTouched = (original.entries || []).some(
    (e) => String(e.memberId || "").trim() === mid,
  );
  if (!memberTouched) {
    throw AppError.badRequest("Write-off does not belong to this member");
  }

  const priorRev = await GL.findOne({ docNo: revNo }).lean();
  if (priorRev) {
    throw AppError.conflict(`Reversal document ${revNo} already exists`);
  }

  const alreadyReversed = await GL.findOne({
    memo: {
      $regex: `Reverse write-off ${docNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    },
  }).lean();
  if (alreadyReversed) {
    throw AppError.conflict(`Write-off ${docNo} was already reversed`);
  }

  const lines = (original.entries || []).map((e) => ({
    accountCode: e.accountCode,
    dc: e.dc === "D" ? "C" : "D",
    amount: e.amount,
    memberId: e.memberId,
    applicationId: e.applicationId,
    periodBucket: e.periodBucket,
    categoryName: e.categoryName,
    revenueSubType: e.revenueSubType,
    adjSubType: e.adjSubType,
  }));

  if (!lines.length) {
    throw AppError.badRequest("Write-off has no lines to reverse");
  }

  return postBalancedJournal({
    date: new Date(),
    userId,
    docType: "Adjustment",
    docNo: revNo,
    memo: buildWriteOffReversalMemo(docNo, { memo, recoveryNote }),
    lines,
    adjSubType: "writeoff-reversal",
  });
}
