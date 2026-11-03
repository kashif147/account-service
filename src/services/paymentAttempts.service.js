// Read-only, tenant-scoped listing of persisted Payment attempts for the CRM "Online Payments"
// grid (GET /api/payments/attempts). Every Payment document is one attempt, so an authorised
// hold, a cancelled hold or a failed attempt is visible before any GL Receipt exists. This is
// a VIEW only: nothing here posts GL, changes a Payment, or relaxes the capture / cancel /
// refund endpoints (their server-side checks stay authoritative; `actions` is informational).
import mongoose from "mongoose";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import { logWarn } from "../middlewares/logger.mw.js";
import { resolveAttemptDisplayFields } from "./stripe.payment.enrichment.service.js";

export const LIFECYCLE_STATUSES = Object.freeze([
  "pending",
  "authorised",
  "captured",
  "cancelled",
  "failed",
  "refunded",
  "partially_refunded",
  "unknown",
]);

// Stored Payment.status (payment.model.js enum) -> grid lifecycle. `requires_capture` is an
// authorisation hold and is NEVER `captured`. `manual_review` / `payment_required` are
// external manual-record states (an unposted manual record / a posted invoice awaiting
// payment - eventRegistration.approval.listener.js), not card pre-authorisation, so they map
// to `unknown` rather than being guessed.
export const LIFECYCLE_BY_PROVIDER_STATUS = Object.freeze({
  created: "pending",
  requires_action: "pending",
  processing: "pending",
  requires_capture: "authorised",
  succeeded: "captured",
  refund_required: "captured", // captured, then cancel requested: funds held, refund owed
  canceled: "cancelled",
  authorization_expired: "cancelled", // the hold lapsed; no money was taken
  failed: "failed",
  partially_refunded: "partially_refunded",
  refunded: "refunded",
  manual_review: "unknown",
  payment_required: "unknown",
});

// Stored statuses whose money has been captured (amountCaptured = amount).
const CAPTURED_PROVIDER_STATUSES = new Set(["succeeded", "refund_required", "partially_refunded", "refunded"]);
// assertPaymentAllowsRefund (payments.service.js) accepts only these.
const REFUNDABLE_PROVIDER_STATUSES = new Set(["succeeded", "partially_refunded"]);

export const ATTEMPT_PURPOSES = Object.freeze(Payment.schema.path("purpose").enumValues.slice());
export const ATTEMPT_MODES = Object.freeze(["stripe", "external"]);
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const receiptDocNosFor = (id) => [`RCP-${id}`, `RCP-EVT-${id}`, `RCP-EVT-MANUAL-${id}`];

function providerStatusesFor(lifecycle) {
  return Object.keys(LIFECYCLE_BY_PROVIDER_STATUS).filter((s) => LIFECYCLE_BY_PROVIDER_STATUS[s] === lifecycle);
}

// ---- cursor (opaque keyset: createdAt + _id, matching sort {createdAt:-1, _id:-1}) ----
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ c: new Date(row.createdAt).toISOString(), i: String(row._id) })).toString("base64url");
}

export function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const c = new Date(parsed?.c);
    if (!parsed || typeof parsed.c !== "string" || Number.isNaN(c.getTime())) return null;
    if (typeof parsed.i !== "string" || !/^[a-f0-9]{24}$/i.test(parsed.i)) return null;
    return { createdAt: c, id: new mongoose.Types.ObjectId(parsed.i) };
  } catch {
    return null;
  }
}

function startOfDay(v) {
  const d = new Date(v);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(v) {
  const d = new Date(v);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * partially_refunded rows whose Refund rows already cover the whole amount. createRefund sets
 * refunded vs partially_refunded from the SINGLE refund amount (not cumulative), so a row can be
 * stored partially_refunded while being fully refunded; the lifecycle uses the Refund sums.
 * Only computed when a refunded / partially_refunded status filter needs it.
 */
async function fullyRefundedPartialIds(tenantId) {
  const rows = await Payment.aggregate([
    { $match: { tenantId, status: "partially_refunded" } },
    {
      $lookup: {
        from: Refund.collection.name,
        let: { pid: "$_id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$paymentId", "$$pid"] }, { $eq: ["$tenantId", tenantId] }] } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ],
        as: "refunds",
      },
    },
    { $project: { amount: 1, refunded: { $ifNull: [{ $arrayElemAt: ["$refunds.total", 0] }, 0] } } },
    { $match: { $expr: { $gte: ["$refunded", "$amount"] } } },
    { $project: { _id: 1 } },
  ]);
  return rows.map((r) => r._id);
}

async function buildFilter(tenantId, q) {
  const and = [{ tenantId }];
  if (q.purpose) and.push({ purpose: q.purpose });
  if (q.mode) and.push({ mode: q.mode });
  if (q.applicationId) and.push({ applicationId: q.applicationId });
  if (q.registrationId) and.push({ registrationId: q.registrationId });
  if (q.from || q.to) {
    const createdAt = {};
    if (q.from) createdAt.$gte = startOfDay(q.from);
    if (q.to) createdAt.$lte = endOfDay(q.to);
    and.push({ createdAt });
  }
  if (q.statuses && q.statuses.length) {
    const wanted = new Set(q.statuses);
    const needsRefundSplit = wanted.has("refunded") !== wanted.has("partially_refunded");
    const fullIds = needsRefundSplit ? await fullyRefundedPartialIds(tenantId) : [];
    const or = [];
    const plain = [...wanted].filter((s) => s !== "refunded" && s !== "partially_refunded" && s !== "unknown");
    const plainStatuses = plain.flatMap(providerStatusesFor);
    if (plainStatuses.length) or.push({ status: { $in: plainStatuses } });
    if (wanted.has("unknown")) {
      or.push({ status: { $nin: Object.keys(LIFECYCLE_BY_PROVIDER_STATUS).filter((s) => LIFECYCLE_BY_PROVIDER_STATUS[s] !== "unknown") } });
    }
    if (wanted.has("refunded") && wanted.has("partially_refunded")) {
      or.push({ status: { $in: ["refunded", "partially_refunded"] } });
    } else if (wanted.has("refunded")) {
      or.push({ status: "refunded" });
      if (fullIds.length) or.push({ status: "partially_refunded", _id: { $in: fullIds } });
    } else if (wanted.has("partially_refunded")) {
      or.push(fullIds.length ? { status: "partially_refunded", _id: { $nin: fullIds } } : { status: "partially_refunded" });
    }
    and.push({ $or: or });
  }
  return { $and: and };
}

async function loadRefundTotals(tenantId, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await Refund.aggregate([
    { $match: { tenantId, paymentId: { $in: ids } } },
    { $group: { _id: "$paymentId", total: { $sum: "$amount" } } },
  ]);
  for (const r of rows) map.set(String(r._id), Number(r.total) || 0);
  return map;
}

async function loadReceipts(tenantId, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const docNoToPayment = new Map();
  for (const id of ids) for (const docNo of receiptDocNosFor(String(id))) docNoToPayment.set(docNo, String(id));
  const rows = await GLTransaction.find({
    tenantId,
    docType: "Receipt",
    docNo: { $in: [...docNoToPayment.keys()] },
  })
    .select({ docNo: 1, date: 1, settlement: 1, entries: 1 })
    .lean();
  // Prefer the membership receipt RCP-<id>, then the events receipts.
  const rank = (docNo) => (/^RCP-[a-f0-9]{24}$/i.test(docNo) ? 0 : docNo.startsWith("RCP-EVT-MANUAL-") ? 2 : 1);
  rows.sort((a, b) => rank(a.docNo) - rank(b.docNo));
  for (const r of rows) {
    const pid = docNoToPayment.get(r.docNo);
    if (pid && !map.has(pid)) map.set(pid, r);
  }
  return map;
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const str = (v) => (v == null || String(v).trim() === "" ? null : String(v));

function receiptView(r) {
  if (!r) return null;
  const bank = (Array.isArray(r.entries) ? r.entries : []).find((e) => e?.accountCode === "1220" && e?.dc === "D");
  return {
    id: String(r._id),
    docNo: r.docNo,
    date: toIso(r.date),
    settlementStatus: str(r.settlement?.status),
    settlementProvider: str(r.settlement?.provider),
    paidAmount: bank && Number.isFinite(Number(bank.amount)) ? Number(bank.amount) : null,
  };
}

/** Lifecycle + money for one stored Payment (pure; exported for tests). */
export function deriveAttemptMoney(p, refundTotal) {
  const providerStatus = p.status || null;
  const amount = Number(p.amount) || 0;
  const captured = CAPTURED_PROVIDER_STATUSES.has(providerStatus);
  const amountCaptured = captured ? amount : 0;
  const hasRefundRows = refundTotal != null;
  let amountRefunded;
  if (hasRefundRows) amountRefunded = refundTotal;
  else if (providerStatus === "refunded") amountRefunded = amountCaptured; // e.g. a Stripe-side full refund (no Refund rows)
  else if (providerStatus === "partially_refunded") amountRefunded = null; // refunded at Stripe, amount not stored here
  else amountRefunded = 0;

  let lifecycleStatus = LIFECYCLE_BY_PROVIDER_STATUS[providerStatus] || "unknown";
  if (providerStatus === "partially_refunded" && hasRefundRows && amountCaptured > 0 && refundTotal >= amountCaptured) {
    lifecycleStatus = "refunded";
  }
  return { providerStatus, lifecycleStatus, amountCaptured, amountRefunded };
}

/**
 * Informational refund eligibility, mirroring createRefund + the grid's existing rule
 * (isRefundableUnapprovedRow + its applicationId / paymentIntentId checks). POST
 * /payments/refunds re-checks everything server-side (incl. assertRefundWithinCredit).
 */
export function computeCanRefund(p, money, receipt) {
  if (!REFUNDABLE_PROVIDER_STATUSES.has(p.status)) return false;
  if (money.amountRefunded == null) return false;
  if ((Number(p.amount) || 0) - money.amountRefunded <= 0) return false;
  if (!receipt || String(receipt.settlementStatus || "").toUpperCase() !== "PENDING") return false;
  if (str(p.memberId)) return false;
  if (!str(p.applicationId)) return false;
  if (p.mode === "stripe" && !str(p.stripe?.paymentIntentId)) return false;
  return true;
}

const DISPLAY_KEYS = [
  "membershipNumber",
  "fullName",
  "membershipCategory",
  "membershipStatus",
  "joinDate",
  "renewalDate",
  "billingCycle",
  "paymentMethod",
];

// Explicit allow-list projection: built field by field, the document is never spread.
function toItem(p, { refundTotal, receipt, display }) {
  const money = deriveAttemptMoney(p, refundTotal);
  const receiptOut = receiptView(receipt);
  const item = {
    id: String(p._id),
    attemptNumber: Number.isFinite(Number(p.attemptNumber)) ? Number(p.attemptNumber) : 1,
    isActiveAttempt: p.isActiveAttempt !== false,
    supersededAt: toIso(p.supersededAt),
    purpose: p.purpose || null,
    ledgerDomain: p.ledgerDomain || null,
    source: p.source || null,
    mode: p.mode || null,
    amount: Number(p.amount) || 0,
    currency: p.currency || null,
    lifecycleStatus: money.lifecycleStatus,
    providerStatus: money.providerStatus,
    amountCaptured: money.amountCaptured,
    amountRefunded: money.amountRefunded,
    applicationId: str(p.applicationId),
    registrationId: str(p.registrationId),
    profileId: str(p.profileId),
    memberId: str(p.memberId),
    payerUserType: p.payer?.userType ?? null,
    createdAt: toIso(p.createdAt),
    authorisedAt: toIso(p.authorisedAt),
    capturedAt: toIso(p.stripe?.capturedAt),
    canceledAt: toIso(p.stripe?.canceledAt),
    capturableUntil: toIso(p.capturableUntil),
    failureCode: str(p.stripe?.failureCode),
    cancellationReason: str(p.stripe?.cancellationReason),
    paymentIntentId: str(p.stripe?.paymentIntentId),
    receipt: receiptOut,
  };
  for (const k of DISPLAY_KEYS) item[k] = display?.[k] ?? null;
  item.actions = { canRefund: computeCanRefund(p, money, receiptOut) };
  return item;
}

/**
 * @param {import("express").Request} req  authenticated CRM request (tenant from verified identity only)
 * @param {{statuses?:string[], purpose?:string, mode?:string, applicationId?:string,
 *          registrationId?:string, from?:string, to?:string, limit?:number, cursor?:string}} q
 */
export async function listPaymentAttempts(req, q = {}) {
  const tenantId = requireTenantId(req);
  const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const baseFilter = await buildFilter(tenantId, q);
  const pageFilter = { $and: [...baseFilter.$and] };
  if (q.cursor) {
    const cur = decodeCursor(q.cursor);
    if (!cur) throw AppError.badRequest("Invalid cursor");
    pageFilter.$and.push({
      $or: [{ createdAt: { $lt: cur.createdAt } }, { createdAt: cur.createdAt, _id: { $lt: cur.id } }],
    });
  }

  const [rows, total] = await Promise.all([
    Payment.find(pageFilter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
    Payment.countDocuments(baseFilter),
  ]);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length ? encodeCursor(page[page.length - 1]) : null;

  const ids = page.map((p) => p._id);
  const [refundTotals, receipts] = await Promise.all([loadRefundTotals(tenantId, ids), loadReceipts(tenantId, ids)]);

  let displays = new Map();
  try {
    displays = await resolveAttemptDisplayFields(
      page.map((p) => ({ key: String(p._id), memberId: str(p.memberId), applicationId: str(p.applicationId) })),
      req,
    );
  } catch (err) {
    logWarn("Payment attempt display enrichment failed; returning rows without it", { error: err?.message });
    displays = new Map();
  }

  const items = page.map((p) =>
    toItem(p, {
      refundTotal: refundTotals.has(String(p._id)) ? refundTotals.get(String(p._id)) : null,
      receipt: receipts.get(String(p._id)) || null,
      display: displays.get(String(p._id)) || null,
    }),
  );

  return { items, limit, nextCursor, total };
}
