// P5 durable refund operations: ONE balance / reservation mechanism for every path that moves
// refund money or writes Refund rows against a Payment or a credit balance (CRM POST
// /payments/refunds, the events.event.cancelled.v1 automatic refund, and Stripe refunds made
// outside the API that are observed by the charge.refunded / refund.* webhook).
//
// State machine (RefundOperation.state), every transition a conditional update (CAS) on
// {state, version[, lease.owner]} that increments `version` (fencing token):
//   reserved   - persisted, reservations held, provider NOT called. A worker owns it through its
//                lease (lease.owner = random token, lease.expiresAt).
//   submitting - the owner CAS-ed reserved -> submitting with its own token and a live lease;
//                ONLY then may it call Stripe (idempotency key "refundop:<id>", server-derived).
//   succeeded  - provider confirmed; finalize() (idempotent) writes the Refund row, commits the
//                payment counter once, posts GL, then releases the credit reservation.
//   failed     - DEFINITIVE evidence of non-execution: a definitive provider error (also on an
//                idempotent replay), a reserved operation fenced off before it was ever submitted,
//                or an explicit, audited finance release. Reservations released.
//   uncertain  - timeout / network / 5xx: outcome unknown. Reservations STAY held. Resolution:
//                replay the SAME create (same key, same params) while Stripe still retains the
//                idempotency key (>= 24 h after the first request): Stripe returns the original
//                refund if it executed, else executes it now. After that window: read-only lookup;
//                found -> complete, not found -> manual review. Never released on absence alone.
import crypto from "node:crypto";
import mongoose from "mongoose";
import PaymentModel from "../models/payment.model.js";
import RefundModel from "../models/refund.model.js";
import RefundOperationModel from "../models/refundOperation.model.js";
import MemberRefundReservationModel from "../models/memberRefundReservation.model.js";
import { getStripe as realGetStripe } from "../lib/stripe.js";
import { AppError } from "../errors/AppError.js";

export const ACTIVE_STATES = Object.freeze(["reserved", "submitting", "uncertain"]);
export const REFUNDABLE_PAYMENT_STATUSES = Object.freeze(["succeeded", "partially_refunded"]);
// Stripe prunes idempotency keys once they are at least 24 hours old; replay is only offered
// inside a safety margin of that window.
export const STRIPE_IDEMPOTENCY_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function leaseMs(env = process.env) {
  const n = Number(env.REFUND_OPERATION_LEASE_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

/** Test-only fault / pause injection (simulated crash or a slow worker). */
export const refundOpsHooks = { afterReserve: null, afterStripe: null };

const sources = new Map();
export function registerRefundOperationSource(source, handler) {
  sources.set(source, handler);
}

export function defaultRefundOpsDeps() {
  return {
    Payment: PaymentModel,
    Refund: RefundModel,
    RefundOperation: RefundOperationModel,
    MemberRefundReservation: MemberRefundReservationModel,
    getStripe: realGetStripe,
  };
}

const LEAN = { new: true, lean: true };
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));
const crashOf = (err) => err?.simulatedCrash === true;
const newToken = () => crypto.randomBytes(12).toString("hex");
const opError = (status, code, message, extras = {}) => new AppError(message, status, code, extras);

async function sumRefundRows(deps, tenantId, paymentId) {
  const agg = await deps.Refund.aggregate([
    { $match: { tenantId, paymentId } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return Number(agg?.[0]?.total) || 0;
}

/** definitive: the provider refused (nothing executed); uncertain: outcome unknown. */
export function classifyProviderError(err) {
  const type = String(err?.type || err?.rawType || "");
  const status = Number(err?.statusCode || err?.status || 0);
  if (["StripeCardError", "StripeInvalidRequestError", "StripePermissionError", "StripeAuthenticationError", "StripeIdempotencyError"].includes(type)) {
    return "definitive";
  }
  if ([400, 401, 402, 403, 404].includes(status)) return "definitive";
  return "uncertain";
}

// ---------------------------------------------------------------- payment-level balance
async function initCommitted(deps, tenantId, paymentId) {
  const rows = await sumRefundRows(deps, tenantId, paymentId);
  await deps.Payment.updateOne(
    { _id: paymentId, tenantId, refundCommittedCents: { $exists: false } },
    { $set: { refundCommittedCents: rows } },
  );
}

/** Atomic: admits `amount` only while committed + reserved + amount <= captured amount. */
export async function reservePayment(deps, payment, opId, amount) {
  await initCommitted(deps, payment.tenantId, payment._id);
  return deps.Payment.findOneAndUpdate(
    {
      _id: payment._id,
      tenantId: payment.tenantId,
      status: { $in: REFUNDABLE_PAYMENT_STATUSES },
      "refundReservations.opId": { $ne: opId },
      refundCommittedOps: { $ne: opId },
      $expr: {
        $lte: [
          {
            $add: [
              { $sum: { $ifNull: ["$refundReservations.amount", []] } },
              { $ifNull: ["$refundCommittedCents", 0] },
              amount,
            ],
          },
          "$amount",
        ],
      },
    },
    { $push: { refundReservations: { opId, amount, at: new Date() } } },
    LEAN,
  );
}

/** Amount of the payment not yet committed or reserved (for automatic full refunds). */
export async function freePaymentAmount(deps, payment) {
  await initCommitted(deps, payment.tenantId, payment._id);
  const fresh = await deps.Payment.findOne({ _id: payment._id, tenantId: payment.tenantId }, null, { lean: true });
  if (!fresh) return 0;
  const reserved = (fresh.refundReservations || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return Math.max(0, (Number(fresh.amount) || 0) - (Number(fresh.refundCommittedCents) || 0) - reserved);
}

/**
 * Exactly once per operation, with or without a prior reservation: the opId is recorded in
 * refundCommittedOps in the same update that increments refundCommittedCents.
 */
async function commitPayment(deps, op) {
  if (!op.paymentId) return;
  // (refundCommittedCents was initialised from the Refund rows before this operation's own row
  // existed: at reservation time, or in recordObservedProviderRefunds.)
  await deps.Payment.updateOne(
    { _id: op.paymentId, tenantId: op.tenantId, refundCommittedOps: { $ne: op._id } },
    {
      $pull: { refundReservations: { opId: op._id } },
      $inc: { refundCommittedCents: op.amount },
      $push: { refundCommittedOps: op._id },
    },
  );
}

async function releasePayment(deps, op) {
  if (!op.paymentId) return;
  await deps.Payment.updateOne(
    { _id: op.paymentId, tenantId: op.tenantId },
    { $pull: { refundReservations: { opId: op._id } } },
  );
}

// ---------------------------------------------------------------- credit-balance reservation
/**
 * Atomic, tenant-scoped reservation on the authoritative credit balance the refund journal will
 * debit (member key, or `app:<applicationId>` for credit still held on the application key).
 * `available()` reads that balance from the GL (MaterializedBalance). The conditional push admits
 * the amount only while (in-flight reservations + amount) <= available; a post-check re-reads the
 * balance so a refund that completed meanwhile is counted (an in-flight refund whose GL already
 * posted is briefly counted twice: conservative, never permissive).
 */
export async function reserveMember(deps, { tenantId, memberKey, opId, amount, available }) {
  const avail0 = Math.max(0, Number(await available()) || 0);
  try {
    await deps.MemberRefundReservation.updateOne(
      { tenantId, memberKey },
      { $setOnInsert: { tenantId, memberKey, reservations: [] } },
      { upsert: true },
    );
  } catch (err) {
    if (!isDup(err)) throw err;
  }
  const doc = await deps.MemberRefundReservation.findOneAndUpdate(
    {
      tenantId,
      memberKey,
      "reservations.opId": { $ne: opId },
      $expr: { $lte: [{ $add: [{ $sum: { $ifNull: ["$reservations.amount", []] } }, amount] }, avail0] },
    },
    { $push: { reservations: { opId, amount, at: new Date() } } },
    LEAN,
  );
  if (!doc) return { ok: false, available: avail0 };
  const avail1 = Math.max(0, Number(await available()) || 0);
  const held = (doc.reservations || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  if (held > avail1) {
    await releaseMember(deps, { tenantId, memberKey, opId });
    return { ok: false, available: avail1 };
  }
  return { ok: true, available: avail1 };
}

export async function releaseMember(deps, { tenantId, memberKey, opId }) {
  if (!memberKey) return;
  await deps.MemberRefundReservation.updateOne({ tenantId, memberKey }, { $pull: { reservations: { opId } } });
}

// ---------------------------------------------------------------- fenced transitions
/**
 * CAS on {state, version[, owner, live lease]}; increments version. Returns the new document, or
 * null when another actor changed the operation first (the caller must then stop).
 */
async function cas(deps, op, { from, to, owner, requireLiveLease = false, set = {}, note, actor }) {
  const now = new Date();
  const filter = { _id: op._id, tenantId: op.tenantId, state: { $in: [].concat(from) }, version: op.version };
  if (owner) filter["lease.owner"] = owner;
  if (requireLiveLease) filter["lease.expiresAt"] = { $gt: now };
  return deps.RefundOperation.findOneAndUpdate(
    filter,
    {
      $set: { state: to, ...set },
      $inc: { version: 1 },
      $push: { history: { state: to, at: now, ...(note ? { note } : {}), ...(actor ? { actor } : {}) } },
    },
    LEAN,
  );
}

/** Take ownership of an operation whose lease has expired (or that has none). */
async function claim(deps, op, token) {
  const now = new Date();
  return deps.RefundOperation.findOneAndUpdate(
    {
      _id: op._id,
      tenantId: op.tenantId,
      state: op.state,
      version: op.version,
      $or: [{ "lease.expiresAt": { $lte: now } }, { "lease.expiresAt": { $exists: false } }, { lease: null }],
    },
    { $set: { lease: { owner: token, expiresAt: new Date(now.getTime() + leaseMs()) } }, $inc: { version: 1 } },
    LEAN,
  );
}

async function releaseAll(deps, op) {
  await releasePayment(deps, op);
  if (op.memberKey) await releaseMember(deps, { tenantId: op.tenantId, memberKey: op.memberKey, opId: op._id });
  await deps.RefundOperation.updateOne(
    { _id: op._id, tenantId: op.tenantId },
    { $set: { paymentReservationHeld: false, memberReservationHeld: false } },
  );
}

// ---------------------------------------------------------------- start / execute
/**
 * Persist the operation (owned by a fresh lease token), then take the reservations. Returns
 * { op, token } for a new operation or { existing } when the client key was already used.
 */
export async function startOperation(deps, spec) {
  const { tenantId, clientKey } = spec;
  if (clientKey) {
    const existing = await deps.RefundOperation.findOne({ tenantId, clientKey }, null, { lean: true });
    if (existing) return { existing };
  }
  const _id = new mongoose.Types.ObjectId();
  const token = newToken();
  let op;
  try {
    op = await deps.RefundOperation.create({
      _id,
      tenantId,
      source: spec.source,
      flow: spec.flow,
      mode: spec.mode,
      state: "reserved",
      version: 0,
      lease: { owner: token, expiresAt: new Date(Date.now() + leaseMs()) },
      paymentId: spec.payment?._id || null,
      memberKey: spec.memberKey || null,
      amount: spec.amount,
      currency: spec.currency,
      ...(clientKey ? { clientKey } : {}),
      requestFingerprint: spec.fingerprint || null,
      stripeIdempotencyKey: `refundop:${_id}`,
      stripeParams: spec.stripeParams || null,
      refundTemplate: spec.refundTemplate || null,
      glContext: spec.glContext || null,
      policy: spec.policy || null,
      createdBy: spec.createdBy || null,
      history: [{ state: "reserved", at: new Date() }],
    });
    op = typeof op?.toObject === "function" ? op.toObject() : op;
  } catch (err) {
    if (clientKey && isDup(err)) {
      const existing = await deps.RefundOperation.findOne({ tenantId, clientKey }, null, { lean: true });
      if (existing) return { existing };
    }
    throw err;
  }

  // Reservation refused -> nothing was executed (the provider was never called): remove it.
  const abandon = async (error) => {
    await releasePayment(deps, op);
    if (op.memberKey) await releaseMember(deps, { tenantId, memberKey: op.memberKey, opId: op._id });
    await deps.RefundOperation.deleteOne({ _id: op._id, tenantId, state: "reserved" });
    throw error;
  };
  if (spec.payment) {
    const reserved = await reservePayment(deps, spec.payment, op._id, op.amount);
    if (!reserved) {
      await abandon(opError(409, "REFUND_AMOUNT_UNAVAILABLE", "Refund exceeds the remaining refundable amount on the payment (or another refund is in progress)", { refundCents: op.amount }));
    }
    await deps.RefundOperation.updateOne({ _id: op._id, tenantId }, { $set: { paymentReservationHeld: true } });
    op.paymentReservationHeld = true;
  }
  if (spec.memberKey && typeof spec.memberAvailable === "function") {
    const m = await reserveMember(deps, { tenantId, memberKey: spec.memberKey, opId: op._id, amount: op.amount, available: spec.memberAvailable });
    if (!m.ok) {
      await abandon(opError(409, "REFUND_MEMBER_CREDIT_UNAVAILABLE", "Refund exceeds the available refundable credit (or another refund is in progress)", { refundCents: op.amount, availableCreditCents: m.available, creditKey: String(spec.memberKey).startsWith("app:") ? "application" : "member" }));
    }
    await deps.RefundOperation.updateOne({ _id: op._id, tenantId }, { $set: { memberReservationHeld: true } });
    op.memberReservationHeld = true;
  }
  if (refundOpsHooks.afterReserve) await refundOpsHooks.afterReserve(op);
  return { op, token };
}

async function callProvider(deps, op) {
  return deps.getStripe().refunds.create(
    {
      payment_intent: op.stripeParams.payment_intent,
      ...(op.stripeParams.charge ? { charge: op.stripeParams.charge } : {}),
      amount: op.amount,
      metadata: {
        ...(op.stripeParams.metadata || {}),
        refundOperationId: String(op._id),
        tenantId: String(op.tenantId),
        ...(op.paymentId ? { paymentId: String(op.paymentId) } : {}),
      },
    },
    { idempotencyKey: op.stripeIdempotencyKey },
  );
}

function providerErrorOf(err) {
  return { status: Number(err?.statusCode || 0) || null, code: err?.code || null, providerType: err?.type || null, message: String(err?.message || "").slice(0, 300) };
}

/**
 * Owner path: CAS reserved -> submitting with this worker's token and a live lease, THEN call
 * Stripe. A worker that lost its operation to reconciliation (version / owner changed, or its
 * lease expired) cannot pass the CAS and never calls the provider.
 */
export async function executeOperation(deps, op, token) {
  if (op.mode === "stripe" && op.stripeParams?.payment_intent) {
    const submitting = await cas(deps, op, {
      from: "reserved",
      to: "submitting",
      owner: token,
      requireLiveLease: true,
      set: { submittedAt: new Date(), "lease.expiresAt": new Date(Date.now() + leaseMs()) },
    });
    if (!submitting) {
      throw opError(409, "REFUND_OPERATION_SUPERSEDED", "This refund operation is no longer owned by this request; it was not submitted", { operationId: String(op._id) });
    }
    let refund;
    try {
      refund = await callProvider(deps, submitting);
    } catch (err) {
      if (crashOf(err)) throw err;
      return handleProviderFailure(deps, submitting, token, err);
    }
    if (refundOpsHooks.afterStripe) await refundOpsHooks.afterStripe(submitting, refund);
    const done = await cas(deps, submitting, {
      from: "submitting",
      to: "succeeded",
      owner: token,
      set: { stripeRefundId: refund.id, stripeChargeId: refund.charge || submitting.stripeParams.charge || null, resolvedAt: new Date(), lease: null },
    });
    if (!done) {
      // Another actor resolved it meanwhile (only possible after this lease expired): it holds the
      // same Stripe refund (same idempotency key) and finalizes it.
      throw opError(409, "REFUND_OPERATION_SUPERSEDED", "This refund operation was resolved by reconciliation", { operationId: String(op._id) });
    }
  } else {
    const done = await cas(deps, op, { from: "reserved", to: "succeeded", owner: token, requireLiveLease: true, set: { resolvedAt: new Date(), lease: null } });
    if (!done) throw opError(409, "REFUND_OPERATION_SUPERSEDED", "This refund operation is no longer owned by this request", { operationId: String(op._id) });
  }
  return finalizeOperation(deps, op._id, op.tenantId);
}

async function handleProviderFailure(deps, op, token, err) {
  const providerError = providerErrorOf(err);
  if (classifyProviderError(err) === "definitive") {
    const failed = await cas(deps, op, { from: ["submitting", "uncertain"], to: "failed", owner: token, set: { error: { ...providerError, http: 502, appCode: "REFUND_PROVIDER_REJECTED" }, resolvedAt: new Date(), lease: null }, note: "provider_rejected" });
    if (failed) await releaseAll(deps, failed);
    throw opError(502, "REFUND_PROVIDER_REJECTED", "The payment provider rejected the refund", { operationId: String(op._id), providerCode: providerError.code });
  }
  // Outcome unknown: keep every reservation, give up the lease so reconciliation can take over.
  await cas(deps, op, { from: ["submitting", "uncertain"], to: "uncertain", owner: token, set: { error: providerError, lease: null }, note: "provider_outcome_unknown" });
  throw opError(503, "REFUND_OUTCOME_UNCERTAIN", "The refund outcome is not known yet; it is held for reconciliation", { operationId: String(op._id) });
}

/** Idempotent completion of a succeeded operation. Safe to call any number of times. */
export async function finalizeOperation(deps, opId, tenantId) {
  const op = await deps.RefundOperation.findOne({ _id: opId, tenantId }, null, { lean: true });
  if (!op) throw opError(404, "REFUND_OPERATION_NOT_FOUND", "Refund operation not found");
  if (op.state !== "succeeded") throw opError(409, "REFUND_OPERATION_NOT_SUCCEEDED", "Refund operation has not succeeded", { state: op.state });
  if (op.finalizedAt && op.result) return op.result;
  const handler = sources.get(op.source);
  if (!handler) throw opError(500, "REFUND_SOURCE_UNREGISTERED", `No refund handler for source ${op.source}`);

  let refundDoc = await deps.Refund.findOne({ tenantId, refundOperationId: op._id }, null, { lean: true });
  if (!refundDoc) {
    try {
      const created = await deps.Refund.create(handler.buildRefundDoc(op, deps));
      refundDoc = typeof created?.toObject === "function" ? created.toObject() : created;
    } catch (err) {
      if (!isDup(err)) throw err;
      refundDoc = await deps.Refund.findOne({ tenantId, refundOperationId: op._id }, null, { lean: true });
    }
  }
  await deps.RefundOperation.updateOne({ _id: op._id, tenantId }, { $set: { refundDocId: refundDoc._id } });

  await commitPayment(deps, op);
  // Observed (out-of-band) refunds leave Payment.status to the webhook state machine (shadow /
  // authoritative mode); the counters above already reduce the refundable balance.
  if (op.paymentId && handler.updatesPaymentStatus !== false) {
    const payment = await deps.Payment.findOne({ _id: op.paymentId, tenantId }, null, { lean: true });
    if (payment) {
      const total = await sumRefundRows(deps, tenantId, op.paymentId);
      await deps.Payment.updateOne(
        { _id: op.paymentId, tenantId },
        { $set: { status: total >= Number(payment.amount) ? "refunded" : "partially_refunded", "audit.updatedBy": op.createdBy || "system" } },
      );
    }
  }
  await deps.RefundOperation.updateOne({ _id: op._id, tenantId }, { $set: { paymentReservationHeld: false } });

  // GL (idempotent per refund docNo). The credit reservation is released only once the refund
  // journal (which reduces that credit) is posted.
  let gl = { glPosted: refundDoc.glStatus === "posted", glDocNo: refundDoc.glDocNo || null };
  if (!gl.glPosted) gl = await handler.postGl(op, refundDoc, deps);
  if (gl.glPosted && op.memberKey) await releaseMember(deps, { tenantId, memberKey: op.memberKey, opId: op._id });
  const result = handler.result(op, refundDoc, gl, deps);
  await deps.RefundOperation.updateOne(
    { _id: op._id, tenantId },
    {
      $set: {
        result,
        glStatus: gl.glPosted ? "posted" : "gl_failed",
        memberReservationHeld: gl.glPosted ? false : Boolean(op.memberReservationHeld),
        ...(gl.glPosted ? { finalizedAt: new Date() } : {}),
      },
    },
  );
  return result;
}

/** Read-only provider lookup of this operation's refund (by metadata.refundOperationId). */
export async function findProviderRefund(deps, op) {
  if (op.mode !== "stripe" || !op.stripeParams?.payment_intent) return null;
  const list = await deps.getStripe().refunds.list({ payment_intent: op.stripeParams.payment_intent, limit: 100 });
  return (list?.data || []).find((r) => r?.metadata?.refundOperationId === String(op._id)) || null;
}

/**
 * Resolve a claimed submitting / uncertain operation. Inside the idempotency window: replay the
 * SAME create (same key, same params) - Stripe returns the original refund if it executed, else
 * executes it now. Outside: read-only lookup only; not found -> stays uncertain (manual review).
 */
async function resolveClaimed(deps, claimed, token, now = new Date()) {
  const submittedAt = new Date(claimed.submittedAt || claimed.createdAt).getTime();
  if (now.getTime() - submittedAt <= STRIPE_IDEMPOTENCY_REPLAY_WINDOW_MS) {
    let refund;
    try {
      refund = await callProvider(deps, claimed);
    } catch (err) {
      return handleProviderFailure(deps, claimed, token, err);
    }
    const done = await cas(deps, claimed, { from: ["submitting", "uncertain"], to: "succeeded", owner: token, set: { stripeRefundId: refund.id, stripeChargeId: refund.charge || null, resolvedAt: new Date(), lease: null }, note: "resolved_by_idempotent_replay" });
    if (!done) throw opError(409, "REFUND_OPERATION_SUPERSEDED", "Refund operation changed during resolution");
    return finalizeOperation(deps, claimed._id, claimed.tenantId);
  }
  const found = await findProviderRefund(deps, claimed);
  if (found) {
    const done = await cas(deps, claimed, { from: ["submitting", "uncertain"], to: "succeeded", owner: token, set: { stripeRefundId: found.id, stripeChargeId: found.charge || null, resolvedAt: new Date(), lease: null }, note: "resolved_by_provider_lookup" });
    if (!done) throw opError(409, "REFUND_OPERATION_SUPERSEDED", "Refund operation changed during resolution");
    return finalizeOperation(deps, claimed._id, claimed.tenantId);
  }
  await cas(deps, claimed, { from: ["submitting", "uncertain"], to: "uncertain", owner: token, set: { lease: null }, note: "manual_review_required" });
  throw opError(409, "REFUND_OPERATION_NEEDS_REVIEW", "The refund outcome cannot be established automatically; finance review required", { operationId: String(claimed._id) });
}

/** An identical client retry of an existing operation. */
export async function replayOperation(deps, existing, fingerprint) {
  if (existing.requestFingerprint && fingerprint && existing.requestFingerprint !== fingerprint) {
    throw opError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different refund request");
  }
  if (existing.state === "succeeded") return finalizeOperation(deps, existing._id, existing.tenantId);
  if (existing.state === "failed") {
    const e = existing.error || {};
    throw opError(e.http || 409, e.appCode || "REFUND_OPERATION_FAILED", "This refund request already failed", { operationId: String(existing._id) });
  }
  if (existing.state === "submitting" || existing.state === "uncertain") {
    const token = newToken();
    const claimed = await claim(deps, existing, token);
    if (!claimed) throw opError(409, "REFUND_OPERATION_IN_PROGRESS", "Refund operation is still being processed", { operationId: String(existing._id) });
    return resolveClaimed(deps, claimed, token);
  }
  throw opError(409, "REFUND_OPERATION_IN_PROGRESS", "Refund operation is already being processed", { operationId: String(existing._id) });
}

// ---------------------------------------------------------------- observed (out-of-band) refunds
/**
 * Stripe refunds seen by the webhook. A refund carrying metadata.refundOperationId belongs to
 * that operation (completed through it, exactly once). Any other refund (dashboard, Stripe
 * support) is recorded once per Stripe refund id as a succeeded "stripe_observed" operation, so
 * the payment's remaining amount and the credit its journal debits are not overstated.
 * Not capped: the money has already left.
 */
export async function recordObservedProviderRefunds(deps, payment, refunds = []) {
  const out = [];
  await initCommitted(deps, payment.tenantId, payment._id); // before any new Refund row exists
  for (const r of refunds) {
    if (!r?.id || !["succeeded", "pending"].includes(String(r.status || "succeeded"))) continue;
    if (!Number.isInteger(Number(r.amount)) || Number(r.amount) <= 0) {
      out.push({ refundId: r.id, result: "skipped_no_amount" }); // cannot be recorded without its amount
      continue;
    }
    const ownOpId = r?.metadata?.refundOperationId;
    if (ownOpId && mongoose.Types.ObjectId.isValid(ownOpId)) {
      const op = await deps.RefundOperation.findOne({ _id: ownOpId, tenantId: payment.tenantId }, null, { lean: true });
      if (op) {
        out.push({ refundId: r.id, operationId: String(op._id), result: await completeOwnFromObservation(deps, op, r) });
        continue;
      }
    }
    const known = await deps.Refund.findOne({ tenantId: payment.tenantId, "stripe.refundId": r.id }, null, { lean: true });
    const knownOp = known ? null : await deps.RefundOperation.findOne({ tenantId: payment.tenantId, stripeRefundId: r.id }, null, { lean: true });
    if (known || knownOp) {
      out.push({ refundId: r.id, result: "already_recorded" });
      continue;
    }
    let op;
    try {
      const created = await deps.RefundOperation.create({
        tenantId: payment.tenantId,
        source: "stripe_observed",
        flow: "OBSERVED",
        mode: "stripe",
        state: "succeeded",
        version: 0,
        paymentId: payment._id,
        memberKey: null,
        amount: Number(r.amount),
        currency: payment.currency || r.currency || "eur",
        clientKey: `stripe-refund:${r.id}`,
        stripeIdempotencyKey: `observed:${r.id}`,
        stripeParams: { payment_intent: payment.stripe?.paymentIntentId || null },
        stripeRefundId: r.id,
        stripeChargeId: typeof r.charge === "string" ? r.charge : r.charge?.id || null,
        createdBy: "stripe-webhook",
        resolvedAt: new Date(),
        history: [{ state: "succeeded", at: new Date(), note: "observed_out_of_band" }],
      });
      op = typeof created?.toObject === "function" ? created.toObject() : created;
    } catch (err) {
      if (!isDup(err)) throw err;
      op = await deps.RefundOperation.findOne({ tenantId: payment.tenantId, clientKey: `stripe-refund:${r.id}` }, null, { lean: true });
    }
    out.push({ refundId: r.id, operationId: String(op._id), result: await finalizeOperation(deps, op._id, payment.tenantId) });
  }
  return out;
}

async function completeOwnFromObservation(deps, op, refund) {
  if (op.state === "succeeded") return finalizeOperation(deps, op._id, op.tenantId);
  if (op.state === "failed") return "operation_failed_but_provider_refunded"; // surfaced for review
  // The provider shows this operation's refund: definitive evidence of execution. Complete it,
  // fenced on the version observed here; a live owner finishing concurrently simply wins.
  const done = await deps.RefundOperation.findOneAndUpdate(
    { _id: op._id, tenantId: op.tenantId, state: op.state, version: op.version },
    {
      $set: { state: "succeeded", stripeRefundId: refund.id, stripeChargeId: typeof refund.charge === "string" ? refund.charge : null, resolvedAt: new Date(), lease: null },
      $inc: { version: 1 },
      $push: { history: { state: "succeeded", at: new Date(), note: "resolved_by_webhook" } },
    },
    LEAN,
  );
  if (!done) return "owner_resolving";
  return finalizeOperation(deps, op._id, op.tenantId);
}

// ---------------------------------------------------------------- visibility / reconciliation
export const OPERATION_LIST_FIELDS = Object.freeze([
  "_id", "tenantId", "source", "flow", "mode", "state", "version", "paymentId", "memberKey", "amount", "currency",
  "stripeRefundId", "refundDocId", "paymentReservationHeld", "memberReservationHeld", "glStatus",
  "policy", "error", "createdBy", "createdAt", "submittedAt", "resolvedAt", "finalizedAt",
]);

function viewOp(op) {
  const out = {};
  for (const k of OPERATION_LIST_FIELDS) out[k === "_id" ? "id" : k] = op[k] ?? null;
  out.id = String(op._id);
  if (out.paymentId) out.paymentId = String(out.paymentId);
  if (out.refundDocId) out.refundDocId = String(out.refundDocId);
  out.leaseExpiresAt = op.lease?.expiresAt || null;
  return out;
}

const UNRESOLVED = { $or: [{ state: { $in: ACTIVE_STATES } }, { state: "succeeded", finalizedAt: { $exists: false } }] };

export async function listUnresolvedOperations(deps, tenantId, { limit = 100 } = {}) {
  const rows = await deps.RefundOperation.find(
    { tenantId, ...UNRESOLVED },
    null,
    { lean: true, sort: { createdAt: -1 }, limit: Math.min(Math.max(Number(limit) || 100, 1), 500) },
  );
  return rows.map(viewOp);
}

function planFor(op, now) {
  if (op.state === "succeeded") return "finalize";
  if (op.lease?.expiresAt && new Date(op.lease.expiresAt) > now) return "leave_owned";
  if (op.state === "reserved") return "release_never_submitted";
  const age = now.getTime() - new Date(op.submittedAt || op.createdAt).getTime();
  return age <= STRIPE_IDEMPOTENCY_REPLAY_WINDOW_MS ? "replay_idempotent_create" : "lookup_or_review";
}

/**
 * Reconciliation. Dry-run (default) only reports the plan (no provider writes; a read-only lookup
 * is shown for submitting / uncertain operations). apply: true is an explicit finance action: each
 * operation is first CAS-claimed (one reconciler wins), then:
 *   finalize                 - succeeded but unfinished: idempotent finalize
 *   release_never_submitted  - reserved with an expired lease: the claim fenced the old owner off
 *                              before it could submit -> definitive non-execution -> failed + release
 *   replay_idempotent_create - same key, same params inside Stripe's idempotency window
 *   lookup_or_review         - outside the window: found -> complete; not found -> stays uncertain
 *   leave_owned              - a live owner holds the lease: untouched
 */
export async function reconcileRefundOperations(deps, { tenantId, apply = false, operationIds = null, actor = null, now = new Date() } = {}) {
  if (!tenantId) throw opError(401, "UNAUTHORIZED", "Tenant context required");
  const filter = { tenantId, ...UNRESOLVED };
  if (Array.isArray(operationIds) && operationIds.length) filter._id = { $in: operationIds };
  const ops = await deps.RefundOperation.find(filter, null, { lean: true, sort: { createdAt: 1 }, limit: 200 });
  const out = [];
  for (const op of ops) {
    const row = { operationId: String(op._id), state: op.state, flow: op.flow, amount: op.amount, plan: planFor(op, now) };
    try {
      if (!apply) {
        if (row.plan === "replay_idempotent_create" || row.plan === "lookup_or_review") {
          const found = await findProviderRefund(deps, op);
          row.providerRefundFound = Boolean(found);
        }
      } else if (row.plan === "finalize") {
        await finalizeOperation(deps, op._id, tenantId);
        row.applied = true;
      } else if (row.plan !== "leave_owned") {
        const token = newToken();
        const claimed = await claim(deps, op, token);
        if (!claimed) {
          row.plan = "claimed_elsewhere";
        } else if (row.plan === "release_never_submitted") {
          const failed = await cas(deps, claimed, { from: "reserved", to: "failed", owner: token, set: { error: { http: 409, appCode: "REFUND_NOT_EXECUTED", evidence: "never_submitted_fenced" }, resolvedAt: new Date(), lease: null }, note: "reconcile:never_submitted_fenced", actor });
          if (failed) await releaseAll(deps, failed);
          row.applied = Boolean(failed);
        } else {
          try {
            await resolveClaimed(deps, claimed, token, now);
            row.applied = true;
            row.outcome = "succeeded";
          } catch (err) {
            row.applied = true;
            row.outcome = String(err?.code || "error");
          }
        }
      }
    } catch (err) {
      row.error = String(err?.code || err?.message || err).slice(0, 120);
    }
    out.push(row);
  }
  return { apply: Boolean(apply), operations: out };
}

/**
 * Explicit, audited finance release of an operation whose execution cannot be established
 * (e.g. uncertain beyond the idempotency window and not found at the provider). Requires the
 * actor and written evidence; refused while the provider shows a refund for the operation, or
 * while a live owner holds it.
 */
export async function releaseOperationManually(deps, { tenantId, operationId, actor, evidence }) {
  if (!actor) throw opError(401, "UNAUTHORIZED", "Actor required");
  if (typeof evidence !== "string" || evidence.trim().length < 10) {
    throw opError(400, "REFUND_RELEASE_EVIDENCE_REQUIRED", "A written reason / evidence (min 10 characters) is required");
  }
  const op = await deps.RefundOperation.findOne({ _id: operationId, tenantId }, null, { lean: true });
  if (!op) throw opError(404, "REFUND_OPERATION_NOT_FOUND", "Refund operation not found");
  if (!ACTIVE_STATES.includes(op.state)) throw opError(409, "REFUND_OPERATION_NOT_ACTIVE", "Only unresolved operations can be released", { state: op.state });
  const found = await findProviderRefund(deps, op);
  if (found) throw opError(409, "REFUND_EXISTS_AT_PROVIDER", "The provider shows a refund for this operation; reconcile it instead of releasing", { stripeRefundId: found.id });
  const token = newToken();
  const claimed = await claim(deps, op, token);
  if (!claimed) throw opError(409, "REFUND_OPERATION_IN_PROGRESS", "The operation is owned by a live worker");
  const failed = await cas(deps, claimed, {
    from: ACTIVE_STATES,
    to: "failed",
    owner: token,
    set: { error: { http: 409, appCode: "REFUND_RELEASED_BY_FINANCE", evidence: evidence.trim().slice(0, 1000), releasedBy: actor }, resolvedAt: new Date(), lease: null },
    note: "manual_release",
    actor,
  });
  if (!failed) throw opError(409, "REFUND_OPERATION_SUPERSEDED", "Refund operation changed during release");
  await releaseAll(deps, failed);
  return viewOp(failed);
}
