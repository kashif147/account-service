const CLEARING_PAYMENT_METHOD = {
  "1210": "cheque",
  "1220": "online_payment",
  "1230": "cash_or_salary_deduction",
  "1240": "standing_order",
  "1250": "direct_debit",
};

const BATCH_TYPE_PAYMENT_METHOD = {
  deduction: "salary_deduction",
  "salary deduction": "salary_deduction",
  "salary deductions": "salary_deduction",
  "standing order": "standing_order",
  "standing-order": "standing_order",
  cash: "cash",
  cheque: "cheque",
  "direct debit": "direct_debit",
};

/**
 * Infer payment rail from clearing account on receipt lines.
 * @param {object[]} lines
 */
export function inferPaymentMethodFromLines(lines = []) {
  for (const line of lines) {
    const code = String(line?.accountCode || "").trim();
    if (CLEARING_PAYMENT_METHOD[code] && line?.dc === "D") {
      return CLEARING_PAYMENT_METHOD[code];
    }
  }
  return null;
}

/**
 * Map batch import type to payment method label.
 * @param {string} batchType
 */
export function paymentMethodFromBatchType(batchType) {
  const key = String(batchType || "").trim().toLowerCase();
  return BATCH_TYPE_PAYMENT_METHOD[key] || "batch_import";
}

/**
 * Resolve audit action for a GL journal post.
 * @param {object} params
 */
export function resolveJournalAuditAction({
  docType,
  operation,
  paymentMethod,
  adjSubType,
  settlement,
}) {
  const op = String(operation || "").trim().toLowerCase();
  const adj = String(adjSubType || "").trim().toLowerCase();

  if (op === "reverse_receipt" || op === "reverse-receipt") return "RECEIPT_REVERSED";
  if (op === "reverse_claim" || op === "reverse-claim") return "CLAIM_REVERSED";
  if (op === "payment_reassignment" || op === "reassign_payment") {
    return "PAYMENT_REASSIGNED";
  }
  if (op === "apply_member_credit" || op === "apply-member-credit") {
    return "MEMBER_CREDIT_APPLIED";
  }
  if (op === "batch_payment") return "BATCH_RECEIPT_POSTED";
  if (op === "credit_note_approve") return "CREDIT_NOTE_APPROVED";
  if (op === "journal_adjustment_approve") return "JOURNAL_ADJUSTMENT_APPROVED";

  if (adj.includes("fee-increase")) return "FEE_INCREASE_POSTED";
  if (adj.includes("fee-decrease")) return "FEE_DECREASE_POSTED";
  if (adj === "prorata" || adj.includes("prorata")) return "FEE_ADJUSTMENT_POSTED";
  if (adj === "writeoff" || adj.includes("writeoff")) return "WRITE_OFF_POSTED";
  if (adj === "credit-note") return "CREDIT_NOTE_POSTED";

  const provider = String(settlement?.provider || "").toLowerCase();
  if (provider === "stripe") return "ONLINE_PAYMENT_RECEIPT_POSTED";

  const dt = String(docType || "").trim();
  switch (dt) {
    case "Receipt": {
      if (paymentMethod === "online_payment") return "ONLINE_PAYMENT_RECEIPT_POSTED";
      if (paymentMethod === "cheque") return "CHEQUE_RECEIPT_POSTED";
      if (paymentMethod === "cash_or_salary_deduction") return "CASH_RECEIPT_POSTED";
      if (paymentMethod === "salary_deduction") return "SALARY_DEDUCTION_RECEIPT_POSTED";
      if (paymentMethod === "standing_order") return "STANDING_ORDER_RECEIPT_POSTED";
      if (paymentMethod === "direct_debit") return "DIRECT_DEBIT_RECEIPT_POSTED";
      return "RECEIPT_POSTED";
    }
    case "Invoice":
      return "INVOICE_POSTED";
    case "CreditNote":
      return "CREDIT_NOTE_POSTED";
    case "Claim":
      return "CLAIM_POSTED";
    case "Refund":
      return "REFUND_POSTED";
    case "WriteOff":
      return "WRITE_OFF_POSTED";
    case "Adjustment":
      return "ADJUSTMENT_POSTED";
    case "Settlement":
      return "SETTLEMENT_POSTED";
    default:
      return "JOURNAL_POSTED";
  }
}

/**
 * Build a compact after-state snapshot for finance audit rows.
 */
export function buildFinanceAuditSnapshot({
  docNo,
  docType,
  date,
  reference,
  memo,
  memberId,
  profileId,
  paymentMethod,
  operation,
  totalDebit,
  totalCredit,
  settlement,
  batchType,
  batchName,
  batchDetailId,
  glDocNo,
  invoiceDocNo,
  amountCents,
  reason,
  status,
  extra = {},
}) {
  const snap = {
    ...(docNo != null ? { docNo: String(docNo) } : {}),
    ...(docType != null ? { docType: String(docType) } : {}),
    ...(date != null ? { date } : {}),
    ...(reference != null && String(reference).trim()
      ? { reference: String(reference).trim() }
      : {}),
    ...(memo != null && String(memo).trim() ? { memo: String(memo).trim() } : {}),
    ...(memberId != null && String(memberId).trim()
      ? { memberId: String(memberId).trim() }
      : {}),
    ...(profileId != null && String(profileId).trim()
      ? { profileId: String(profileId).trim() }
      : {}),
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(operation ? { operation } : {}),
    ...(totalDebit != null ? { totalDebit } : {}),
    ...(totalCredit != null ? { totalCredit } : {}),
    ...(settlement ? { settlement } : {}),
    ...(batchType ? { batchType } : {}),
    ...(batchName ? { batchName } : {}),
    ...(batchDetailId ? { batchDetailId: String(batchDetailId) } : {}),
    ...(glDocNo ? { glDocNo: String(glDocNo) } : {}),
    ...(invoiceDocNo ? { invoiceDocNo: String(invoiceDocNo) } : {}),
    ...(amountCents != null ? { amountCents } : {}),
    ...(reason ? { reason: String(reason) } : {}),
    ...(status ? { status: String(status) } : {}),
    ...extra,
  };
  return snap;
}
