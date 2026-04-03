import MaterializedBalance from "../models/materializedBalance.model.js";
import { AppError } from "../errors/AppError.js";

const BUCKETS = ["arrears", "current", "advance"];

/**
 * Resolve MaterializedBalance memberId field (same convention as journal rollupMemberBalances).
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
  if (applicationId) {
    return { key: `app:${applicationId}`, memberId: null, applicationId };
  }
  if (memberId) {
    return { key: memberId, memberId, applicationId: null };
  }
  return null;
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
 * @param {number} refundCents
 * @param {import("mongoose").Document|object} payment
 * @param {number} journalYear
 */
export async function assertRefundWithinCredit(
  refundCents,
  payment,
  journalYear
) {
  const resolved = matBalMemberKeyFromPayment(payment);
  if (!resolved) {
    throw AppError.badRequest(
      "memberId or applicationId required on payment to verify credit for refund"
    );
  }
  const available = await getAvailableCredit2020ForKey(
    resolved.key,
    journalYear
  );
  if (refundCents > available) {
    throw AppError.badRequest("Refund exceeds available credit on account 2020", {
      refundCents,
      availableCreditCents: available,
      year: journalYear,
    });
  }
}
