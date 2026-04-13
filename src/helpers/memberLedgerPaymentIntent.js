import mongoose from "mongoose";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";

const RCP_RE = /^RCP-([a-fA-F0-9]{24})$/u;
const RFD_RE = /^RFD-([a-fA-F0-9]{24})$/u;
/** Application id may be a UUID (e.g. claim journals use CLAIM-9cd7bf3b-...). */
const CLAIM_RE = /^CLAIM-(.+)$/iu;

function objectIdSuffix(docNo, re) {
  if (!docNo || typeof docNo !== "string") return null;
  const m = re.exec(docNo.trim());
  return m && mongoose.Types.ObjectId.isValid(m[1]) ? m[1] : null;
}

function applicationIdFromClaimDocNo(docNo) {
  if (!docNo || typeof docNo !== "string") return null;
  const m = CLAIM_RE.exec(docNo.trim());
  return m ? m[1].trim() : null;
}

/** Debit amount on 2020 for the application side of a claim receipt (cents). */
function claimApplicationDebitCents(txn) {
  for (const e of txn.entries || []) {
    if (e.accountCode !== "2020" || e.dc !== "D") continue;
    if (e.applicationId) return Number(e.amount) || null;
    const mid = e.memberId != null ? String(e.memberId) : "";
    if (mid.startsWith("app:")) return Number(e.amount) || null;
  }
  return null;
}

/** Member receiving app credit on the claim (2020 credit leg, real memberId). */
function claimRecipientMemberId(txn) {
  for (const e of txn.entries || []) {
    if (e.accountCode !== "2020" || e.dc !== "C") continue;
    const mid = e.memberId != null ? String(e.memberId).trim() : "";
    if (mid && !mid.toLowerCase().startsWith("app:")) return mid;
  }
  return null;
}

const CLAIM_PAYMENT_STATUSES = new Set(["succeeded", "partially_refunded"]);

/**
 * Pick the Stripe payment that funded the application credit being claimed.
 * @param {object[]} payments - Payment docs for one applicationId
 * @param {number|null} claimAmountCents
 */
function pickStripePaymentForClaim(payments, claimAmountCents) {
  const list = (payments || []).filter(
    (p) => p && p.mode !== "external" && CLAIM_PAYMENT_STATUSES.has(p.status)
  );
  if (!list.length) return null;

  let candidates = list;
  if (claimAmountCents != null && claimAmountCents > 0) {
    const byAmount = list.filter((p) => p.amount === claimAmountCents);
    if (byAmount.length) candidates = byAmount;
  }

  candidates = [...candidates].sort((a, b) => {
    const piA = a.stripe?.paymentIntentId ? 1 : 0;
    const piB = b.stripe?.paymentIntentId ? 1 : 0;
    if (piA !== piB) return piB - piA;
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  });

  return candidates[0] || null;
}

/**
 * Adds `paymentIntentId` (Stripe) to each ledger txn where docNo links to Payment (RCP-),
 * Refund (RFD-), or application credit claim (CLAIM-{applicationId}). For CLAIM rows, prefers a
 * succeeded Stripe Payment whose **memberId** matches the claim credit leg, then falls back to
 * payments on the applicationId. Other rows get `paymentIntentId: null`.
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
  const claimApplicationIds = new Set();
  const claimRecipientMemberIds = new Set();

  for (const txn of items) {
    const docNo = String(txn.docNo || "");
    const rcp = objectIdSuffix(docNo, RCP_RE);
    if (rcp) paymentIdsFromRcp.add(rcp);
    const rfd = objectIdSuffix(docNo, RFD_RE);
    if (rfd) refundIds.add(rfd);
    const claimApp = applicationIdFromClaimDocNo(docNo);
    if (claimApp) {
      claimApplicationIds.add(claimApp);
      const rec = claimRecipientMemberId(txn);
      if (rec) claimRecipientMemberIds.add(rec);
    }
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

  /** @type {Map<string, object[]>} */
  const paymentsByApplicationId = new Map();
  /** @type {Map<string, object[]>} */
  const paymentsByMemberId = new Map();

  const claimAppIdList = [...claimApplicationIds].filter(Boolean);
  const claimMemberIdList = [...claimRecipientMemberIds].filter(Boolean);
  if (claimAppIdList.length || claimMemberIdList.length) {
    const or = [];
    if (claimAppIdList.length) {
      or.push({ applicationId: { $in: claimAppIdList } });
    }
    if (claimMemberIdList.length) {
      or.push({ memberId: { $in: claimMemberIdList } });
    }
    const appPays = await Payment.find({
      tenantId: tid,
      $or: or,
    })
      .select({
        stripe: 1,
        applicationId: 1,
        memberId: 1,
        amount: 1,
        status: 1,
        mode: 1,
        createdAt: 1,
      })
      .lean();
    for (const p of appPays) {
      const aid =
        p.applicationId != null ? String(p.applicationId).trim() : "";
      if (aid) {
        if (!paymentsByApplicationId.has(aid))
          paymentsByApplicationId.set(aid, []);
        paymentsByApplicationId.get(aid).push(p);
      }
      const mid = p.memberId != null ? String(p.memberId).trim() : "";
      if (mid) {
        if (!paymentsByMemberId.has(mid)) paymentsByMemberId.set(mid, []);
        paymentsByMemberId.get(mid).push(p);
      }
    }
  }

  return items.map((txn) => {
    const docNo = String(txn.docNo || "");
    let paymentIntentId = null;
    const rcp = objectIdSuffix(docNo, RCP_RE);
    if (rcp) paymentIntentId = paymentIdToPi.get(rcp) ?? null;
    const rfd = objectIdSuffix(docNo, RFD_RE);
    if (rfd) paymentIntentId = refundIdToPi.get(rfd) ?? paymentIntentId;
    const claimApp = applicationIdFromClaimDocNo(docNo);
    if (claimApp && !paymentIntentId) {
      const debitCents = claimApplicationDebitCents(txn);
      const recipientMid = claimRecipientMemberId(txn);
      let picked = null;
      if (recipientMid) {
        const memberCandidates = paymentsByMemberId.get(recipientMid) || [];
        picked = pickStripePaymentForClaim(memberCandidates, debitCents);
      }
      if (!picked) {
        const appCandidates = paymentsByApplicationId.get(claimApp) || [];
        picked = pickStripePaymentForClaim(appCandidates, debitCents);
      }
      paymentIntentId = picked?.stripe?.paymentIntentId ?? null;
    }
    return { ...txn, paymentIntentId };
  });
}
