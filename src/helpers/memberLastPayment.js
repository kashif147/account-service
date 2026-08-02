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
 * @param {string} memberId
 * @param {object} txn
 * @param {Set<string>} [rawProfileIds] - optional set of raw profile-service ids this identity
 *   also resolves to; when supplied, entries carrying only `profileId` (events/courses postings
 *   for an attendee with no membershipNumber) are matched too, not just `entries.memberId`.
 */
export function memberPaymentCreditCents(memberId, txn, rawProfileIds) {
  const mid = String(memberId || "").trim();
  if (!mid || !txn?.entries) return 0;
  let total = 0;
  for (const e of txn.entries) {
    const matchesMember = String(e.memberId || "").trim() === mid;
    const matchesProfile =
      rawProfileIds && e.profileId && rawProfileIds.has(String(e.profileId));
    if (!matchesMember && !matchesProfile) continue;
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
 * @param {Set<string>} [rawProfileIds] - see memberPaymentCreditCents
 */
export function pickLastMemberPayment(memberId, txns, rawProfileIds) {
  const mid = String(memberId || "").trim();
  if (!mid || !Array.isArray(txns)) return null;
  for (const txn of txns) {
    if (!isEligibleMemberPaymentTxn(txn)) continue;
    if (memberPaymentCreditCents(mid, txn, rawProfileIds) <= 0) continue;
    return txn;
  }
  return null;
}

export function buildMemberLastPayment(memberId, txn, rawProfileIds) {
  if (!txn) return null;
  const amount = memberPaymentCreditCents(memberId, txn, rawProfileIds);
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
