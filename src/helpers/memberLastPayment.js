import { resolveTxTypeAccountCode } from "./glTransactionTxType.js";

/** Legacy Receipt rows that mirror app-credit → member (Claim doc covers them). */
export function isLegacyClaimTransferReceipt(txn) {
  if (!txn || txn.docType !== "Receipt") return false;
  const memo = String(txn.memo || "");
  const docNo = String(txn.docNo || "");
  return memo.startsWith("Claim app credit") || /^CLAIM-/i.test(docNo);
}

export function isApplicationCreditClaimReceipt(txn) {
  if (!txn) return false;
  if (txn.docType === "Claim") return true;
  return isLegacyClaimTransferReceipt(txn);
}

/**
 * Member-facing payment amount on a Receipt/Claim: credits to 1400 (invoice) and/or 2020 (advance).
 */
export function memberPaymentCreditCents(memberId, txn) {
  const mid = String(memberId || "").trim();
  if (!mid || !txn?.entries) return 0;
  let total = 0;
  for (const e of txn.entries) {
    if (String(e.memberId || "").trim() !== mid) continue;
    if (e.dc !== "C") continue;
    if (e.accountCode === "1400" || e.accountCode === "2020") {
      total += Number(e.amount) || 0;
    }
  }
  return total;
}

/**
 * Cash Receipt (clearing leg) or Claim — excludes legacy claim-styled Receipt duplicates.
 */
export function isEligibleMemberPaymentTxn(txn) {
  if (!txn) return false;
  const dt = txn.docType;
  if (dt === "Claim") return true;
  if (dt !== "Receipt") return false;
  if (isLegacyClaimTransferReceipt(txn)) return false;
  return Boolean(resolveTxTypeAccountCode(txn));
}

/**
 * Latest Receipt/Claim for the member (txns pre-sorted date desc, createdAt desc).
 */
export function pickLastMemberPayment(memberId, txns) {
  const mid = String(memberId || "").trim();
  if (!mid || !Array.isArray(txns)) return null;
  for (const txn of txns) {
    if (!isEligibleMemberPaymentTxn(txn)) continue;
    if (memberPaymentCreditCents(mid, txn) <= 0) continue;
    return txn;
  }
  return null;
}

export function buildMemberLastPayment(memberId, txn) {
  if (!txn) return null;
  const amount = memberPaymentCreditCents(memberId, txn);
  if (amount <= 0) return null;
  return {
    docNo: txn.docNo,
    docType: txn.docType,
    date: txn.date,
    amount,
    displayLabel: isApplicationCreditClaimReceipt(txn)
      ? "Claim"
      : txn.memo || "Payment",
  };
}
