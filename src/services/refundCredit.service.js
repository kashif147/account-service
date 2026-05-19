import MaterializedBalance from "../models/materializedBalance.model.js";
import GL from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";

const BUCKETS = ["arrears", "current", "advance"];

/**
 * Resolve MaterializedBalance memberId field (same convention as journal rollupMemberBalances).
 * When both memberId and applicationId are present (e.g. after approval / claim moved credit to member),
 * prefer memberId so refund credit checks match 2020 balances under the member key.
 * @param {import("mongoose").Document|object} payment
 * @returns {{ key: string, memberId: string|null, applicationId: string|null }|null}
 */
export function matBalMemberKeyFromPayment(payment) {
  let metadataObj = {};
  if (payment.metadata) {
    if (payment.metadata instanceof Map) {
      metadataObj = Object.fromEntries(payment.metadata);
    } else if (typeof payment.metadata === "object") {
      metadataObj = payment.metadata;
    }
  }
  const memberId =
    payment.memberId ||
    metadataObj.memberId ||
    metadataObj.member_id ||
    null;
  const applicationId =
    payment.applicationId ||
    metadataObj.applicationId ||
    metadataObj.application_id ||
    null;
  if (memberId) {
    return { key: memberId, memberId, applicationId: null };
  }
  if (applicationId) {
    return { key: `app:${applicationId}`, memberId: null, applicationId };
  }
  return null;
}

/** 2020 credit leg on a CLAIM-{applicationId} journal (member receiving app credit). */
function memberIdFromClaimJournal(txn) {
  if (!txn?.entries?.length) return null;
  for (const e of txn.entries) {
    if (e.accountCode !== "2020" || e.dc !== "C" || !e.memberId) continue;
    const mid = String(e.memberId).trim();
    if (mid && !mid.toLowerCase().startsWith("app:")) return mid;
  }
  return null;
}

/**
 * After approval, app credit is moved to this member via CLAIM-{applicationId} GL.
 * Used for refund credit checks and refund 2020 targeting when Payment still only has applicationId.
 */
export async function getClaimRecipientMemberIdForApplication(applicationId) {
  if (!applicationId) return null;
  const claimTxn = await GL.findOne({ docNo: `CLAIM-${applicationId}` })
    .select({ claimMemberId: 1, entries: 1 })
    .lean();
  if (claimTxn?.claimMemberId) {
    const mid = String(claimTxn.claimMemberId).trim();
    if (mid && !mid.toLowerCase().startsWith("app:")) return mid;
  }
  return memberIdFromClaimJournal(claimTxn);
}

function metadataObject(payment) {
  if (!payment.metadata) return {};
  if (payment.metadata instanceof Map) {
    return Object.fromEntries(payment.metadata);
  }
  if (typeof payment.metadata === "object") {
    return payment.metadata;
  }
  return {};
}

/**
 * Application id for correlating with CLAIM-* GL, even when matBal key prefers memberId.
 */
function applicationIdForClaimLookup(payment, resolved) {
  if (resolved?.applicationId) return resolved.applicationId;
  if (resolved?.key?.startsWith("app:")) return resolved.key.slice(4);
  const meta = metadataObject(payment);
  return (
    payment.applicationId ||
    meta.applicationId ||
    meta.application_id ||
    null
  );
}

/**
 * Available credit on 2020 for the journal year (cents). MatBal: amount &lt; 0 means credit.
 * @param {string} memberKey - memberId or `app:${applicationId}`
 * @param {number} year - calendar year
 * @returns {Promise<number>}
 */
export async function getAvailableCredit2020ForKey(memberKey, year) {
  const rows = await MaterializedBalance.find({
    memberId: memberKey,
    accountCode: "2020",
    year,
    bucket: { $in: BUCKETS },
  }).lean();
  const sum = rows.reduce((s, r) => s + r.amount, 0);
  if (sum < 0) return -sum;
  return 0;
}

/**
 * Member credit stored as negative materialized balances on 2020 / 1400 (cents).
 * @param {string} memberKey
 * @param {number} year
 */
export async function getMemberStoredCreditCents(memberKey, year) {
  if (String(memberKey).startsWith("app:")) return 0;
  const rows = await MaterializedBalance.find({
    memberId: memberKey,
    year,
    accountCode: { $in: ["2020", "1400"] },
    bucket: { $in: BUCKETS },
  }).lean();
  let cred = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (amt < 0) cred += -amt;
  }
  return cred;
}

/**
 * Operational refundable balance for a member (cents) — same cap as refund validation.
 * @param {string} memberId
 * @param {number} [year]
 */
export async function getRefundableBalanceForMember(memberId, year) {
  const mid = String(memberId || "").trim();
  if (!mid || mid.toLowerCase().startsWith("app:")) return 0;
  const effectiveYear =
    Number.isFinite(year) && year > 0 ? year : new Date().getFullYear();

  let available = await getAvailableCredit2020ForKey(mid, effectiveYear);
  available = Math.max(
    available,
    await getMemberStoredCreditCents(mid, effectiveYear),
  );
  return Math.max(0, available);
}

/**
 * @param {number} refundCents
 * @param {import("mongoose").Document|object} payment
 * @param {number} journalYear
 * @param {{ linkedPaymentRemainingCents?: number }} [options]
 */
export async function assertRefundWithinCredit(
  refundCents,
  payment,
  journalYear,
  options = {}
) {
  const { linkedPaymentRemainingCents } = options;
  const resolved = matBalMemberKeyFromPayment(payment);
  if (!resolved) {
    throw AppError.badRequest(
      "memberId or applicationId required on payment to verify credit for refund"
    );
  }
  let available = await getAvailableCredit2020ForKey(
    resolved.key,
    journalYear
  );

  if (!String(resolved.key).startsWith("app:")) {
    available = Math.max(
      available,
      await getMemberStoredCreditCents(resolved.key, journalYear),
    );
  }

  const appId = applicationIdForClaimLookup(payment, resolved);
  if (appId) {
    const claimMemberId = await getClaimRecipientMemberIdForApplication(appId);
    if (claimMemberId) {
      const claimedMemberCredit = await getAvailableCredit2020ForKey(
        claimMemberId,
        journalYear
      );
      available = Math.max(available, claimedMemberCredit);
      available = Math.max(
        available,
        await getMemberStoredCreditCents(claimMemberId, journalYear),
      );
    }
  }

  if (
    linkedPaymentRemainingCents != null &&
    Number.isFinite(linkedPaymentRemainingCents)
  ) {
    available = Math.max(
      available,
      Math.max(0, Math.floor(linkedPaymentRemainingCents)),
    );
  }

  if (refundCents > available) {
    throw AppError.badRequest("Refund exceeds available credit on account 2020", {
      refundCents,
      availableCreditCents: available,
      year: journalYear,
    });
  }
}
