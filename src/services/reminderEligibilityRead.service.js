import MaterializedBalance from "../models/materializedBalance.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import { memberPaymentCreditCents } from "../helpers/memberLastPayment.js";

const MEMBER_CREDIT_BUCKETS = ["arrears", "current", "advance"];

function normMemberId(memberId) {
  return String(memberId || "").trim();
}

function asDate(value) {
  if (value == null) return new Date();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Sum signed 1400 arrears materialized balance for a member (all years).
 * Positive amount per schema = member owes (debit balance).
 */
export async function sumNet1400ArrearsCents(memberId) {
  const mid = normMemberId(memberId);
  if (!mid) return 0;
  const rows = await MaterializedBalance.find({
    memberId: mid,
    accountCode: "1400",
    bucket: "arrears",
  }).lean();
  let sum = 0;
  for (const r of rows) {
    sum += Number(r.amount) || 0;
  }
  return Math.round(sum);
}

/**
 * Sum signed 1400 current bucket (optional context for snapshots).
 */
export async function sumNet1400CurrentCents(memberId) {
  const mid = normMemberId(memberId);
  if (!mid) return 0;
  const rows = await MaterializedBalance.find({
    memberId: mid,
    accountCode: "1400",
    bucket: "current",
  }).lean();
  let sum = 0;
  for (const r of rows) {
    sum += Number(r.amount) || 0;
  }
  return Math.round(sum);
}

/**
 * Operational available credit for reminder eligibility across all years.
 * Negative materialized 2020/1400 rows represent credit held for the member.
 */
export async function sumAvailableCreditCents(memberId) {
  const mid = normMemberId(memberId);
  if (!mid) return 0;
  const rows = await MaterializedBalance.find({
    memberId: mid,
    accountCode: { $in: ["2020", "1400"] },
    bucket: { $in: MEMBER_CREDIT_BUCKETS },
  }).lean();
  let credit = 0;
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (amount < 0) credit += -amount;
  }
  return Math.round(credit);
}

/**
 * Latest Receipt that credits member-tracked 1400 or 2020 (member cash / allocation).
 */
export async function findLastMemberReceipt(memberId, asOf) {
  const mid = normMemberId(memberId);
  if (!mid) {
    return {
      lastReceiptGlDate: null,
      lastReceiptDocNo: null,
      lastReceiptAmountCents: null,
    };
  }
  const end = asDate(asOf);

  const doc = await GLTransaction.findOne({
    docType: "Receipt",
    date: { $lte: end },
    $or: [
      {
        entries: {
          $elemMatch: {
            memberId: mid,
            accountCode: "2020",
            dc: "C",
          },
        },
      },
      {
        entries: {
          $elemMatch: {
            memberId: mid,
            accountCode: "1400",
            dc: "C",
          },
        },
      },
    ],
  })
    .sort({ date: -1, createdAt: -1 })
    .select({ date: 1, docNo: 1, entries: 1 })
    .lean();

  if (!doc) {
    return {
      lastReceiptGlDate: null,
      lastReceiptDocNo: null,
      lastReceiptAmountCents: null,
    };
  }
  return {
    lastReceiptGlDate: doc.date ? new Date(doc.date).toISOString() : null,
    lastReceiptDocNo: doc.docNo || null,
    lastReceiptAmountCents: memberPaymentCreditCents(mid, doc),
  };
}

/**
 * Snapshot for reminder-batch eligibility (subscription-service / workers).
 */
export async function getReminderEligibilitySnapshot(memberId, asOf) {
  const mid = normMemberId(memberId);
  const asOfDate = asDate(asOf);
  const [net1400ArrearsCents, net1400CurrentCents, availableCreditCents, receipt] =
    await Promise.all([
      sumNet1400ArrearsCents(mid),
      sumNet1400CurrentCents(mid),
      sumAvailableCreditCents(mid),
      findLastMemberReceipt(mid, asOfDate),
    ]);
  const gross1400OwedCents = Math.max(
    0,
    net1400ArrearsCents + net1400CurrentCents,
  );

  return {
    memberId: mid,
    balanceAsOf: asOfDate.toISOString(),
    net1400ArrearsCents,
    net1400CurrentCents,
    gross1400OwedCents,
    availableCreditCents,
    netOutstandingAfterCreditCents: Math.max(
      0,
      gross1400OwedCents - availableCreditCents,
    ),
    lastReceiptGlDate: receipt.lastReceiptGlDate,
    lastReceiptDocNo: receipt.lastReceiptDocNo,
    lastReceiptAmountCents: receipt.lastReceiptAmountCents,
    allocationPolicy: "payment_arrears_current_advance_refund_advance_1400",
  };
}
