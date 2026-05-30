import mongoose from "mongoose";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
import GLTransaction from "../models/glTransaction.model.js";

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

function claimApplicationIdForTxn(txn) {
  const fromDoc = applicationIdFromClaimDocNo(String(txn?.docNo || ""));
  if (fromDoc) return fromDoc;
  const s =
    txn?.sourceApplicationId != null
      ? String(txn.sourceApplicationId).trim()
      : "";
  return s || null;
}

/** Claim journal (new `Claim` docType or legacy `Receipt` + CLAIM docNo / memo). */
function isClaimLedgerTxn(txn) {
  if (!txn) return false;
  if (txn.docType === "Claim") return true;
  if (txn.docType !== "Receipt") return false;
  const memo = String(txn.memo || "");
  const docNo = String(txn.docNo || "");
  return memo.startsWith("Claim app credit") || /^CLAIM-/i.test(docNo);
}

/**
 * Same funding payment as used for paymentIntentId on claim rows.
 * @param {object} txn
 * @param {Map<string, object[]>} paymentsByMemberId
 * @param {Map<string, object[]>} paymentsByApplicationId
 */
function resolveClaimFundingPayment(
  txn,
  paymentsByMemberId,
  paymentsByApplicationId
) {
  const claimKey = claimApplicationIdForTxn(txn);
  if (!claimKey) return null;
  const debitCents = claimApplicationDebitCents(txn);
  const recipientMid = claimRecipientMemberId(txn);
  let picked = null;
  if (recipientMid) {
    picked = pickStripePaymentForClaim(
      paymentsByMemberId.get(recipientMid) || [],
      debitCents
    );
  }
  if (!picked) {
    picked = pickStripePaymentForClaim(
      paymentsByApplicationId.get(claimKey) || [],
      debitCents
    );
  }
  return picked;
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
 * For claim rows, when the funding `RCP-{paymentId}` is **not** already in `items`, loads that
 * receipt once (batch `GL.find`) and sets **`underlyingReceiptGl`** so clients get the full GL
 * (e.g. **1220** clearing lines) without duplicating rows in the list.
 *
 * @param {object[]} items - ledger rows (plain objects)
 * @param {string} [tenantId]
 * @returns {Promise<object[]>}
 */
export async function attachPaymentIntentIdsToLedgerItems(items, tenantId) {
  if (!Array.isArray(items) || items.length === 0) return items || [];

  const tid = tenantId != null ? String(tenantId).trim() : "";
  if (!tid) {
    return items.map((txn) => ({
      ...txn,
      paymentIntentId: null,
      paymentStatus: null,
    }));
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
    if (txn.docType === "Claim") {
      const sid =
        txn.sourceApplicationId != null
          ? String(txn.sourceApplicationId).trim()
          : "";
      if (sid) claimApplicationIds.add(sid);
      const rec = claimRecipientMemberId(txn);
      if (rec) claimRecipientMemberIds.add(rec);
    }
  }

  const paymentIdToPi = new Map();
  const paymentIdToStatus = new Map();
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
      .select({ stripe: 1, status: 1 })
      .lean();
    for (const p of pays) {
      paymentIdToPi.set(String(p._id), p.stripe?.paymentIntentId ?? null);
      paymentIdToStatus.set(String(p._id), p.status ?? null);
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
        _id: 1,
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

  const ledgerDocNos = new Set(
    items.map((t) => String(t?.docNo || "").trim()).filter(Boolean)
  );

  const claimFundingPick = new Map();
  function fundingPaymentForClaimRow(txn) {
    if (!isClaimLedgerTxn(txn)) return null;
    const key = String(txn._id ?? txn.docNo ?? "");
    if (!key) return resolveClaimFundingPayment(
      txn,
      paymentsByMemberId,
      paymentsByApplicationId
    );
    if (!claimFundingPick.has(key)) {
      claimFundingPick.set(
        key,
        resolveClaimFundingPayment(
          txn,
          paymentsByMemberId,
          paymentsByApplicationId
        )
      );
    }
    return claimFundingPick.get(key);
  }

  const rcpDocNosToFetch = new Set();
  for (const txn of items) {
    const picked = fundingPaymentForClaimRow(txn);
    if (!picked?._id) continue;
    const rcpDocNo = `RCP-${String(picked._id)}`;
    if (!ledgerDocNos.has(rcpDocNo)) rcpDocNosToFetch.add(rcpDocNo);
  }

  let rcpGlByDocNo = new Map();
  if (rcpDocNosToFetch.size > 0) {
    const glRows = await GLTransaction.find({
      docNo: { $in: [...rcpDocNosToFetch] },
    }).lean();
    rcpGlByDocNo = new Map(glRows.map((g) => [String(g.docNo), g]));
  }

  return items.map((txn) => {
    const docNo = String(txn.docNo || "");
    let paymentIntentId = null;
    let paymentStatus = null;
    const rcp = objectIdSuffix(docNo, RCP_RE);
    if (rcp) {
      paymentIntentId = paymentIdToPi.get(rcp) ?? null;
      paymentStatus = paymentIdToStatus.get(rcp) ?? null;
    }
    const rfd = objectIdSuffix(docNo, RFD_RE);
    if (rfd) paymentIntentId = refundIdToPi.get(rfd) ?? paymentIntentId;
    const claimKey = claimApplicationIdForTxn(txn);
    if (claimKey && !paymentIntentId) {
      const picked = fundingPaymentForClaimRow(txn);
      paymentIntentId = picked?.stripe?.paymentIntentId ?? null;
      paymentStatus = picked?.status ?? paymentStatus;
    }

    let underlyingReceiptGl = null;
    if (isClaimLedgerTxn(txn)) {
      const picked = fundingPaymentForClaimRow(txn);
      if (picked?._id) {
        const rcpDocNo = `RCP-${String(picked._id)}`;
        if (!ledgerDocNos.has(rcpDocNo)) {
          const gl = rcpGlByDocNo.get(rcpDocNo);
          if (gl) underlyingReceiptGl = gl;
        }
      }
    }

    return {
      ...txn,
      paymentIntentId,
      paymentStatus,
      underlyingReceiptGl,
    };
  });
}
