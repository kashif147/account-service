// Stripe webhook lifecycle handlers added for the payment lifecycle (D1-D6):
// checkout.session.completed/expired, refunds, capture_before, and the permanent-rejection
// record. The persisted Payment decides the tenant; Stripe metadata is only a claim.
import Payment from "../models/payment.model.js";
import StripeEventRejection from "../models/stripeEventRejection.model.js";
import { getStripe } from "../lib/stripe.js";
import logger from "../config/logger.js";
import {
  paymentDataFromIntent,
  reconcileStripeEvent,
  enqueueLinkPaymentStatus,
} from "./payments.service.js";
import { nextPaymentStatus, refundStatusFromCharge, stateMachineMode } from "./paymentStateMachine.js";

const DEFAULT_HOLD_DAYS = 7;
let stripeOverride = null;
/** Test seam. */
export function setLifecycleStripe(client) {
  stripeOverride = client;
}
const stripe = () => stripeOverride || getStripe();

/** Record a verified event that can never be applied. Ids only. */
export async function recordStripeRejection(event, reason, extra = {}) {
  try {
    await StripeEventRejection.updateOne(
      { stripeEventId: event.id },
      {
        $setOnInsert: {
          stripeEventId: event.id,
          eventType: event.type,
          reason,
          objectId: event?.data?.object?.id || null,
          paymentId: extra.paymentId ? String(extra.paymentId) : null,
          tenantId: extra.tenantId ? String(extra.tenantId) : null,
        },
        $inc: { occurrences: 1 },
      },
      { upsert: true },
    );
  } catch (err) {
    logger.error({ stripeEventId: event.id, reason, error: err.message }, "Failed to record Stripe event rejection");
    throw err; // transient: let Stripe retry
  }
  logger.warn(
    { stripeEventId: event.id, eventType: event.type, reason, paymentId: extra.paymentId || null },
    "Stripe event permanently rejected",
  );
}

function metadataTenant(obj) {
  const m = obj?.metadata || {};
  return m.tenantId || m.tenant_id || m.tenant || null;
}

/** capture_before from an expanded/inline charge, else retrieve the charge, else created + 7 days. */
export async function resolveCapturableUntil(pi) {
  const fromCharge = (charge) => charge?.payment_method_details?.card?.capture_before;
  let ts =
    (typeof pi.latest_charge === "object" ? fromCharge(pi.latest_charge) : null) ||
    fromCharge(pi.charges?.data?.[0]);
  if (!ts) {
    const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.charges?.data?.[0]?.id;
    if (chargeId) {
      try {
        ts = fromCharge(await stripe().charges.retrieve(chargeId));
      } catch (err) {
        logger.warn({ paymentIntentId: pi.id, error: err.message }, "capture_before lookup failed; using 7-day default");
      }
    }
  }
  if (ts) return new Date(ts * 1000);
  const created = pi.created ? pi.created * 1000 : Date.now();
  return new Date(created + DEFAULT_HOLD_DAYS * 24 * 3600 * 1000);
}

function intentPayload(pi) {
  const data = paymentDataFromIntent({
    ...pi,
    latest_charge: typeof pi.latest_charge === "object" ? pi.latest_charge?.id : pi.latest_charge,
  });
  return data;
}

/**
 * checkout.session.completed: link the session's PaymentIntent to the Payment created for the
 * session, then apply the PaymentIntent's CURRENT status (re-read from Stripe, so the order in
 * which Stripe delivers session and PaymentIntent events does not matter).
 */
export async function handleCheckoutSessionCompleted(event, hooks = {}) {
  const session = event.data.object;
  const payment = await Payment.findOne({ "stripe.checkoutSessionId": session.id }).lean();
  if (!payment) return { ok: false, rejected: "unknown_checkout_session" };
  const claim = metadataTenant(session);
  if (claim && String(claim) !== String(payment.tenantId)) {
    return { ok: false, rejected: "tenant_mismatch", paymentId: payment._id, tenantId: payment.tenantId };
  }
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!piId) return { ok: true, noop: "no_payment_intent" };
  if (payment.stripe?.paymentIntentId && payment.stripe.paymentIntentId !== piId) {
    return { ok: false, rejected: "session_intent_mismatch", paymentId: payment._id, tenantId: payment.tenantId };
  }
  if (!payment.stripe?.paymentIntentId) {
    await Payment.updateOne(
      { _id: payment._id, tenantId: payment.tenantId, "stripe.paymentIntentId": { $in: [null] } },
      { $set: { "stripe.paymentIntentId": piId } },
    );
  }
  const pi = await stripe().paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
  const data = intentPayload(pi);
  if (data.status === "requires_capture") data.capturableUntil = await resolveCapturableUntil(pi);
  data.occurredAt = new Date((event.created || Math.floor(Date.now() / 1000)) * 1000);
  const result = await reconcileStripeEvent(
    { eventId: event.id, type: event.type, payment: data },
    { metadataTenantId: claim || undefined, rethrowOnError: true },
  );
  if (hooks.afterCheckoutCompleted) await hooks.afterCheckoutCompleted(payment, pi, event);
  return result;
}

/**
 * checkout.session.expired: the payer never submitted a card. A Payment that never got a
 * PaymentIntent is closed as canceled; one with a PaymentIntent is governed by its PI events.
 */
export async function handleCheckoutSessionExpired(event, hooks = {}) {
  const session = event.data.object;
  const payment = await Payment.findOne({ "stripe.checkoutSessionId": session.id }).lean();
  if (!payment) return { ok: false, rejected: "unknown_checkout_session" };
  const claim = metadataTenant(session);
  if (claim && String(claim) !== String(payment.tenantId)) {
    return { ok: false, rejected: "tenant_mismatch", paymentId: payment._id, tenantId: payment.tenantId };
  }
  if (!payment.stripe?.paymentIntentId) {
    const decision = nextPaymentStatus(payment.status, "canceled");
    await Payment.updateOne(
      { _id: payment._id, tenantId: payment.tenantId, webhookEventIds: { $ne: event.id } },
      {
        $set: {
          status: decision.status,
          "stripe.status": "expired",
          "stripe.cancellationReason": "checkout_session_expired",
          "stripe.latestEventId": event.id,
          "stripe.latestEventType": event.type,
        },
        $addToSet: { webhookEventIds: event.id },
        $push: {
          auditHistory: {
            $each: [{ eventId: event.id, eventType: event.type, status: decision.status, stripeStatus: "expired", receivedAt: new Date() }],
            $slice: -100,
          },
        },
      },
    );
  }
  if (hooks.afterCheckoutExpired) await hooks.afterCheckoutExpired(payment, session, event);
  return { ok: true };
}

/**
 * charge.refunded / charge.refund.updated / refund.updated. Legacy ignores these events, so in
 * shadow mode only the decision is logged for existing payments; link payments (and
 * authoritative mode) apply the status. No ledger posting here: refunds created through
 * POST /refunds keep their own GL path.
 */
export async function handleRefundEvent(event) {
  const obj = event.data.object;
  let charge = obj.object === "charge" ? obj : null;
  if (!charge) {
    const chargeId = typeof obj.charge === "string" ? obj.charge : obj.charge?.id;
    if (!chargeId) return { ok: true, noop: "no_charge" };
    charge = await stripe().charges.retrieve(chargeId);
  }
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return { ok: true, noop: "no_payment_intent" };
  const payment = await Payment.findOne({ "stripe.paymentIntentId": piId }).lean();
  if (!payment) return { ok: false, rejected: "unknown_payment_intent" };
  const claim = metadataTenant(charge);
  if (claim && String(claim) !== String(payment.tenantId)) {
    return { ok: false, rejected: "tenant_mismatch", paymentId: payment._id, tenantId: payment.tenantId };
  }
  const refundStatus = refundStatusFromCharge(charge);
  if (!refundStatus) return { ok: true, noop: "no_refund_amount" };
  const machine = nextPaymentStatus(payment.status, refundStatus);
  const authoritative = Boolean(payment.paymentLinkId) || stateMachineMode() === "authoritative";
  if (machine.status !== payment.status) {
    logger.warn(
      {
        paymentId: String(payment._id),
        eventId: event.id,
        eventType: event.type,
        current: payment.status,
        legacyDecision: payment.status,
        machineDecision: machine.status,
        machineReason: machine.reason,
        authoritative: authoritative ? "state-machine" : "legacy",
      },
      "Payment state machine disagrees with legacy webhook status",
    );
  }
  if (!authoritative || !machine.applied) return { ok: true, applied: false };
  const res = await Payment.findOneAndUpdate(
    { _id: payment._id, tenantId: payment.tenantId, webhookEventIds: { $ne: event.id } },
    {
      $set: { status: machine.status, "stripe.latestEventId": event.id, "stripe.latestEventType": event.type },
      $addToSet: { webhookEventIds: event.id },
      $push: {
        auditHistory: {
          $each: [{ eventId: event.id, eventType: event.type, status: machine.status, receivedAt: new Date() }],
          $slice: -100,
        },
      },
    },
    { new: true },
  ).lean();
  await enqueueLinkPaymentStatus(res || { ...payment, status: machine.status }, {
    eventId: event.id,
    eventKeySuffix: `refund:${charge.amount_refunded}`,
    refund: { amountRefunded: charge.amount_refunded },
  });
  return { ok: true, applied: true };
}
