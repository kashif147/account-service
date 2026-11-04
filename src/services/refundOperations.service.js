// P5 durable refund operations: ONE balance / reservation mechanism for every path that creates
// Stripe refunds or Refund rows against a Payment (CRM POST /payments/refunds and the
// events.event.cancelled.v1 automatic refund), plus member-level credit reservations.
//
// State machine (RefundOperation.state):
//   reserved   - operation persisted, payment (and member) reservations held; provider NOT called
//   submitting - persisted immediately BEFORE the provider call (Stripe idempotency key derived
//                from the operation id)
//   succeeded  - provider (or external record) succeeded; finalize() then writes the Refund row,
//                commits the payment counter, posts GL and releases the member reservation,
//                each step exactly once / idempotent
//   failed     - definitive provider failure, or non-execution established; reservations released
//   uncertain  - timeout / network / 5xx: outcome unknown, reservations STAY held until
//                reconciliation (read-only provider lookup) resolves it
//
// Exactly-once without multi-document transactions (DEV/test mongod is standalone):
//   Payment.refundReservations holds {opId, amount}; commit = one conditional update that pulls
//   that opId AND increments refundCommittedCents (only if the opId is still reserved), so it
//   applies once; Refund rows are unique per (tenantId, refundOperationId).
import mongoose from "mongoose";
import PaymentModel from "../models/payment.model.js";
import RefundModel from "../models/refund.model.js";
import RefundOperationModel from "../models/refundOperation.model.js";
import MemberRefundReservationModel from "../models/memberRefundReservation.model.js";
import { getStripe as realGetStripe } from "../lib/stripe.js";
import { AppError } from "../errors/AppError.js";

export const ACTIVE_STATES = Object.freeze(["reserved", "submitting", "uncertain"]);
export const REFUNDABLE_PAYMENT_STATUSES = Object.freeze(["succeeded", "partially_refunded"]);

/** Test-only fault injection (simulated process crash); never set in production code paths. */
export const refundOpsHooks = { afterReserve: null, afterStripe: null };

/** Per-source behaviour needed to finish an operation later (retry / reconciliation). */
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

function opError(status, code, message, extras = {}) {
  return new AppError(message, status, code, extras);
}

async function sumRefundRows(deps, tenantId, paymentId) {
  const agg = await deps.Refund.aggregate([
    { $match: { tenantId, paymentId } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return Number(agg?.[0]?.total) || 0;
}

/** definitive: the provider refused; uncertain: the outcome is unknown (never released). */
export function classifyProviderError(err) {
  const type = String(err?.type || err?.rawType || "");
  const status = Number(err?.statusCode || err?.status || 0);
  if (["StripeCardError", "StripeInvalidRequestError", "StripePermissionError", "StripeAuthenticationError", "StripeIdempotencyError"].includes(type)) {
    return "definitive";
  }
  if ([400, 401, 402, 403, 404].includes(status)) return "definitive";
  return "uncertain";
}

// ---------------------------------------------------------------- payment-level reservation
async function initCommitted(deps, payment) {
  const rows = await sumRefundRows(deps, payment.tenantId, payment._id);
  await deps.Payment.updateOne(
    { _id: payment._id, tenantId: payment.tenantId, refundCommittedCents: { $exists: false } },
    { $set: { refundCommittedCents: rows } },
  );
  return rows;
}

/** Atomic: admits `amount` only while committed + reserved + amount <= captured amount. */
export async function reservePayment(deps, payment, opId, amount) {
  await initCommitted(deps, payment);
  return deps.Payment.findOneAndUpdate(
    {
      _id: payment._id,
      tenantId: payment.tenantId,
      status: { $in: REFUNDABLE_PAYMENT_STATUSES },
      "refundReservations.opId": { $ne: opId },
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
  await initCommitted(deps, payment);
  const fresh = await deps.Payment.findOne({ _id: payment._id, tenantId: payment.tenantId }, null, { lean: true });
  if (!fresh) return 0;
  const reserved = (fresh.refundReservations || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return Math.max(0, (Number(fresh.amount) || 0) - (Number(fresh.refundCommittedCents) || 0) - reserved);
}

async function commitPayment(deps, op) {
  if (!op.paymentId) return;
  await deps.Payment.updateOne(
    { _id: op.paymentId, tenantId: op.tenantId, "refundReservations.opId": op._id },
    { $pull: { refundReservations: { opId: op._id } }, $inc: { refundCommittedCents: op.amount } },
  );
}

async function releasePayment(deps, op) {
  if (!op.paymentId) return;
  await deps.Payment.updateOne(
    { _id: op.paymentId, tenantId: op.tenantId },
    { $pull: { refundReservations: { opId: op._id } } },
  );
}

// ---------------------------------------------------------------- member-level reservation
/**
 * Atomic, tenant-scoped member credit reservation keyed by the authoritative ledger key.
 * `available()` reads the member's refundable credit from the GL (MaterializedBalance). The
 * conditional push admits the amount only while (sum of in-flight reservations + amount) <=
 * available; a post-check re-reads the credit so a refund that completed meanwhile is counted
 * (an in-flight refund whose GL already posted is briefly counted twice: conservative).
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
    if (!isDup(err)) throw err; // concurrent first insert: the document exists now
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

// ---------------------------------------------------------------- operation lifecycle
async function transition(deps, op, from, to, set = {}, note) {
  return deps.RefundOperation.findOneAndUpdate(
    { _id: op._id, tenantId: op.tenantId, state: { $in: [].concat(from) } },
    { $set: { state: to, ...set }, $push: { history: { state: to, at: new Date(), ...(note ? { note } : {}) } } },
    LEAN,
  );
}

async function releaseAll(deps, op) {
  await releasePayment(deps, op);
  if (op.memberReservationHeld) await releaseMember(deps, { tenantId: op.tenantId, memberKey: op.memberKey, opId: op._id });
  await deps.RefundOperation.updateOne(
    { _id: op._id, tenantId: op.tenantId },
    { $set: { paymentReservationHeld: false, memberReservationHeld: false } },
  );
}

async function markFailed(deps, op, error, note) {
  const failed = await transition(deps, op, ACTIVE_STATES, "failed", { error, resolvedAt: new Date() }, note);
  if (failed) await releaseAll(deps, failed);
  return failed;
}

/**
 * Persist the operation, then take the reservations. Returns { op } for a new operation or
 * { existing } when the client key was already used (identical retry / concurrent duplicate).
 * spec: { tenantId, source, flow, mode, payment, amount, currency, clientKey, fingerprint,
 *         memberKey, memberAvailable (async fn | null), stripeParams, refundTemplate, glContext,
 *         policy, createdBy }
 */
export async function startOperation(deps, spec) {
  const { tenantId, clientKey } = spec;
  if (clientKey) {
    const existing = await deps.RefundOperation.findOne({ tenantId, clientKey }, null, { lean: true });
    if (existing) return { existing };
  }
  const _id = new mongoose.Types.ObjectId();
  let op;
  try {
    op = await deps.RefundOperation.create({
      _id,
      tenantId,
      source: spec.source,
      flow: spec.flow,
      mode: spec.mode,
      state: "reserved",
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

  // Reservations; on refusal nothing was executed -> the operation record is removed.
  const abandon = async (error) => {
    await releasePayment(deps, op);
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
      await abandon(opError(409, "REFUND_MEMBER_CREDIT_UNAVAILABLE", "Refund exceeds the member's available refundable credit (or another refund is in progress)", { refundCents: op.amount, availableCreditCents: m.available }));
    }
    await deps.RefundOperation.updateOne({ _id: op._id, tenantId }, { $set: { memberReservationHeld: true } });
    op.memberReservationHeld = true;
  }
  if (refundOpsHooks.afterReserve) await refundOpsHooks.afterReserve(op);
  return { op };
}

/** Run the provider step (if any) then finalize. Throws AppError on failure / uncertainty. */
export async function executeOperation(deps, op) {
  if (op.mode === "stripe" && op.stripeParams?.payment_intent) {
    const submitting = await transition(deps, op, "reserved", "submitting", { submittedAt: new Date() });
    if (!submitting) throw opError(409, "REFUND_OPERATION_IN_PROGRESS", "Refund operation is already being processed", { operationId: String(op._id) });
    let refund;
    try {
      refund = await deps.getStripe().refunds.create(
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
    } catch (err) {
      if (crashOf(err)) throw err;
      const kind = classifyProviderError(err);
      const providerError = { status: Number(err?.statusCode || 0) || null, code: err?.code || null, providerType: err?.type || null, message: String(err?.message || "").slice(0, 300) };
      if (kind === "definitive") {
        await markFailed(deps, op, { ...providerError, http: 502, appCode: "REFUND_PROVIDER_REJECTED" }, "provider_rejected");
        throw opError(502, "REFUND_PROVIDER_REJECTED", "The payment provider rejected the refund", { operationId: String(op._id), providerCode: providerError.code });
      }
      await transition(deps, op, "submitting", "uncertain", { error: providerError }, "provider_outcome_unknown");
      throw opError(503, "REFUND_OUTCOME_UNCERTAIN", "The refund outcome is not known yet; it is held for reconciliation", { operationId: String(op._id) });
    }
    if (refundOpsHooks.afterStripe) await refundOpsHooks.afterStripe(op, refund);
    await transition(deps, op, ["submitting", "uncertain"], "succeeded", {
      stripeRefundId: refund.id,
      stripeChargeId: refund.charge || op.stripeParams.charge || null,
      resolvedAt: new Date(),
    });
  } else {
    // External payout record, or a GL-only record of a refund made outside the API.
    await transition(deps, op, "reserved", "succeeded", { resolvedAt: new Date() });
  }
  return finalizeOperation(deps, op._id, op.tenantId);
}

/** Idempotent completion of a succeeded operation. Safe to call any number of times. */
export async function finalizeOperation(deps, opId, tenantId) {
  let op = await deps.RefundOperation.findOne({ _id: opId, tenantId }, null, { lean: true });
  if (!op) throw opError(404, "REFUND_OPERATION_NOT_FOUND", "Refund operation not found");
  if (op.state !== "succeeded") throw opError(409, "REFUND_OPERATION_NOT_SUCCEEDED", "Refund operation has not succeeded", { state: op.state });
  if (op.finalizedAt && op.result) return op.result;
  const handler = sources.get(op.source);
  if (!handler) throw opError(500, "REFUND_SOURCE_UNREGISTERED", `No refund handler for source ${op.source}`);

  // 1. Refund row (exactly one per operation).
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

  // 2. Payment counter: reserved -> committed (applies once), status from cumulative rows.
  await commitPayment(deps, op);
  if (op.paymentId) {
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

  // 3. GL (idempotent per refund docNo). The member credit reservation is released only once
  //    the GL refund journal (which reduces the member's credit) is posted.
  let gl = { glPosted: refundDoc.glStatus === "posted", glDocNo: refundDoc.glDocNo || null };
  if (!gl.glPosted) gl = await handler.postGl(op, refundDoc, deps);
  if (gl.glPosted && op.memberReservationHeld) {
    await releaseMember(deps, { tenantId, memberKey: op.memberKey, opId: op._id });
  }
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

async function completeFromProvider(deps, op, refund) {
  await transition(deps, op, ["submitting", "uncertain", "reserved"], "succeeded", {
    stripeRefundId: refund.id,
    stripeChargeId: refund.charge || null,
    resolvedAt: new Date(),
  }, "recovered_from_provider");
  return finalizeOperation(deps, op._id, op.tenantId);
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
    const found = await findProviderRefund(deps, existing);
    if (found) return completeFromProvider(deps, existing, found);
    throw opError(409, "REFUND_OPERATION_UNRESOLVED", "The earlier refund attempt is unresolved; reconcile it before retrying", { operationId: String(existing._id), state: existing.state });
  }
  throw opError(409, "REFUND_OPERATION_IN_PROGRESS", "Refund operation is already being processed", { operationId: String(existing._id) });
}

export const OPERATION_LIST_FIELDS = Object.freeze([
  "_id", "tenantId", "source", "flow", "mode", "state", "paymentId", "memberKey", "amount", "currency",
  "stripeRefundId", "refundDocId", "paymentReservationHeld", "memberReservationHeld", "glStatus",
  "policy", "error", "createdBy", "createdAt", "submittedAt", "resolvedAt", "finalizedAt",
]);

function viewOp(op) {
  const out = {};
  for (const k of OPERATION_LIST_FIELDS) out[k === "_id" ? "id" : k] = op[k] ?? null;
  out.id = String(op._id);
  if (out.paymentId) out.paymentId = String(out.paymentId);
  if (out.refundDocId) out.refundDocId = String(out.refundDocId);
  return out;
}

/** Unresolved = active, or succeeded but not finalized (GL / member reservation pending). */
export async function listUnresolvedOperations(deps, tenantId, { limit = 100 } = {}) {
  const rows = await deps.RefundOperation.find(
    { tenantId, $or: [{ state: { $in: ACTIVE_STATES } }, { state: "succeeded", finalizedAt: { $exists: false } }] },
    null,
    { lean: true, sort: { createdAt: -1 }, limit: Math.min(Math.max(Number(limit) || 100, 1), 500) },
  );
  return rows.map(viewOp);
}

/**
 * Reconciliation (dry-run unless apply === true). Per unresolved operation, the plan is derived
 * from a READ-ONLY provider lookup:
 *   succeeded, not finalized            -> finalize (Refund row / counters / GL, idempotent)
 *   provider refund found               -> complete (record + finalize exactly once)
 *   reserved (provider never called)    -> release_not_executed (after minAgeMs)
 *   submitting/uncertain, none found    -> mark_failed_not_found only after minAgeMs, else leave
 * Nothing is cleared without that evidence; provider lookup errors leave the operation as is.
 */
export async function reconcileRefundOperations(deps, { tenantId, apply = false, operationIds = null, minAgeMs = 10 * 60 * 1000, now = new Date() } = {}) {
  if (!tenantId) throw opError(401, "UNAUTHORIZED", "Tenant context required");
  const filter = { tenantId, $or: [{ state: { $in: ACTIVE_STATES } }, { state: "succeeded", finalizedAt: { $exists: false } }] };
  if (Array.isArray(operationIds) && operationIds.length) filter._id = { $in: operationIds };
  const ops = await deps.RefundOperation.find(filter, null, { lean: true, sort: { createdAt: 1 }, limit: 200 });
  const out = [];
  for (const op of ops) {
    const age = now.getTime() - new Date(op.submittedAt || op.createdAt).getTime();
    const row = { operationId: String(op._id), state: op.state, flow: op.flow, amount: op.amount, plan: "leave" };
    try {
      if (op.state === "succeeded") {
        row.plan = "finalize";
      } else {
        const found = await findProviderRefund(deps, op);
        if (found) {
          row.plan = "complete";
          row.stripeRefundId = found.id;
          row._found = found;
        } else if (age >= minAgeMs) {
          row.plan = op.state === "reserved" ? "release_not_executed" : "mark_failed_not_found";
        }
      }
      if (apply && row.plan !== "leave") {
        if (row.plan === "finalize") await finalizeOperation(deps, op._id, tenantId);
        else if (row.plan === "complete") await completeFromProvider(deps, op, row._found);
        else {
          await markFailed(deps, op, { http: 409, appCode: "REFUND_NOT_EXECUTED", message: row.plan }, `reconcile:${row.plan}`);
        }
        row.applied = true;
      }
    } catch (err) {
      row.plan = "leave";
      row.error = String(err?.code || err?.message || err).slice(0, 120);
    }
    delete row._found;
    out.push(row);
  }
  return { apply: Boolean(apply), operations: out };
}
