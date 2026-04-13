import mongoose from "mongoose";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";

const RCP_RE = /^RCP-([a-fA-F0-9]{24})$/u;
const RFD_RE = /^RFD-([a-fA-F0-9]{24})$/u;

function objectIdSuffix(docNo, re) {
  if (!docNo || typeof docNo !== "string") return null;
  const m = re.exec(docNo.trim());
  return m && mongoose.Types.ObjectId.isValid(m[1]) ? m[1] : null;
}

/**
 * Adds `paymentIntentId` (Stripe) to each ledger txn where docNo links to Payment (RCP-)
 * or Refund (RFD-). Other rows get `paymentIntentId: null`.
 *
 * @param {object[]} items - ledger rows (plain objects)
 * @param {string} [tenantId]
 * @returns {Promise<object[]>}
 */
export async function attachPaymentIntentIdsToLedgerItems(items, tenantId) {
  if (!Array.isArray(items) || items.length === 0) return items || [];

  const tid = tenantId != null ? String(tenantId).trim() : "";
  if (!tid) {
    return items.map((txn) => ({ ...txn, paymentIntentId: null }));
  }

  const paymentIdsFromRcp = new Set();
  const refundIds = new Set();

  for (const txn of items) {
    const docNo = String(txn.docNo || "");
    const rcp = objectIdSuffix(docNo, RCP_RE);
    if (rcp) paymentIdsFromRcp.add(rcp);
    const rfd = objectIdSuffix(docNo, RFD_RE);
    if (rfd) refundIds.add(rfd);
  }

  const paymentIdToPi = new Map();
  const refundIdToPi = new Map();

  const refundObjectIds = [...refundIds]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  let refunds = [];
  if (refundObjectIds.length) {
    refunds = await Refund.find({
      tenantId: tid,
      _id: { $in: refundObjectIds },
    })
      .select({ paymentId: 1, stripe: 1 })
      .lean();
  }

  const allPaymentIdStrs = new Set(paymentIdsFromRcp);
  for (const r of refunds) {
    if (r.paymentId) allPaymentIdStrs.add(String(r.paymentId));
  }

  const payObjectIds = [...allPaymentIdStrs]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (payObjectIds.length) {
    const pays = await Payment.find({
      tenantId: tid,
      _id: { $in: payObjectIds },
    })
      .select({ stripe: 1 })
      .lean();
    for (const p of pays) {
      paymentIdToPi.set(String(p._id), p.stripe?.paymentIntentId ?? null);
    }
  }

  for (const r of refunds) {
    const rid = String(r._id);
    const fromRefund = r.stripe?.paymentIntentId ?? null;
    const fromPayment = r.paymentId
      ? paymentIdToPi.get(String(r.paymentId)) ?? null
      : null;
    refundIdToPi.set(rid, fromRefund || fromPayment || null);
  }

  return items.map((txn) => {
    const docNo = String(txn.docNo || "");
    let paymentIntentId = null;
    const rcp = objectIdSuffix(docNo, RCP_RE);
    if (rcp) paymentIntentId = paymentIdToPi.get(rcp) ?? null;
    const rfd = objectIdSuffix(docNo, RFD_RE);
    if (rfd) paymentIntentId = refundIdToPi.get(rfd) ?? paymentIntentId;
    return { ...txn, paymentIntentId };
  });
}
