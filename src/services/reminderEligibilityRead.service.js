import MaterializedBalance from "../models/materializedBalance.model.js";
import GLTransaction from "../models/glTransaction.model.js";

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
 * Latest Receipt that credits member-tracked 1400 or 2020 (member cash / allocation).
 */
export async function findLastMemberReceipt(memberId, asOf) {
  const mid = normMemberId(memberId);
  if (!mid) return { lastReceiptGlDate: null, lastReceiptDocNo: null };
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
    .select({ date: 1, docNo: 1 })
    .lean();

  if (!doc) return { lastReceiptGlDate: null, lastReceiptDocNo: null };
  return {
    lastReceiptGlDate: doc.date ? new Date(doc.date).toISOString() : null,
    lastReceiptDocNo: doc.docNo || null,
  };
}

/**
 * Snapshot for reminder-batch eligibility (subscription-service / workers).
 */
export async function getReminderEligibilitySnapshot(memberId, asOf) {
  const mid = normMemberId(memberId);
  const asOfDate = asDate(asOf);
  const [net1400ArrearsCents, net1400CurrentCents, receipt] =
    await Promise.all([
      sumNet1400ArrearsCents(mid),
      sumNet1400CurrentCents(mid),
      findLastMemberReceipt(mid, asOfDate),
    ]);

  return {
    memberId: mid,
    balanceAsOf: asOfDate.toISOString(),
    net1400ArrearsCents,
    net1400CurrentCents,
    lastReceiptGlDate: receipt.lastReceiptGlDate,
    lastReceiptDocNo: receipt.lastReceiptDocNo,
    allocationPolicy: "payment_arrears_current_advance_refund_advance_1400",
  };
}
