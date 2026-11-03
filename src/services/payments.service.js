import mongoose from "mongoose";
import nodeCrypto from "crypto";
import { requireTenantId } from "../helpers/tenantScope.js";
import Payment, {
  zCreateIntent,
  zReconcile,
  zReconcileRequest,
  zRecordExternal,
} from "../models/payment.model.js";
import Refund, { zCreateRefund } from "../models/refund.model.js";
import PaymentIntentReservation, { ORPHAN_STATES } from "../models/paymentIntentReservation.model.js";
import { AppError } from "../errors/AppError.js";
import { boundAuditEntry, stripeIdempotencyKey } from "./paymentBoundCommand.service.js";
import { getStripe } from "../lib/stripe.js";
import { publishDomainEvent, APPLICATION_EVENTS } from "../rabbitMQ/index.js";
import {
  assertRefundWithinCredit,
  getClaimRecipientMemberIdForApplication,
} from "./refundCredit.service.js";
import { centsToEuros } from "../helpers/money.js";
import { assertIntentAuthorized, isPortalLikeCaller } from "./paymentIntentGuard.service.js";
import {
  nextPaymentStatus,
  shadowComparison,
  stateMachineMode,
  applicationPaymentStatus,
} from "./paymentStateMachine.js";
import { enqueueOutboxEvent } from "./outbox.service.js";

function ensureIntegerCents(value) {
  if (!Number.isInteger(value)) {
    throw AppError.badRequest("Amount must be integer cents");
  }
}

function mapStripeStatusToDomain(status) {
  switch (status) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
      return "requires_action";
    case "requires_capture":
      return "requires_capture";
    case "processing":
      return "processing";
    case "succeeded":
      return "succeeded";
    case "canceled":
      return "canceled";
    default:
      return "processing";
  }
}

function normalizeStripeStatusForPayment(status) {
  if (status === "canceled") return "canceled";
  if (status === "requires_capture") return "requires_capture";
  if (status === "succeeded") return "succeeded";
  return mapStripeStatusToDomain(status);
}

function canReuseDomainPaymentStatus(status) {
  return [
    "created",
    "requires_action",
    "requires_capture",
    "processing",
    "payment_required",
  ].includes(status);
}

function canReuseStripePaymentIntentStatus(status) {
  return [
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
    "requires_capture",
    "processing",
  ].includes(status);
}

function isExpiredAuthorization(pi) {
  const cancellationReason = pi?.cancellation_reason;
  return (
    pi?.status === "canceled" &&
    (cancellationReason === "abandoned" ||
      cancellationReason === "automatic" ||
      cancellationReason === "expired")
  );
}

function paymentIntentStatusToDomain(pi) {
  if (isExpiredAuthorization(pi)) return "authorization_expired";
  return normalizeStripeStatusForPayment(pi?.status);
}

function ledgerDomainForPurpose(purpose) {
  return purpose === "eventRegistration" || purpose === "courseRegistration"
    ? "events"
    : "membership";
}

/**
 * P5 (b7): the authoritative application binding written on a new Payment. Only when the portal
 * intent guard verified that the application exists in this tenant and belongs to the caller
 * (assertIntentAuthorized -> kind "application"). CRM / internal creations and member payments
 * get none, so a subscriptionFee row is never treated as an application payment by inference.
 */
export function applicationBindingOnCreate({ isApplicationPayment, applicationId, guard }) {
  const id = applicationId == null ? "" : String(applicationId).trim();
  if (!isApplicationPayment || !id || guard?.kind !== "application") return {};
  return { applicationBinding: id };
}

function isApplicationPaymentRequest({ purpose, applicationId, memberId }) {
  if (!applicationId) return false;
  if (purpose === "applicationFee") return true;
  return !memberId;
}

// Event/course registrations always authorize-then-capture now (deferred to
// CRM approval, same reason as application payments - see events-service's
// registration-flow.md) - independent of isApplicationPaymentRequest, which
// gates only the applicationId-specific isApplicationPayment branches
// (useCheckout, application-attempt idempotency keys) elsewhere in this file.
// resolveReusablePaymentAttempt() below DOES cover both applicationId- and
// registrationId-keyed payments - that reuse/supersede behavior is what lets
// events-service's retry-payment endpoint recover a registration whose
// PaymentIntent got stuck at requires_payment_method (the payer's card
// confirm never completed) instead of it being permanently uncapturable.
function isEventRegistrationPaymentRequest(purpose) {
  return purpose === "eventRegistration" || purpose === "courseRegistration";
}

// ---------------------------------------------------------------------------
// P5 payer binding (event/course intents).
//
// payer  = the VERIFIED creator of the intent (never body/metadata), set once at creation.
// target = what the intent pays for: the event/course (portal, before a Registration
//          exists) or the registration (events-service CRM / retry-payment intents).
// Reuse/dedupe lookups made for a portal-like caller are scoped to that payer, so intent
// creation can never hand back (or supersede) another payer's PaymentIntent/clientSecret.
// ---------------------------------------------------------------------------
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function normId(v) {
  return v == null ? "" : String(v).trim();
}

function entityTypeForPurpose(purpose) {
  return purpose === "courseRegistration" ? "course" : "event";
}

/** Verified payer of a new intent. Internal S2S calls carry no verified user. */
export function payerFromCaller(ctx = {}, caller = {}) {
  if (caller.internalRequest === true || ctx.internalRequest === true) {
    return { userId: null, userType: "INTERNAL" };
  }
  const userType = normId(caller.userType).toUpperCase() || null;
  return { userId: normId(ctx.userId) || null, userType };
}

/**
 * Effective payer user id of a stored Payment: payer.userId, or for a legacy row created
 * before the payer field existed, audit.createdBy.
 */
export function effectivePayerUserId(payment) {
  if (payment?.payer) return normId(payment.payer.userId);
  return normId(payment?.audit?.createdBy);
}

/** Mongo filter matching Payments whose effective payer is `userId` (incl. legacy rows). */
export function payerOwnerFilter(userId) {
  const uid = normId(userId);
  return {
    $or: [
      { "payer.userId": uid },
      { payer: { $exists: false }, "audit.createdBy": uid },
    ],
  };
}

function withAnd(query, extra) {
  if (!extra) return query;
  return { ...query, $and: [...(query.$and || []), extra] };
}

function bindingError(message, status, code) {
  return new AppError(message, status, code);
}

// ---------------------------------------------------------------------------
// P5 active registration binding (Payment.registrationBinding, unique per tenant).
//
// Exactly one Stripe Payment may hold a registration at a time. The holder is claimed
// atomically by the unique index - by createIntent for a registration-backed intent
// (events-service CRM create / retry-payment) and by attach-registration for a portal
// intent - so two different intents racing onto one registration cannot both win.
//
// The ONLY way a registration moves to another intent is the named replacement transition
// REPLACE_RELEASED_BINDING: the current holder is released (conditional update, so a
// concurrent release/claim cannot double-release) and only when it can no longer take
// money: a terminal unpaid status, or a superseded attempt that holds no funds.
// Funds-held holders (authorised / processing / captured) are never released here.
// ---------------------------------------------------------------------------
const TERMINAL_UNPAID_STATUSES = ["canceled", "failed", "authorization_expired", "payment_required"];
const FUNDS_HELD_STATUSES = ["requires_capture", "processing", "succeeded", "partially_refunded", "refund_required", "manual_review"];

// An external (manual/comp/invoice) row's "payment_required" means an invoice that was POSTED
// to the GL, not a dead card attempt, so a LIVE external row is never released by this generic
// filter (only a voided/cancelled one is dead). The only release of a live external row is the
// explicit MANUAL_TO_CARD transition below (an unposted "manual_review" record, cancelled in the
// same update).
// A voided/cancelled external record (status canceled/failed) holds nothing and is dead.
const EXTERNAL_DEAD_STATUSES = ["canceled", "failed"];

export function releasableBindingFilter() {
  return {
    $or: [
      { mode: "external", status: { $in: EXTERNAL_DEAD_STATUSES } },
      {
        mode: { $ne: "external" },
        $or: [
          { status: { $in: TERMINAL_UNPAID_STATUSES } },
          { isActiveAttempt: false, status: { $nin: FUNDS_HELD_STATUSES } },
        ],
      },
    ],
  };
}

/** In-memory mirror of releasableBindingFilter (same rules), for legacy-row candidate checks. */
export function isReleasableBindingRow(row = {}) {
  if (row.mode === "external") return EXTERNAL_DEAD_STATUSES.includes(row.status);
  if (TERMINAL_UNPAID_STATUSES.includes(row.status)) return true;
  return row.isActiveAttempt === false && !FUNDS_HELD_STATUSES.includes(row.status);
}

const UNPOSTED_MANUAL_FILTER = { mode: "external", status: "manual_review" };

/**
 * P5 legacy participation. Rows written before registrationBinding existed (legacy Stripe
 * rows, manual/comp/invoice records) carry registrationId but no binding, so the unique index
 * cannot see them. Before any claim on `registrationId`, its legacy holder is ADOPTED into the
 * same index: if nobody holds the binding and exactly one unbound row of the registration is
 * still live (not releasable), that row claims the binding with a conditional update - so it
 * then contends through the same unique index as every new row.
 * - several live unbound rows -> 409 REGISTRATION_BINDING_AMBIGUOUS (fail closed; nothing is
 *   guessed or written; CRM resolves by cancelling/voiding the wrong one);
 * - a concurrent adopter/claimer winning first is fine (E11000 / no-op), the caller's own
 *   claim then loses on the index as usual.
 * `excludeId`: the row the caller is itself about to bind (never adopted as someone else).
 */
export async function adoptLegacyRegistrationHolder({ tenantId, registrationId, excludeId = null }) {
  const reg = normId(registrationId);
  if (!tenantId || !reg) return { adopted: false };
  const holder = await Payment.findOne({ tenantId, registrationBinding: reg }).select({ _id: 1 }).lean();
  if (holder) return { adopted: false, holderId: holder._id };
  const rows = await Payment.find({
    tenantId,
    registrationId: reg,
    $or: [{ registrationBinding: { $exists: false } }, { registrationBinding: null }],
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select({ _id: 1, status: 1, isActiveAttempt: 1, mode: 1 })
    .lean();
  const live = rows.filter((r) => !isReleasableBindingRow(r));
  if (live.length === 0) return { adopted: false };
  if (live.length > 1) {
    throw bindingError(
      "This registration has more than one existing payment; it must be resolved in the CRM first",
      409,
      "REGISTRATION_BINDING_AMBIGUOUS",
    );
  }
  try {
    const r = await Payment.updateOne(
      {
        _id: live[0]._id,
        tenantId,
        registrationId: reg,
        $or: [{ registrationBinding: { $exists: false } }, { registrationBinding: null }],
      },
      { $set: { registrationBinding: reg, bindingAdoptedAt: new Date() } },
    );
    return { adopted: r.modifiedCount === 1, holderId: live[0]._id };
  } catch (e) {
    if (isBindingDuplicateKey(e)) return { adopted: false }; // someone claimed it first
    throw e;
  }
}

export function isBindingDuplicateKeyError(e) {
  return isBindingDuplicateKey(e);
}

function isBindingDuplicateKey(e) {
  if (!e || e.code !== 11000) return false;
  if (e.keyPattern && Object.prototype.hasOwnProperty.call(e.keyPattern, "registrationBinding")) return true;
  return /registrationBinding/.test(String(e.message || ""));
}

export function reservationStripeKey(reservationId) {
  return nodeCrypto
    .createHash("sha256")
    .update(["registration-intent-reservation", String(reservationId)].join("-"))
    .digest("hex")
    .substring(0, 64);
}

/**
 * Cancels a PaymentIntent that must never be used (it has no Payment row). Records the
 * orphan durably before calling Stripe; idempotent (Stripe cancel of a cancelled PI is
 * treated as done). Never touches a PaymentIntent that a Payment row references.
 */
export async function cancelOrphanedIntent({ stripe, reservationId, paymentIntentId, reason }) {
  if (reservationId) {
    await PaymentIntentReservation.updateOne(
      { _id: reservationId, state: { $in: ["reserved", "intent_created", "orphaned", "orphan_cancel_failed"] } },
      { $set: { state: "orphaned", orphanReason: reason, paymentIntentId } },
    );
  }
  const referenced = await Payment.findOne({ "stripe.paymentIntentId": paymentIntentId }).select({ _id: 1 }).lean();
  if (referenced) {
    if (reservationId) {
      await PaymentIntentReservation.updateOne(
        { _id: reservationId },
        { $set: { state: "bound", paymentId: String(referenced._id), orphanReason: null } },
      );
    }
    return { canceled: false, bound: true };
  }
  try {
    await stripe.paymentIntents.cancel(paymentIntentId, { cancellation_reason: "duplicate" });
    if (reservationId) {
      await PaymentIntentReservation.updateOne(
        { _id: reservationId },
        { $set: { state: "orphan_canceled", lastErrorCode: null }, $inc: { cancelAttempts: 1 } },
      );
    }
    return { canceled: true };
  } catch (e) {
    const alreadyCanceled = /canceled/i.test(String(e?.code || "")) || e?.raw?.payment_intent?.status === "canceled";
    if (reservationId) {
      await PaymentIntentReservation.updateOne(
        { _id: reservationId },
        {
          $set: {
            state: alreadyCanceled ? "orphan_canceled" : "orphan_cancel_failed",
            lastErrorCode: String(e?.code || e?.type || "stripe_error").slice(0, 64),
          },
          $inc: { cancelAttempts: 1 },
        },
      ).catch(() => {});
    }
    return { canceled: alreadyCanceled };
  }
}

/** True when `paymentIntentId` is a recorded orphan (must never be captured or attached). */
export async function isOrphanedIntent(paymentIntentId) {
  if (!paymentIntentId) return false;
  const r = await PaymentIntentReservation.findOne({ paymentIntentId, state: { $in: ORPHAN_STATES } })
    .select({ _id: 1 })
    .lean();
  return Boolean(r);
}

/**
 * Recovery sweep for reservations left open (process died between the reservation, Stripe and
 * Payment.create) or orphans whose cancel failed. For each: replay the Stripe create with the
 * SAME idempotency key and parameters (Stripe returns the original PaymentIntent if it was
 * created), then bind-check: a PaymentIntent a Payment row references is marked bound;
 * anything else is cancelled as an orphan. Never binds, captures or returns an orphan, and never
 * returns a client_secret. Not scheduled here: wiring into the cron runner is a separate,
 * reviewed change (see the P5 write-up).
 */
export async function sweepPaymentIntentReservations({ olderThanMs = 15 * 60 * 1000, limit = 100, stripe = getStripe(), now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const open = await PaymentIntentReservation.find({
    $or: [
      { state: { $in: ["reserved", "intent_created", "orphaned"] }, updatedAt: { $lte: cutoff } },
      { state: "orphan_cancel_failed" },
    ],
  })
    .limit(limit)
    .lean();
  const out = { scanned: open.length, bound: 0, canceled: 0, failed: 0 };
  for (const r of open) {
    let piId = r.paymentIntentId;
    if (!piId) {
      try {
        const replay = await stripe.paymentIntents.create(
          {
            amount: r.request.amount,
            currency: r.request.currency,
            payment_method_types: ["card"],
            capture_method: r.request.captureMethod,
            metadata: Object.fromEntries(Object.entries(r.request.metadata || {})),
          },
          { idempotencyKey: r.stripeIdempotencyKey },
        );
        piId = replay.id;
      } catch (e) {
        out.failed += 1;
        await PaymentIntentReservation.updateOne(
          { _id: r._id },
          { $set: { lastErrorCode: String(e?.code || e?.type || "stripe_error").slice(0, 64) } },
        ).catch(() => {});
        continue;
      }
    }
    const res = await cancelOrphanedIntent({ stripe, reservationId: r._id, paymentIntentId: piId, reason: r.orphanReason || "unfinished_creation" });
    if (res.bound) out.bound += 1;
    else if (res.canceled) out.canceled += 1;
    else out.failed += 1;
  }
  return out;
}

/**
 * Releases the current holder of `registrationId` if (and only if) it is releasable.
 * Returns { holder: null } when nobody holds it, { self: true } when `selfId` holds it,
 * { released: true } after a successful release, or { blocked: true, holderId } when the
 * holder still holds (or may still take) money.
 */
async function releaseRegistrationBinding({ tenantId, registrationId, selfId, reason, ctx = {}, allowManualToCard = false }) {
  const holder = await Payment.findOne({ tenantId, registrationBinding: registrationId })
    .select({ _id: 1, status: 1, isActiveAttempt: 1, mode: 1 })
    .lean();
  if (!holder) return { holder: null };
  if (selfId && String(holder._id) === String(selfId)) return { self: true };
  if (allowManualToCard && holder.mode === "external" && holder.status === "manual_review") {
    // MANUAL_TO_CARD (events-service retry-payment switching an unposted manual/comp/invoice
    // record to card): the record is cancelled in the SAME conditional update that releases
    // it, so it can never be posted afterwards (postManualEventPaymentPost needs the binding).
    const m = await Payment.updateOne(
      { _id: holder._id, tenantId, registrationBinding: registrationId, ...UNPOSTED_MANUAL_FILTER },
      {
        // also frees the per-registration manual record key (#22), so a later manual record of this
        // registration is not refused ALREADY_RECORDED by a cancelled row
        $unset: { registrationBinding: "", idempotencyKey: "" },
        $set: {
          status: "canceled",
          bindingReleasedAt: new Date(),
          bindingReleaseReason: "REPLACE_RELEASED_BINDING:manual_to_card",
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );
    if (m.modifiedCount === 1) return { released: true, holderId: holder._id };
  }
  const r = await Payment.updateOne(
    { _id: holder._id, tenantId, registrationBinding: registrationId, ...releasableBindingFilter() },
    {
      $unset: { registrationBinding: "" },
      $set: {
        bindingReleasedAt: new Date(),
        bindingReleaseReason: `REPLACE_RELEASED_BINDING:${reason}`,
        "audit.updatedBy": ctx.userId || ctx.memberId || "system",
      },
    },
  );
  if (r.modifiedCount === 1) return { released: true, holderId: holder._id };
  // Either not releasable, or a concurrent request already changed it: re-check once.
  const still = await Payment.findOne({ tenantId, registrationBinding: registrationId }).select({ _id: 1 }).lean();
  if (!still) return { holder: null };
  return { blocked: true, holderId: still._id };
}

/**
 * Resolves the target of an event/course intent and enforces the portal creation rules:
 * a portal-like caller may NOT put a registrationId on the intent (registration-backed
 * intents are created by events-service as CRM), and must name the event/course it pays for
 * (top-level entityId, or the live portal's metadata.eventId / metadata.courseId).
 */
export function resolveIntentTarget({ parsed, metadata = {}, registrationId, caller = {} }) {
  const expectedType = entityTypeForPurpose(parsed.purpose);
  if (parsed.entityType && parsed.entityType !== expectedType) {
    throw bindingError(
      "entityType does not match the payment purpose",
      400,
      "TARGET_PURPOSE_MISMATCH",
    );
  }
  if (isPortalLikeCaller(caller)) {
    if (normId(registrationId)) {
      throw bindingError(
        "registrationId cannot be supplied when creating a registration payment",
        400,
        "REGISTRATION_ID_NOT_ALLOWED",
      );
    }
    const entityId = normId(
      parsed.entityId ||
        (expectedType === "course" ? metadata.courseId || metadata.eventId : metadata.eventId),
    );
    if (!OBJECT_ID_RE.test(entityId)) {
      throw bindingError(
        `A valid ${expectedType} id is required for this payment`,
        400,
        "TARGET_REQUIRED",
      );
    }
    return { entityType: expectedType, entityId };
  }
  if (normId(registrationId)) {
    return { entityType: "registration", entityId: normId(registrationId) };
  }
  const entityId = normId(parsed.entityId);
  return entityId ? { entityType: expectedType, entityId } : undefined;
}

function stripeDetailsFromIntent(pi) {
  if (!pi) return {};
  return {
    status: pi.status,
    chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
    customerId: pi.customer || undefined,
    paymentMethodId: pi.payment_method || undefined,
    capturedAt:
      pi.status === "succeeded"
        ? new Date((pi.created || Math.floor(Date.now() / 1000)) * 1000)
        : undefined,
    canceledAt:
      pi.status === "canceled"
        ? new Date((pi.canceled_at || Math.floor(Date.now() / 1000)) * 1000)
        : undefined,
    cancellationReason: pi.cancellation_reason || undefined,
    failureCode:
      pi.last_payment_error?.code ||
      pi.last_payment_error?.decline_code ||
      undefined,
    failureMessage: pi.last_payment_error?.message || undefined,
    nextAction: pi.next_action || undefined,
  };
}

function setDefined(target, key, value) {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

function appendStripeIntentFields(set, pi) {
  const details = stripeDetailsFromIntent(pi);
  for (const [key, value] of Object.entries(details)) {
    setDefined(set, `stripe.${key}`, value);
  }
}

async function buildIntentResponse(payment, stripe) {
  // Use stored values if available, otherwise fetch from Stripe (fallback)
  let clientSecret = payment?.stripe?.clientSecret;
  let checkoutUrl = payment?.stripe?.checkoutUrl;

  // Only fetch from Stripe if stored values are missing (backward compatibility)
  if (!clientSecret && payment?.stripe?.paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        payment.stripe.paymentIntentId,
      );
      clientSecret = pi?.client_secret;
    } catch (_) {}
  }
  if (!checkoutUrl && payment?.stripe?.checkoutSessionId) {
    try {
      const cs = await stripe.checkout.sessions.retrieve(
        payment.stripe.checkoutSessionId,
      );
      checkoutUrl = cs?.url;
    } catch (_) {}
  }
  return {
    paymentIntentId: payment?.stripe?.paymentIntentId,
    checkoutSessionId: payment?.stripe?.checkoutSessionId,
    clientSecret,
    checkoutUrl,
    status: payment.status,
    stripeStatus: payment?.stripe?.status || null,
    amount: payment?.amount,
    currency: payment?.currency,
    attemptNumber: payment?.attemptNumber || 1,
    isActiveAttempt: payment?.isActiveAttempt !== false,
    id: payment._id.toString(),
  };
}

/**
 * P5 clientSecret non-disclosure on registration/application attempt reuse: a reused intent
 * whose payer is a PORTAL member is only ever handed back to that member with its
 * clientSecret/checkoutUrl. Any other caller (CRM / events-service retry, another member)
 * gets the ids and status only - the same intent is reused (no second charge), but the
 * member's card-confirmation secret is never disclosed. CRM recovers a stranded member intent
 * by cancelling it (POST /intents/:id/cancel), which makes the binding releasable.
 */
export function withholdForeignPayerSecret(response, payment, payer = {}) {
  if (normId(payment?.payer?.userType).toUpperCase() !== "PORTAL") return response;
  if (effectivePayerUserId(payment) && effectivePayerUserId(payment) === normId(payer.userId)) return response;
  return { ...response, clientSecret: null, checkoutUrl: null, secretWithheld: true };
}

async function refreshPaymentFromStripe(payment, pi, ctx = {}) {
  const status = paymentIntentStatusToDomain(pi);
  const set = {
    status,
    amount: pi.amount_received || pi.amount || payment.amount,
    currency: pi.currency || payment.currency,
    "audit.updatedBy": ctx.userId || ctx.memberId || "system",
  };
  appendStripeIntentFields(set, pi);
  await Payment.updateOne({ _id: payment._id }, { $set: set });
  return (await Payment.findById(payment._id).lean()) || {
    ...payment,
    status,
  };
}

async function markPaymentAttemptSuperseded(payment, reason, ctx = {}) {
  if (!payment?._id) return;
  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        isActiveAttempt: false,
        supersededAt: new Date(),
        supersededReason: reason,
        "audit.updatedBy": ctx.userId || ctx.memberId || "system",
      },
    },
  );
}

/**
 * Finds the latest Stripe attempt for a given applicationId or registrationId
 * and either hands back its clientSecret for reuse (still-confirmable status,
 * same amount/currency) or marks it superseded so a fresh PaymentIntent gets
 * created below. Originally application-only; generalized to registrationId
 * so a repeated createIntent call for the same registration - e.g.
 * events-service's retry-payment endpoint, called when the CRM's
 * confirmCardPayment never completed and capture then fails with "cannot be
 * captured when its status is requires_payment_method" - recovers the SAME
 * PaymentIntent (requires_payment_method is itself in
 * canReuseStripePaymentIntentStatus) instead of that registration being stuck
 * forever, or silently accumulating disconnected duplicate PaymentIntents.
 * Exactly one of applicationId/registrationId should be provided.
 */
async function resolveReusablePaymentAttempt({
  applicationId,
  registrationId,
  purpose,
  amount,
  currency,
  ctx,
  stripe,
  logger,
}) {
  const matchField = applicationId
    ? "applicationId"
    : registrationId
      ? "registrationId"
      : null;
  const matchValue = applicationId || registrationId;
  if (!matchField) {
    return { reusablePayment: null, attemptNumber: 1 };
  }

  const latestAttempt = await Payment.findOne({
    tenantId: ctx.tenantId,
    [matchField]: matchValue,
    purpose,
    mode: "stripe",
    "stripe.paymentIntentId": { $exists: true, $ne: null },
  })
    .sort({ attemptNumber: -1, createdAt: -1 })
    .lean();

  if (!latestAttempt?.stripe?.paymentIntentId) {
    return { reusablePayment: null, attemptNumber: 1 };
  }

  const nextAttemptNumber = (latestAttempt.attemptNumber || 1) + 1;
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(
      latestAttempt.stripe.paymentIntentId,
    );
  } catch (err) {
    logger.warn(
      {
        paymentId: latestAttempt._id,
        [matchField]: matchValue,
        paymentIntentId: latestAttempt.stripe.paymentIntentId,
        error: err.message,
      },
      "Unable to retrieve latest PaymentIntent; creating replacement attempt",
    );
    await markPaymentAttemptSuperseded(
      latestAttempt,
      "stripe_retrieve_failed",
      ctx,
    );
    return {
      reusablePayment: null,
      attemptNumber: nextAttemptNumber,
      supersededPaymentId: latestAttempt._id,
    };
  }

  const refreshed = await refreshPaymentFromStripe(latestAttempt, pi, ctx);
  const sameAmount = Number(pi.amount) === Number(amount);
  const sameCurrency =
    String(pi.currency || "").toLowerCase() === String(currency || "").toLowerCase();
  const reusable =
    canReuseStripePaymentIntentStatus(pi.status) &&
    !isExpiredAuthorization(pi) &&
    sameAmount &&
    sameCurrency;

  if (reusable) {
    logger.info(
      {
        paymentId: latestAttempt._id,
        [matchField]: matchValue,
        paymentIntentId: latestAttempt.stripe.paymentIntentId,
        stripeStatus: pi.status,
        attemptNumber: latestAttempt.attemptNumber || 1,
      },
      "Reusing latest PaymentIntent",
    );
    if (latestAttempt.isActiveAttempt === false) {
      await Payment.updateOne(
        { _id: latestAttempt._id },
        {
          $set: {
            isActiveAttempt: true,
            supersededAt: null,
            supersededReason: null,
            supersededByPaymentId: null,
          },
        },
      );
    }
    return {
      reusablePayment: refreshed,
      attemptNumber: latestAttempt.attemptNumber || 1,
    };
  }

  await markPaymentAttemptSuperseded(
    latestAttempt,
    !sameAmount || !sameCurrency
      ? "amount_or_currency_changed"
      : isExpiredAuthorization(pi)
        ? "authorization_expired"
        : `stripe_status_${pi.status}`,
    ctx,
  );
  logger.info(
    {
      paymentId: latestAttempt._id,
      [matchField]: matchValue,
      paymentIntentId: latestAttempt.stripe.paymentIntentId,
      stripeStatus: pi.status,
      sameAmount,
      sameCurrency,
      nextAttemptNumber,
    },
    "Latest PaymentIntent is not reusable; creating replacement attempt",
  );
  return {
    reusablePayment: null,
    attemptNumber: nextAttemptNumber,
    supersededPaymentId: latestAttempt._id,
  };
}

/**
 * @param {object} input  zCreateIntent body
 * @param {object} ctx    trusted request context (tenantId, userId, idempotencyKey)
 * @param {object} [caller] { userType, internalRequest, req } — used by
 *   assertIntentAuthorized to verify portal callers' amount and member ownership.
 */
/**
 * POST /api/payments/intents. P5 (b7): when the portal intent guard verified the caller's own
 * application in THIS call, the returned Payment row - newly created or an existing attempt for
 * the same application that is reused - carries applicationBinding (set-once, same tenant, same
 * applicationId). Without that verification no binding is ever written.
 */
export async function createIntent(input, ctx, caller = {}) {
  const out = {};
  const result = await createIntentInner(input, ctx, caller, out);
  await adoptVerifiedApplicationBinding(result, out, ctx);
  return result;
}

async function adoptVerifiedApplicationBinding(result, out, ctx) {
  const binding = out?.applicationBinding;
  const id = result?.id;
  if (!binding || !/^[a-f0-9]{24}$/i.test(String(id || "")) || !ctx?.tenantId) return;
  await Payment.updateOne(
    {
      _id: id,
      tenantId: ctx.tenantId,
      applicationId: binding,
      registrationId: { $in: [null, ""] },
      purpose: { $in: ["applicationFee", "subscriptionFee"] },
      applicationBinding: { $exists: false },
    },
    { $set: { applicationBinding: binding } },
  );
}

async function createIntentInner(input, ctx, caller = {}, out = {}) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  const parsed = zCreateIntent.parse(input);
  ensureIntegerCents(parsed.amount);

  // Normalize currency to lowercase (Stripe requires lowercase)
  const normalizedCurrency = parsed.currency
    ? parsed.currency.toLowerCase()
    : "eur";

  const stripe = getStripe();

  // Extract memberId and applicationId from metadata if not provided directly
  // (needed for duplicate check before Stripe API call)
  // IMPORTANT: Do NOT use userId as memberId - userId is just a user identifier, not a member identifier
  // For application payments, applicationId should be used, not memberId
  const metadata = parsed.metadata || {};
  const memberIdFromMetadata =
    metadata.memberId || metadata.member_id || undefined; // Do not use userId as memberId
  const applicationIdFromMetadata =
    metadata.applicationId || metadata.application_id;
  const registrationIdFromMetadata =
    metadata.registrationId || metadata.registration_id;

  const memberId = parsed.memberId || memberIdFromMetadata;
  const applicationId = parsed.applicationId || applicationIdFromMetadata;
  const registrationId = parsed.registrationId || registrationIdFromMetadata;
  const profileId = parsed.profileId || metadata.profileId || metadata.profile_id;
  const productCode = parsed.productCode || metadata.productCode || metadata.product_code;
  const eventCategoryCode =
    parsed.eventCategoryCode || metadata.eventCategoryCode || metadata.event_category_code;
  const ledgerDomain = parsed.ledgerDomain || ledgerDomainForPurpose(parsed.purpose);
  const isApplicationPayment = isApplicationPaymentRequest({
    purpose: parsed.purpose,
    applicationId,
    memberId,
  });
  const isEventRegistrationPayment = isEventRegistrationPaymentRequest(parsed.purpose);

  // P5 payer binding: verified payer + target, before any lookup or Stripe call.
  const portalLike = isPortalLikeCaller(caller);
  const payer = payerFromCaller(ctx, caller);
  const target = isEventRegistrationPayment
    ? resolveIntentTarget({ parsed, metadata, registrationId, caller })
    : undefined;
  if (portalLike && isEventRegistrationPayment && !payer.userId) {
    throw AppError.unauthorized("A verified user is required for this payment");
  }
  // Every reuse lookup below is scoped to this payer (and target) for portal-like callers.
  const ownerScope = portalLike ? payerOwnerFilter(payer.userId) : null;
  // A portal-like caller only ever reuses its own still-UNATTACHED intent for the same
  // event/course (an intent already bound to a registration is never handed out again).
  const targetScope =
    portalLike && target
      ? {
          "target.entityType": target.entityType,
          "target.entityId": target.entityId,
          registrationId: null,
        }
      : null;
  const reuseScope = (query) => withAnd(withAnd(query, ownerScope), targetScope);

  // H-11: portal callers may only pay for themselves, and application fees must match the
  // synced catalogue price (see paymentIntentGuard.service.js for the per-kind source).
  const intentGuard = await assertIntentAuthorized({
    parsed,
    metadata,
    memberId,
    applicationId,
    profileId,
    isApplicationPayment,
    isEventRegistrationPayment,
    ctx,
    caller,
  });

  out.applicationBinding =
    applicationBindingOnCreate({ isApplicationPayment, applicationId, guard: intentGuard }).applicationBinding || null;
  const stripeCaptureMethod =
    isApplicationPayment || isEventRegistrationPayment ? "manual" : "automatic";
  const logger = (await import("../config/logger.js")).default;
  let attemptNumber = 1;
  let supersededPaymentId = null;
  let persistIdempotencyKey = true;

  // P5: legacy (pre-binding) rows of this registration join the binding index BEFORE any
  // reuse/supersede decision, so an ambiguous registration fails closed (409) instead of the
  // reuse logic picking one of its rows, and a reused legacy row is the bound holder.
  if (isEventRegistrationPayment && !parsed.useCheckout && normId(registrationId)) {
    await adoptLegacyRegistrationHolder({ tenantId: ctx.tenantId, registrationId });
  }

  if ((isApplicationPayment || isEventRegistrationPayment) && !parsed.useCheckout) {
    const attemptDecision = await resolveReusablePaymentAttempt({
      applicationId: isApplicationPayment ? applicationId : undefined,
      registrationId: isEventRegistrationPayment ? registrationId : undefined,
      purpose: parsed.purpose,
      amount: parsed.amount,
      currency: normalizedCurrency,
      ctx,
      stripe,
      logger,
    });
    if (attemptDecision.reusablePayment) {
      return withholdForeignPayerSecret(
        await buildIntentResponse(attemptDecision.reusablePayment, stripe),
        attemptDecision.reusablePayment,
        payer,
      );
    }
    attemptNumber = attemptDecision.attemptNumber || 1;
    supersededPaymentId = attemptDecision.supersededPaymentId || null;
  }

  // P5 active registration binding: a registration-backed intent may only be created when
  // the registration has no holder or its holder is releasable (REPLACE_RELEASED_BINDING).
  // Checked BEFORE Stripe is called; the unique index is the final guard at Payment.create.
  const claimsRegistrationBinding =
    isEventRegistrationPayment && !parsed.useCheckout && Boolean(normId(registrationId));
  if (claimsRegistrationBinding) {
    // (Re-check: a legacy row may have become the only live one after the supersede above.)
    await adoptLegacyRegistrationHolder({ tenantId: ctx.tenantId, registrationId });
    const rel = await releaseRegistrationBinding({
      tenantId: ctx.tenantId,
      registrationId: normId(registrationId),
      reason: "replacement_attempt",
      ctx,
      allowManualToCard: true,
    });
    if (rel.blocked) {
      if (supersededPaymentId && String(supersededPaymentId) === String(rel.holderId)) {
        // resolveReusablePaymentAttempt marked the funds-holding attempt superseded; undo it,
        // it remains the registration's payment.
        await Payment.updateOne(
          { _id: rel.holderId, tenantId: ctx.tenantId },
          { $set: { isActiveAttempt: true, supersededAt: null, supersededReason: null } },
        );
      }
      throw bindingError(
        "This registration already has a payment that holds funds",
        409,
        "REGISTRATION_PAYMENT_HELD",
      );
    }
  }

  // Idempotency and duplicate protection: check for existing payments BEFORE Stripe API call
  // 1. Check by idempotency key (if provided)
  if (ctx.idempotencyKey) {
    const existingByIdem = await Payment.findOne(
      reuseScope({
        tenantId: ctx.tenantId,
        idempotencyKey: ctx.idempotencyKey,
      }),
    )
      .select("stripe status _id memberId applicationId isActiveAttempt")
      .lean();
    if (existingByIdem) {
      if (
        applicationId &&
        (!canReuseDomainPaymentStatus(existingByIdem.status) ||
          existingByIdem.isActiveAttempt === false)
      ) {
        logger.info(
          {
            existingPaymentId: existingByIdem._id,
            idempotencyKey: ctx.idempotencyKey,
            existingStatus: existingByIdem.status,
            applicationId,
          },
          "Ignoring non-reusable idempotency match for application payment continuation",
        );
        persistIdempotencyKey = false;
      } else {
      logger.info(
        {
          existingPaymentId: existingByIdem._id,
          idempotencyKey: ctx.idempotencyKey,
          existingStatus: existingByIdem.status,
        },
        "Found existing payment by idempotency key - returning existing payment",
      );
      return await buildIntentResponse(existingByIdem, stripe);
      }
    }
  }

  // 2. Check for recent duplicate payments (same member/application, amount, purpose)
  // This prevents duplicates even when different idempotency keys are used
  // Check for payments created in the last 10 minutes (increased window for race conditions)
  // Include ALL statuses to catch any recent payment attempt
  //
  // registrationId alone must also trigger this (not just memberId/
  // applicationId) - an event/course attendee with no resolved membership
  // number has neither, so without this the whole block was silently
  // skipped for every non-member event/course registration, meaning a
  // retried createRegistrationPaymentIntent call (network retry, proxy
  // retry, anything re-sending the same registrationId) always created a
  // brand new, unrelated Stripe PaymentIntent instead of reusing the one
  // already created for that registration.
  if (memberId || applicationId || registrationId) {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const duplicateCheck = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      isActiveAttempt: { $ne: false },
      createdAt: { $gte: tenMinutesAgo },
      // Don't filter by status - check ALL recent payments to prevent duplicates
    };

    if (memberId) {
      duplicateCheck.memberId = memberId;
    }
    if (applicationId) {
      duplicateCheck.applicationId = applicationId;
    }
    // Scope to the same registration attempt when one is present (events
    // domain) - without this, two different event registrations for the
    // same member with the same ticket price within the window would match
    // each other here and the second registration would silently reuse the
    // first one's payment/PaymentIntent instead of getting its own.
    if (registrationId) {
      duplicateCheck.registrationId = registrationId;
    }

    const existingDuplicate = await Payment.findOne(reuseScope(duplicateCheck))
      .select("stripe status _id memberId applicationId isActiveAttempt")
      .sort({ createdAt: -1 })
      .lean();

    if (existingDuplicate) {
      if (!canReuseDomainPaymentStatus(existingDuplicate.status)) {
        logger.info(
          {
            existingPaymentId: existingDuplicate._id,
            existingStatus: existingDuplicate.status,
            memberId,
            applicationId,
          },
          "Recent terminal payment found - creating a new PaymentIntent instead of reusing it",
        );
      } else {
        logger.warn(
          {
            existingPaymentId: existingDuplicate._id,
            existingStatus: existingDuplicate.status,
            existingPaymentIntentId: existingDuplicate.stripe?.paymentIntentId,
            memberId,
            applicationId,
            amount: parsed.amount,
            purpose: parsed.purpose,
            idempotencyKey: ctx.idempotencyKey,
          },
          "Duplicate payment detected - returning existing payment",
        );

      // Ensure the existing payment has memberId/applicationId if they're missing
      // This is important for journal entry creation later
      if (
        (memberId || applicationId) &&
        !existingDuplicate.memberId &&
        !existingDuplicate.applicationId
      ) {
        const updateFields = {};
        if (memberId && !existingDuplicate.memberId) {
          updateFields.memberId = memberId;
        }
        if (applicationId && !existingDuplicate.applicationId) {
          updateFields.applicationId = applicationId;
        }

        if (Object.keys(updateFields).length > 0) {
          await Payment.updateOne({ _id: existingDuplicate._id, tenantId: ctx.tenantId }, {
            $set: updateFields,
          });
          logger.info(
            {
              paymentId: existingDuplicate._id,
              updatedFields: updateFields,
            },
            "Updated existing payment with memberId/applicationId",
          );
        }
      }

        return await buildIntentResponse(existingDuplicate, stripe);
      }
    }
  }

  // Final duplicate check right before Stripe API call to catch race conditions
  // This is the last chance to prevent duplicate Stripe payment intents
  // Check for ANY recent payment with same parameters (not just in-progress)
  // registrationId alone must also trigger this - see the comment on the
  // matching gate above.
  if (memberId || applicationId || registrationId) {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000); // Check last 2 minutes
    const lastSecondCheck = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      isActiveAttempt: { $ne: false },
      createdAt: { $gte: twoMinutesAgo },
      // Check ALL statuses to catch any recent payment attempt
    };

    if (memberId) {
      lastSecondCheck.memberId = memberId;
    }
    if (applicationId) {
      lastSecondCheck.applicationId = applicationId;
    }
    if (registrationId) {
      lastSecondCheck.registrationId = registrationId;
    }

    const recentPayment = await Payment.findOne(reuseScope(lastSecondCheck))
      .select("stripe status _id memberId applicationId createdAt isActiveAttempt")
      .sort({ createdAt: -1 })
      .lean();

    if (recentPayment) {
      if (!canReuseDomainPaymentStatus(recentPayment.status)) {
        logger.info(
          {
            existingPaymentId: recentPayment._id,
            existingStatus: recentPayment.status,
            memberId,
            applicationId,
          },
          "Recent terminal payment found during race check - creating a new PaymentIntent instead of reusing it",
        );
      } else {
        logger.warn(
          {
            existingPaymentId: recentPayment._id,
            existingStatus: recentPayment.status,
            existingPaymentIntentId: recentPayment.stripe?.paymentIntentId,
            memberId,
            applicationId,
            amount: parsed.amount,
            purpose: parsed.purpose,
            idempotencyKey: ctx.idempotencyKey,
            timeSinceCreation:
              Date.now() - new Date(recentPayment.createdAt).getTime(),
          },
          "Race condition detected - payment created within last 2 minutes, returning existing payment",
        );

      // Ensure the existing payment has memberId/applicationId if they're missing
      // This is important for journal entry creation later
      if (
        (memberId || applicationId) &&
        !recentPayment.memberId &&
        !recentPayment.applicationId
      ) {
        const updateFields = {};
        if (memberId && !recentPayment.memberId) {
          updateFields.memberId = memberId;
        }
        if (applicationId && !recentPayment.applicationId) {
          updateFields.applicationId = applicationId;
        }

        if (Object.keys(updateFields).length > 0) {
          await Payment.updateOne({ _id: recentPayment._id, tenantId: ctx.tenantId }, {
            $set: updateFields,
          });
          logger.info(
            {
              paymentId: recentPayment._id,
              updatedFields: updateFields,
            },
            "Updated existing payment with memberId/applicationId (race condition)",
          );
        }
      }

        return await buildIntentResponse(recentPayment, stripe);
      }
    }
  }

  // Use client's idempotency key for Stripe if provided, otherwise generate a unique one
  // Stripe requires idempotency keys to be used with exact same parameters, so we can't use
  // a deterministic key based on payment parameters (they might vary between requests)
  // We already have duplicate payment checks in place, so we don't need deterministic keys
  const crypto = await import("crypto");
  let stripeIdempotencyKey = null;

  if (ctx.idempotencyKey && persistIdempotencyKey && portalLike) {
    // P5: a portal caller's key is namespaced by tenant + verified payer, so replaying
    // another member's Idempotency key can never make Stripe return that member's
    // PaymentIntent (and client_secret) from its idempotency cache.
    stripeIdempotencyKey = crypto
      .createHash("sha256")
      .update(["portal-intent", ctx.tenantId, payer.userId || "", ctx.idempotencyKey].join("-"))
      .digest("hex")
      .substring(0, 64);
  } else if (ctx.idempotencyKey && persistIdempotencyKey) {
    // Use client's idempotency key - hash it to ensure it's valid format for Stripe
    // Stripe keys must be max 64 chars, so we hash if longer
    if (ctx.idempotencyKey.length <= 64) {
      stripeIdempotencyKey = ctx.idempotencyKey;
    } else {
      stripeIdempotencyKey = crypto
        .createHash("sha256")
        .update(ctx.idempotencyKey)
        .digest("hex")
        .substring(0, 64);
    }
  } else if (isApplicationPayment && !parsed.useCheckout) {
    const applicationAttemptKeyParts = [
      "application-payment",
      ctx.tenantId,
      applicationId,
      parsed.purpose,
      attemptNumber,
      parsed.amount,
      normalizedCurrency,
    ];
    stripeIdempotencyKey = crypto
      .createHash("sha256")
      .update(applicationAttemptKeyParts.join("-"))
      .digest("hex")
      .substring(0, 64);
  } else {
    // Generate a unique key for this request
    // Include timestamp to ensure uniqueness
    const uniqueKeyParts = [
      "payment",
      ctx.tenantId,
      Date.now().toString(),
      crypto.randomBytes(16).toString("hex"),
    ];
    stripeIdempotencyKey = crypto
      .createHash("sha256")
      .update(uniqueKeyParts.join("-"))
      .digest("hex")
      .substring(0, 64);
  }

  logger.info(
    {
      clientIdempotencyKey: ctx.idempotencyKey,
      stripeIdempotencyKey,
      memberId,
      applicationId,
      amount: parsed.amount,
      purpose: parsed.purpose,
      captureMethod: stripeCaptureMethod,
    },
    "Creating Stripe payment intent with idempotency key",
  );

  let stripeResult = {};
  let status = "created";
  let mode = "stripe";
  let stripeIds = {};
  let reservation = null; // P5 registration-backed intent reservation (see below)

  const stripeMetadata = {
    ...(metadata || {}),
    ...(ctx.tenantId ? { tenantId: String(ctx.tenantId) } : {}),
    ...(memberId ? { memberId: String(memberId) } : {}),
    ...(applicationId ? { applicationId: String(applicationId) } : {}),
  };

  if (parsed.useCheckout) {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        currency: normalizedCurrency,
        line_items: [
          {
            price_data: {
              currency: normalizedCurrency,
              product_data: { name: parsed.purpose },
              unit_amount: parsed.amount,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          capture_method: stripeCaptureMethod,
          metadata: stripeMetadata,
        },
        success_url: `${
          process.env.PORTAL_BASE_URL || "https://example.com"
        }/payments/success`,
        cancel_url: `${
          process.env.PORTAL_BASE_URL || "https://example.com"
        }/payments/cancel`,
      },
      { idempotencyKey: stripeIdempotencyKey },
    );
    stripeResult = session;
    status = "requires_action";
    stripeIds = {
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      status: session.payment_status || "checkout_session_created",
    };

    // After creating Stripe checkout session, check if a payment with this session ID already exists
    // This catches race conditions where two requests create sessions simultaneously
    if (stripeIds.checkoutSessionId) {
      const existingBySession = await Payment.findOne({
        tenantId: ctx.tenantId,
        "stripe.checkoutSessionId": stripeIds.checkoutSessionId,
      })
        .select("stripe status _id")
        .lean();
      if (existingBySession) {
        const logger = (await import("../config/logger.js")).default;
        logger.warn(
          {
            existingPaymentId: existingBySession._id,
            checkoutSessionId: stripeIds.checkoutSessionId,
            existingStatus: existingBySession.status,
          },
          "Payment with this Stripe checkout session ID already exists - returning existing payment",
        );
        return await buildIntentResponse(existingBySession, stripe);
      }
    }
  } else {
    // Check if we already have a payment with a paymentIntentId before creating a new one
    // This prevents creating duplicate payment intents if two requests come in simultaneously
    // We check by looking for any recent payment with same parameters that might have a paymentIntentId
    // registrationId alone must also trigger this - this is the block that
    // actually runs for events-service's calls (useCheckout is never true
    // for event/course registrations), and a non-member attendee has
    // neither memberId nor applicationId, so without this the block - and
    // the registrationId scoping in its query below - never ran at all for
    // events/courses, meaning a retried createRegistrationPaymentIntent call
    // (network retry, proxy retry, etc.) always created a brand new,
    // unrelated Stripe PaymentIntent instead of reusing the one already
    // created for that registration.
    if (memberId || applicationId || registrationId) {
      const recentCheck = {
        tenantId: ctx.tenantId,
        purpose: parsed.purpose,
        amount: parsed.amount,
        isActiveAttempt: { $ne: false },
        createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) }, // Last 2 minutes
        "stripe.paymentIntentId": { $exists: true, $ne: null },
      };
      if (memberId) recentCheck.memberId = memberId;
      if (applicationId) recentCheck.applicationId = applicationId;
      if (registrationId) recentCheck.registrationId = registrationId;

      const recentWithIntent = await Payment.findOne(reuseScope(recentCheck))
        .select("stripe status _id memberId applicationId isActiveAttempt")
        .lean();

      if (recentWithIntent && recentWithIntent.stripe?.paymentIntentId) {
        if (!canReuseDomainPaymentStatus(recentWithIntent.status)) {
          logger.info(
            {
              existingPaymentId: recentWithIntent._id,
              existingStatus: recentWithIntent.status,
              existingPaymentIntentId: recentWithIntent.stripe.paymentIntentId,
              memberId,
              applicationId,
            },
            "Recent terminal PaymentIntent found - creating a new PaymentIntent instead of reusing it",
          );
        } else {
          logger.warn(
            {
              existingPaymentId: recentWithIntent._id,
              existingPaymentIntentId: recentWithIntent.stripe.paymentIntentId,
              memberId,
              applicationId,
              amount: parsed.amount,
            },
            "Recent payment with paymentIntentId found - returning existing payment to prevent duplicate Stripe intent",
          );

        // Ensure memberId/applicationId are set
        if (
          (memberId || applicationId) &&
          !recentWithIntent.memberId &&
          !recentWithIntent.applicationId
        ) {
          const updateFields = {};
          if (memberId && !recentWithIntent.memberId)
            updateFields.memberId = memberId;
          if (applicationId && !recentWithIntent.applicationId)
            updateFields.applicationId = applicationId;

          if (Object.keys(updateFields).length > 0) {
            await Payment.updateOne({ _id: recentWithIntent._id, tenantId: ctx.tenantId }, {
              $set: updateFields,
            });
          }
        }

          return await buildIntentResponse(recentWithIntent, stripe);
        }
      }
    }

    // P5: a registration-backed intent gets a durable reservation BEFORE Stripe is called, and
    // a Stripe idempotency key derived only from it - a PaymentIntent that never becomes a
    // Payment row (lost the binding race, or this process died) is always recoverable and is
    // cancelled by sweepPaymentIntentReservations, never bound/captured/attached.
    if (claimsRegistrationBinding) {
      const reservationId = new mongoose.Types.ObjectId();
      stripeIdempotencyKey = reservationStripeKey(reservationId);
      stripeMetadata.reservationId = String(reservationId);
      reservation = await PaymentIntentReservation.create({
        _id: reservationId,
        tenantId: String(ctx.tenantId),
        registrationId: normId(registrationId),
        purpose: parsed.purpose,
        stripeIdempotencyKey,
        request: {
          amount: parsed.amount,
          currency: normalizedCurrency,
          captureMethod: stripeCaptureMethod,
          metadata: stripeMetadata,
        },
      });
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: parsed.amount,
          currency: normalizedCurrency,
          payment_method_types: ["card"],
          capture_method: stripeCaptureMethod,
          metadata: stripeMetadata,
        },
        { idempotencyKey: stripeIdempotencyKey },
      );
    } catch (stripeError) {
      // Handle Stripe idempotency errors - retry without idempotency key
      // This happens when the same key was used with different parameters
      if (reservation) {
        // Never retry a reserved creation without its key (that PaymentIntent would be
        // unrecoverable); the reservation stays open and the sweep resolves it.
        await PaymentIntentReservation.updateOne(
          { _id: reservation._id, state: "reserved" },
          { $set: { lastErrorCode: String(stripeError.code || stripeError.type || "stripe_error").slice(0, 64) } },
        ).catch(() => {});
        throw stripeError;
      }
      if (
        stripeError.type === "StripeIdempotencyError" ||
        stripeError.rawType === "idempotency_error"
      ) {
        logger.warn(
          {
            stripeIdempotencyKey,
            error: stripeError.message,
            clientIdempotencyKey: ctx.idempotencyKey,
          },
          "Stripe idempotency error - retrying without idempotency key",
        );
        // Retry without idempotency key
        intent = await stripe.paymentIntents.create({
          amount: parsed.amount,
          currency: normalizedCurrency,
          payment_method_types: ["card"],
          capture_method: stripeCaptureMethod,
          metadata: stripeMetadata,
        });
      } else {
        throw stripeError;
      }
    }

    stripeResult = intent;
    if (reservation) {
      await PaymentIntentReservation.updateOne(
        { _id: reservation._id, state: "reserved" },
        { $set: { state: "intent_created", paymentIntentId: intent.id } },
      );
    }
    status = normalizeStripeStatusForPayment(intent.status) || "requires_action";
    stripeIds = {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
    };

    // After creating Stripe payment intent, check if a payment with this intent ID already exists
    // This catches race conditions where two requests create intents simultaneously
    if (stripeIds.paymentIntentId) {
      const existingByIntent = await Payment.findOne(
        reuseScope({
          tenantId: ctx.tenantId,
          "stripe.paymentIntentId": stripeIds.paymentIntentId,
        }),
      )
        .select("stripe status _id memberId applicationId")
        .lean();
      if (existingByIntent) {
        logger.warn(
          {
            existingPaymentId: existingByIntent._id,
            paymentIntentId: stripeIds.paymentIntentId,
            existingStatus: existingByIntent.status,
          },
          "Payment with this Stripe payment intent ID already exists - returning existing payment",
        );

        // Ensure memberId/applicationId are set if missing
        if (
          (memberId || applicationId) &&
          !existingByIntent.memberId &&
          !existingByIntent.applicationId
        ) {
          const updateFields = {};
          if (memberId && !existingByIntent.memberId) {
            updateFields.memberId = memberId;
          }
          if (applicationId && !existingByIntent.applicationId) {
            updateFields.applicationId = applicationId;
          }

          if (Object.keys(updateFields).length > 0) {
            await Payment.updateOne({ _id: existingByIntent._id, tenantId: ctx.tenantId }, {
              $set: updateFields,
            });
            logger.info(
              {
                paymentId: existingByIntent._id,
                updatedFields: updateFields,
              },
              "Updated existing payment with memberId/applicationId (paymentIntentId check)",
            );
          }
        }

        return await buildIntentResponse(existingByIntent, stripe);
      }
    }
  }

  try {
    // Final check: if we just created a Stripe payment intent, check if another request
    // already created a payment document with this paymentIntentId (race condition)
    if (stripeIds.paymentIntentId) {
      const existingByIntentId = await Payment.findOne(
        reuseScope({
          tenantId: ctx.tenantId,
          "stripe.paymentIntentId": stripeIds.paymentIntentId,
        }),
      )
        .select("stripe status _id memberId applicationId")
        .lean();

      if (existingByIntentId) {
        const logger = (await import("../config/logger.js")).default;
        logger.warn(
          {
            existingPaymentId: existingByIntentId._id,
            paymentIntentId: stripeIds.paymentIntentId,
            existingStatus: existingByIntentId.status,
          },
          "Payment with this paymentIntentId already exists - another request created it first",
        );

        // Ensure memberId/applicationId are set
        if (
          (memberId || applicationId) &&
          !existingByIntentId.memberId &&
          !existingByIntentId.applicationId
        ) {
          const updateFields = {};
          if (memberId && !existingByIntentId.memberId) {
            updateFields.memberId = memberId;
          }
          if (applicationId && !existingByIntentId.applicationId) {
            updateFields.applicationId = applicationId;
          }

          if (Object.keys(updateFields).length > 0) {
            await Payment.updateOne({ _id: existingByIntentId._id, tenantId: ctx.tenantId }, {
              $set: updateFields,
            });
          }
        }

        return await buildIntentResponse(existingByIntentId, stripe);
      }
    }

    // memberId and applicationId already extracted above for duplicate check
    // Prioritize applicationId over memberId - if applicationId is present, don't set memberId
    const paymentData = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      ledgerDomain,
      amount: parsed.amount,
      currency: normalizedCurrency,
      status,
      attemptNumber,
      isActiveAttempt: true,
      // Only set memberId if applicationId is not present
      ...(applicationId ? { applicationId } : memberId ? { memberId } : {}),
      ...applicationBindingOnCreate({ isApplicationPayment, applicationId, guard: intentGuard }),
      ...(registrationId ? { registrationId } : {}),
      ...(profileId ? { profileId } : {}),
      ...(productCode ? { productCode } : {}),
      ...(eventCategoryCode ? { eventCategoryCode } : {}),
      invoiceId: parsed.invoiceId,
      source: "portal",
      mode,
      stripe: stripeIds,
      metadata: stripeMetadata,
      audit: {
        createdBy: ctx.userId || ctx.memberId || "system",
        updatedBy: ctx.userId || ctx.memberId || "system",
      },
      payer,
      ...(target ? { target } : {}),
      ...(claimsRegistrationBinding ? { registrationBinding: normId(registrationId) } : {}),
    };

    // Only include idempotencyKey if it's actually provided (not null or undefined)
    if (ctx.idempotencyKey && persistIdempotencyKey) {
      paymentData.idempotencyKey = ctx.idempotencyKey;
    }

    const payment = await Payment.create(paymentData);
    if (reservation) {
      await PaymentIntentReservation.updateOne(
        { _id: reservation._id, state: { $in: ["reserved", "intent_created"] } },
        { $set: { state: "bound", paymentId: String(payment._id), paymentIntentId: stripeIds.paymentIntentId || null } },
      );
    }
    const supersedeMatchValue = isApplicationPayment ? applicationId : registrationId;
    // Only supersede siblings of the SAME application/registration: without a match value
    // (a portal event/course intent has no registrationId) there are no siblings, and an
    // undefined filter value must never widen this to every payment of the purpose.
    if (
      (isApplicationPayment || isEventRegistrationPayment) &&
      stripeIds.paymentIntentId &&
      normId(supersedeMatchValue)
    ) {
      await Payment.updateMany(
        {
          tenantId: ctx.tenantId,
          ...(isApplicationPayment ? { applicationId } : { registrationId }),
          purpose: parsed.purpose,
          _id: { $ne: payment._id },
          isActiveAttempt: { $ne: false },
        },
        {
          $set: {
            supersededByPaymentId: payment._id,
            isActiveAttempt: false,
            supersededAt: new Date(),
            supersededReason: supersededPaymentId
              ? "replacement_attempt_created"
              : "newer_attempt_created",
          },
        },
      );
    }

    return {
      paymentIntentId: stripeIds.paymentIntentId,
      checkoutSessionId: stripeIds.checkoutSessionId,
      clientSecret: stripeIds.clientSecret || stripeResult.client_secret,
      checkoutUrl: stripeIds.checkoutUrl || stripeResult.url,
      status,
      attemptNumber,
      id: payment._id.toString(),
    };
  } catch (e) {
    if (isBindingDuplicateKey(e)) {
      // P5: a concurrent request claimed this registration first. Never return its intent;
      // cancel the PaymentIntent this request just created (it was never persisted).
      // The reservation is marked orphaned FIRST (durable), then the cancel is attempted; a
      // failed cancel stays visible as orphan_cancel_failed and the sweep retries it.
      if (stripeIds.paymentIntentId) {
        await cancelOrphanedIntent({
          stripe,
          reservationId: reservation?._id || null,
          paymentIntentId: stripeIds.paymentIntentId,
          reason: "lost_registration_binding",
        });
      }
      throw bindingError("This registration already has a payment", 409, "REGISTRATION_ALREADY_HAS_PAYMENT");
    }
    // Handle MongoDB duplicate key errors (11000) by returning existing payment
    if (e && e.code === 11000) {
      // Try to find existing payment by idempotency key first
      if (ctx.idempotencyKey && persistIdempotencyKey) {
        const existing = await Payment.findOne(
          reuseScope({
            tenantId: ctx.tenantId,
            idempotencyKey: ctx.idempotencyKey,
          }),
        )
          .select("stripe status _id")
          .lean();
        if (existing) {
          return await buildIntentResponse(existing, stripe);
        }
      }

      // Try to find existing payment by Stripe payment intent ID
      if (stripeIds.paymentIntentId) {
        const existingByPi = await Payment.findOne(
          reuseScope({
            tenantId: ctx.tenantId,
            "stripe.paymentIntentId": stripeIds.paymentIntentId,
          }),
        )
          .select("stripe status _id")
          .lean();
        if (existingByPi) {
          return await buildIntentResponse(existingByPi, stripe);
        }
      }

      if (portalLike) {
        // P5: the colliding row belongs to another payer (or another target); never return it.
        throw new AppError(
          "This payment request conflicts with an existing payment",
          409,
          "PAYMENT_CONFLICT",
        );
      }
      // If we can't find an existing payment, it's a real constraint violation
      console.error(
        "MongoDB duplicate key error but no existing payment found:",
        {
          error: e,
          tenantId: ctx.tenantId,
          idempotencyKey: ctx.idempotencyKey,
          paymentIntentId: stripeIds.paymentIntentId,
        },
      );
    }
    throw e;
  }
}

export async function findByStripePaymentIntent(paymentIntentId, ctx) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  const doc = await Payment.findOne({
    tenantId: ctx.tenantId,
    "stripe.paymentIntentId": paymentIntentId,
  });
  if (!doc) return null;
  return doc;
}

export async function findLatestApplicationPayment(applicationId, ctx = {}) {
  const appId = String(applicationId || "").trim();
  if (!appId) {
    throw AppError.badRequest("applicationId is required");
  }

  const query = {
    applicationId: appId,
    mode: "stripe",
    isActiveAttempt: { $ne: false },
    "stripe.paymentIntentId": { $exists: true, $ne: null },
  };
  query.tenantId = requireTenantId(ctx); // fail closed, never a global lookup

  let payment = await Payment.findOne(query)
    .sort({ attemptNumber: -1, createdAt: -1 })
    .lean();
  if (!payment) return null;

  try {
    const pi = await getStripe().paymentIntents.retrieve(
      payment.stripe.paymentIntentId,
    );
    const previousStatus = payment.status;
    await refreshPaymentFromStripe(payment, pi, ctx);
    payment = await Payment.findById(payment._id).lean();
    await publishApplicationPaymentRefreshUpdate(
      { ...payment, status: previousStatus },
      pi,
      ctx,
    );
  } catch (err) {
    const logger = (await import("../config/logger.js")).default;
    logger.warn(
      {
        applicationId: appId,
        paymentId: payment._id,
        paymentIntentId: payment.stripe?.paymentIntentId,
        error: err.message,
      },
      "Unable to refresh latest application payment from Stripe",
    );
  }

  return payment;
}

async function loadPaymentForIntent(paymentIntentId, ctx) {
  const filter = {
    "stripe.paymentIntentId": paymentIntentId,
    tenantId: requireTenantId(ctx), // fail closed, never a global lookup
  };
  const payment = await Payment.findOne(filter);
  if (!payment) {
    throw AppError.notFound("Payment not found for PaymentIntent", {
      paymentIntentId,
    });
  }
  return payment;
}

export function paymentDataFromIntent(pi) {
  return {
    paymentIntentId: pi.id,
    amount: pi.amount_received || pi.amount,
    currency: pi.currency,
    status: normalizeStripeStatusForPayment(pi.status),
    stripeStatus: pi.status,
    capturedAt:
      pi.status === "succeeded"
        ? new Date((pi.created || Math.floor(Date.now() / 1000)) * 1000)
        : undefined,
    canceledAt:
      pi.status === "canceled"
        ? new Date((pi.canceled_at || Math.floor(Date.now() / 1000)) * 1000)
        : undefined,
    cancellationReason: pi.cancellation_reason || undefined,
    failureCode:
      pi.last_payment_error?.code ||
      pi.last_payment_error?.decline_code ||
      undefined,
    failureMessage: pi.last_payment_error?.message || undefined,
    nextAction: pi.next_action || undefined,
    chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
    customerId: pi.customer || undefined,
    paymentMethodId: pi.payment_method || undefined,
    metadata: pi.metadata || {},
  };
}

function normalizeOptionalDate(value) {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function resolveWebhookStatus(existingPayment, incomingStatus) {
  const current = existingPayment?.status;
  if (
    ["refund_required", "manual_review"].includes(current) &&
    incomingStatus === "succeeded"
  ) {
    return current;
  }
  if (current === "succeeded" && incomingStatus === "requires_capture") {
    return current;
  }
  if (current === "canceled" && incomingStatus === "requires_capture") {
    return current;
  }
  return incomingStatus;
}

/**
 * Legacy decision (resolveWebhookStatus) plus the lifecycle state machine's decision.
 * Shadow mode: the legacy decision stays authoritative for existing payments and any
 * disagreement is logged (ids and statuses only). Payment-link payments always use the
 * state machine, so a late requires_action/processing/failed cannot regress them.
 */
export function decideWebhookStatus(existingPayment, parsed, { log } = {}) {
  const legacy = resolveWebhookStatus(existingPayment, parsed.payment.status);
  const machine = nextPaymentStatus(existingPayment?.status, parsed.payment.status, {
    occurredAt: parsed.payment.occurredAt,
    lastAppliedAt: existingPayment?.lastStripeEventAt,
  });
  const isLink = Boolean(existingPayment?.paymentLinkId);
  const authoritative = isLink || stateMachineMode() === "authoritative";
  const comparison = shadowComparison({
    paymentId: existingPayment?._id,
    eventId: parsed.eventId,
    eventType: parsed.type,
    current: existingPayment?.status,
    incoming: parsed.payment.status,
    legacy,
    machine,
  });
  if (!comparison.agree && log) {
    log(
      { ...comparison, authoritative: authoritative ? "state-machine" : "legacy", paymentLink: isLink },
      "Payment state machine disagrees with legacy webhook status",
    );
  }
  return { status: authoritative ? machine.status : legacy, legacy, machine, authoritative, comparison };
}

function buildWebhookAuditEntry(parsed, finalStatus) {
  const failureMessage = parsed.payment.failureMessage;
  const cancellationReason = parsed.payment.cancellationReason;
  const message =
    failureMessage ||
    (cancellationReason ? `Cancellation reason: ${cancellationReason}` : null);
  return {
    eventId: parsed.eventId,
    eventType: parsed.type,
    source: parsed.type?.startsWith("manual-")
      ? "account-service"
      : "stripe-webhook",
    status: finalStatus,
    stripeStatus: parsed.payment.stripeStatus,
    ...(message ? { message } : {}),
    receivedAt: new Date(),
  };
}

/**
 * Link payments announce their state through the outbox as
 * payments.application-payment.status-changed.v1 and never through the legacy
 * application.status.updated (portal-service would act on it). Throws when the outbox write
 * fails, so a webhook caller answers 500 and Stripe retries; the retry takes the duplicate
 * path, which re-enqueues (idempotent on eventKey).
 */
export async function enqueueLinkPaymentStatus(payment, parsed = {}) {
  const status = payment?.status;
  if (!payment?.paymentLinkId || !applicationPaymentStatus(status)) return false;
  const paymentId = String(payment._id);
  await enqueueOutboxEvent({
    eventKey: `pay:${paymentId}:${status}${parsed?.eventKeySuffix ? `:${parsed.eventKeySuffix}` : ""}`,
    tenantId: String(payment.tenantId), // the persisted payment's tenant only
    routingKey: "payments.application-payment.status-changed.v1",
    data: {
      applicationId: payment.applicationId,
      paymentId,
      paymentLinkId: String(payment.paymentLinkId),
      paymentIntentId: payment.stripe?.paymentIntentId || null,
      linkVersion: payment.linkVersion ?? null,
      to: status,
      applicationStatus: applicationPaymentStatus(status),
      amount: payment.amount,
      currency: payment.currency,
      capturableUntil: payment.capturableUntil || null,
      refund: parsed?.refund || null,
      occurredAt: new Date().toISOString(),
      stripeEventId: parsed?.eventId || null,
    },
  });
  return true;
}

async function publishApplicationPaymentUpdate(payment, parsed, ctx = {}) {
  if (payment?.paymentLinkId) {
    const fresh =
      (await Payment.findOne({ _id: payment._id, tenantId: payment.tenantId }).lean()) || payment;
    return enqueueLinkPaymentStatus(fresh, parsed);
  }
  const metadata = parsed?.payment?.metadata || {};
  const applicationId =
    payment?.applicationId || metadata.applicationId || metadata.application_id;
  const memberIdFromMetadata = metadata.memberId || metadata.member_id;
  const memberId =
    payment?.memberId || (!applicationId ? memberIdFromMetadata : null);

  if (!applicationId || memberId) return false;

  const payload = {
    applicationId,
    status: parsed.payment.status,
    paymentIntentId: parsed.payment.paymentIntentId,
    amount: parsed.payment.amount,
    currency: parsed.payment.currency,
    tenantId: payment?.tenantId || ctx.tenantId, // never Stripe metadata
  };

  try {
    await publishDomainEvent(APPLICATION_EVENTS.STATUS_UPDATED, payload, {
      source: parsed.type?.startsWith("manual-")
        ? "account-service"
        : "stripe-webhook",
      eventId: parsed.eventId,
      tenantId: payload.tenantId,
    });
    const logger = (await import("../config/logger.js")).default;
    logger.info(
      {
        applicationId: payload.applicationId,
        paymentIntentId: payload.paymentIntentId,
        tenantId: payload.tenantId,
        status: payload.status,
      },
      "Published application payment update event",
    );
    return true;
  } catch (error) {
    const logger = (await import("../config/logger.js")).default;
    logger.error(
      {
        error: error.message,
        applicationId: payload.applicationId,
        paymentIntentId: payload.paymentIntentId,
        tenantId: payload.tenantId,
      },
      "Failed to publish application payment update event",
    );
    return false;
  }
}

async function publishApplicationPaymentRefreshUpdate(payment, pi, ctx = {}) {
  if (!payment?.applicationId || payment?.memberId || !pi?.id) return;

  const refreshedPayment = paymentDataFromIntent(pi);
  if (!["requires_capture", "succeeded"].includes(refreshedPayment.status)) {
    return;
  }

  const syntheticEventId = `stripe-refresh-${pi.id}-${refreshedPayment.status}`;
  const hasPriorEvent =
    Array.isArray(payment.webhookEventIds) && payment.webhookEventIds.length > 0;
  const alreadyPublished =
    Array.isArray(payment.webhookEventIds) &&
    payment.webhookEventIds.includes(syntheticEventId);
  const statusWasAlreadyObserved =
    payment.status === refreshedPayment.status && hasPriorEvent;

  if (alreadyPublished || statusWasAlreadyObserved) return;

  const published = await publishApplicationPaymentUpdate(
    payment,
    {
      eventId: syntheticEventId,
      type: `stripe-refresh.${refreshedPayment.status}`,
      payment: refreshedPayment,
    },
    ctx,
  );

  if (published) {
    await Payment.updateOne(
      { _id: payment._id },
      { $addToSet: { webhookEventIds: syntheticEventId } },
    );
  }
}

function appendDefinedStripeFields(set, parsed) {
  const capturedAt = normalizeOptionalDate(parsed.payment.capturedAt);
  const canceledAt = normalizeOptionalDate(parsed.payment.canceledAt);

  set["stripe.status"] = parsed.payment.stripeStatus || parsed.payment.status;
  set["stripe.latestEventId"] = parsed.eventId;
  set["stripe.latestEventType"] = parsed.type;

  if (capturedAt) set["stripe.capturedAt"] = capturedAt;
  const capturableUntil = normalizeOptionalDate(parsed.payment.capturableUntil);
  if (capturableUntil) set.capturableUntil = capturableUntil;
  const occurredAt = normalizeOptionalDate(parsed.payment.occurredAt);
  if (occurredAt) set.lastStripeEventAt = occurredAt;
  if (canceledAt) set["stripe.canceledAt"] = canceledAt;
  if (parsed.payment.cancellationReason) {
    set["stripe.cancellationReason"] = parsed.payment.cancellationReason;
  }
  if (parsed.payment.failureCode) {
    set["stripe.failureCode"] = parsed.payment.failureCode;
  }
  if (parsed.payment.failureMessage) {
    set["stripe.failureMessage"] = parsed.payment.failureMessage;
  }
  if (parsed.payment.nextAction) {
    set["stripe.nextAction"] = parsed.payment.nextAction;
  }
}

/**
 * Attaches registration/product identifiers to a Payment whose PaymentIntent
 * was created directly against this endpoint by portal/mobile BEFORE the
 * events-service Registration existed - registrationId/productCode/
 * eventCategoryCode couldn't be included in that original /intents call
 * since nothing had been created yet. Called by events-service's
 * createRegistration right after creating the Registration, instead of
 * creating a second, separate PaymentIntent for a payment the payer already
 * authorized - see events-service's registration-flow.md. Returns the
 * PaymentIntent's current live Stripe status so the caller can trust it
 * rather than assuming.
 */
export async function attachRegistrationToPaymentIntent(
  paymentIntentId,
  ctx = {},
  fields = {},
  caller = {},
) {
  if (!paymentIntentId) {
    throw AppError.badRequest("paymentIntentId is required");
  }
  // P5: attach binds a registration only. It never (re)assigns the person the money is
  // attributed to - profileId/memberId are bound at CRM approval, never from this body.
  for (const forbidden of ["profileId", "memberId"]) {
    if (fields[forbidden] !== undefined && fields[forbidden] !== null && fields[forbidden] !== "") {
      throw bindingError(`${forbidden} cannot be set when attaching a registration`, 400, "FIELD_NOT_ALLOWED");
    }
  }
  const registrationId = normId(fields.registrationId);
  if (!registrationId) {
    throw bindingError("registrationId is required", 400, "REGISTRATION_ID_REQUIRED");
  }
  const tenantId = requireTenantId(ctx);
  if (await isOrphanedIntent(paymentIntentId)) {
    throw bindingError("This PaymentIntent can no longer be used", 409, "INTENT_ORPHANED");
  }
  const payment = await loadPaymentForIntent(paymentIntentId, ctx);

  // Payer: a user caller may only attach an intent it created itself (payer.userId, or
  // audit.createdBy for a legacy row). Applies to CRM too: no flow attaches another
  // payer's authorised funds to a registration. Genuine internal S2S calls skip this.
  const internal = caller.internalRequest === true || ctx.internalRequest === true;
  if (!internal) {
    const uid = normId(ctx.userId);
    if (!uid || effectivePayerUserId(payment) !== uid) {
      throw bindingError("Not permitted for this record", 403, "NOT_OWNER");
    }
  }

  // Purpose: only registration payments can be attached, and only to the matching kind.
  if (!isEventRegistrationPaymentRequest(payment.purpose)) {
    throw bindingError("This payment cannot be attached to a registration", 409, "PURPOSE_MISMATCH");
  }
  if (normId(fields.purpose) !== payment.purpose) {
    throw bindingError("Registration purpose does not match this payment", 409, "PURPOSE_MISMATCH");
  }

  // Target: the registration's event/course (sent by events-service from its own
  // Registration record) must equal the target bound at intent creation.
  const entityType = normId(fields.entityType);
  const entityId = normId(fields.entityId);
  if (entityType !== entityTypeForPurpose(payment.purpose) || !entityId) {
    throw bindingError("entityType/entityId for the registration are required", 400, "TARGET_REQUIRED");
  }
  const target = payment.target || null;
  if (target && target.entityType === "registration") {
    if (normId(target.entityId) !== registrationId) {
      throw bindingError("This PaymentIntent is already attached to another registration", 409, "ALREADY_ATTACHED");
    }
  } else if (target) {
    if (target.entityType !== entityType || normId(target.entityId) !== entityId) {
      throw bindingError("Registration does not match the event/course this payment was made for", 409, "TARGET_MISMATCH");
    }
  } else {
    // Legacy row (created before target existed): the only recorded hint is the portal's
    // free-form metadata.eventId / courseId. When present it must agree.
    const md = payment.metadata instanceof Map ? Object.fromEntries(payment.metadata) : payment.metadata || {};
    const legacyHint = normId(md.courseId || md.eventId);
    if (legacyHint && legacyHint !== entityId) {
      throw bindingError("Registration does not match the event/course this payment was made for", 409, "TARGET_MISMATCH");
    }
  }

  // Amount/currency: registration's server price == stored Payment row.
  const wantAmount = Number(fields.amount);
  const wantCurrency = normId(fields.currency).toLowerCase();
  if (
    !Number.isInteger(wantAmount) ||
    wantAmount !== Number(payment.amount) ||
    !wantCurrency ||
    wantCurrency !== normId(payment.currency).toLowerCase()
  ) {
    throw bindingError("Registration amount/currency does not match this payment", 409, "AMOUNT_MISMATCH");
  }

  const alreadySame = normId(payment.registrationId) === registrationId;
  if (payment.registrationId && !alreadySame) {
    throw bindingError("This PaymentIntent is already attached to another registration", 409, "ALREADY_ATTACHED");
  }

  // A registration that already has a payment (CRM-created / retry-payment intents, a
  // recorded manual payment, or an earlier attach) can never receive another payer's intent.
  // This read covers legacy rows and manual payments (no registrationBinding); the atomic
  // guard against a CONCURRENT attach/create is the registrationBinding unique index below.
  if (!alreadySame) {
    // Legacy holder joins the binding index first (same concurrency guarantee as new rows).
    await adoptLegacyRegistrationHolder({ tenantId, registrationId, excludeId: payment._id });
    const other = await Payment.findOne({
      tenantId,
      registrationId,
      _id: { $ne: payment._id },
    })
      .select({ _id: 1 })
      .lean();
    if (other) {
      throw bindingError("This registration already has a payment", 409, "REGISTRATION_ALREADY_HAS_PAYMENT");
    }
  }
  // The intent itself must still be able to take money.
  if (TERMINAL_UNPAID_STATUSES.includes(payment.status) || payment.isActiveAttempt === false) {
    throw bindingError("This PaymentIntent can no longer be used", 409, "INTENT_NOT_ACTIVE");
  }

  // Live Stripe PaymentIntent must agree with the row too.
  const stripe = getStripe();
  const current = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (
    Number(current.amount) !== Number(payment.amount) ||
    normId(current.currency).toLowerCase() !== normId(payment.currency).toLowerCase()
  ) {
    throw bindingError("PaymentIntent amount/currency does not match this payment", 409, "STRIPE_MISMATCH");
  }

  // Single, atomic attach: binds only when unattached (or already bound to this same
  // registration -> idempotent). A concurrent attach to a different registration loses.
  // Both directions in ONE document update: the intent's registrationId is set-once
  // (filter), and the registration's active binding is claimed through the
  // {tenantId, registrationBinding} unique index - so of two different intents racing onto
  // one registration exactly one wins and the other gets E11000 -> 409, with nothing written.
  const set = {
    registrationId,
    registrationBinding: registrationId,
    "audit.updatedBy": ctx.userId || ctx.memberId || "system",
  };
  if (fields.productCode) set.productCode = String(fields.productCode);
  if (fields.eventCategoryCode) set.eventCategoryCode = String(fields.eventCategoryCode);
  let updated;
  try {
    updated = await Payment.findOneAndUpdate(
      {
        _id: payment._id,
        tenantId,
        $and: [
          {
            $or: [
              { registrationId: { $exists: false } },
              { registrationId: null },
              { registrationId: "" },
              { registrationId },
            ],
          },
          {
            $or: [
              { registrationBinding: { $exists: false } },
              { registrationBinding: null },
              { registrationBinding: registrationId },
            ],
          },
        ],
      },
      { $set: set, $min: { attachedAt: new Date() } },
      { new: true },
    ).lean();
  } catch (e) {
    if (isBindingDuplicateKey(e)) {
      throw bindingError("This registration already has a payment", 409, "REGISTRATION_ALREADY_HAS_PAYMENT");
    }
    throw e;
  }
  if (!updated) {
    throw bindingError("This PaymentIntent is already attached to another registration", 409, "ALREADY_ATTACHED");
  }

  return {
    ok: true,
    paymentId: payment._id.toString(),
    registrationId,
    alreadyAttached: alreadySame,
    status: normalizeStripeStatusForPayment(current.status),
    stripeStatus: current.status,
    amount: current.amount,
    currency: current.currency,
  };
}

const LINK_FIELDS = ["profileId", "memberId"];

function unsetOrEqual(field, value) {
  return {
    $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: "" }, { [field]: value }],
  };
}

/**
 * P5: attach profileId / memberId to a Payment ONCE. A value is written only while the field
 * is unset (or already equal); a different existing value is never overwritten - the whole
 * update is refused with 409 PROFILE_ALREADY_BOUND and nothing changes. Application-fee
 * payments are attributed through their applicationId and never accept a link (400).
 * Conditional single update in the payment's tenant, so two concurrent different links cannot
 * both win.
 */
export async function setPaymentLinkOnce(payment, linkFields = {}) {
  const set = {};
  for (const f of LINK_FIELDS) {
    const v = linkFields?.[f] == null ? "" : String(linkFields[f]).trim();
    if (v) set[f] = v;
  }
  if (Object.keys(set).length === 0) return { changed: false };
  if (payment.purpose === "applicationFee" || (payment.applicationId && !payment.registrationId)) {
    throw new AppError(
      "profileId/memberId cannot be supplied for an application payment",
      400,
      "LINK_NOT_ALLOWED",
    );
  }
  const filter = {
    _id: payment._id,
    tenantId: payment.tenantId,
    $and: Object.entries(set).map(([f, v]) => unsetOrEqual(f, v)),
  };
  const r = await Payment.updateOne(filter, { $set: set });
  if (!r || r.matchedCount === 0) {
    throw new AppError(
      "This payment is already linked to a different profile or member",
      409,
      "PROFILE_ALREADY_BOUND",
    );
  }
  for (const [f, v] of Object.entries(set)) payment[f] = v;
  return { changed: r.modifiedCount > 0 };
}

const NOT_CAPTURABLE_ROW = new Set(["canceled", "refunded", "partially_refunded", "refund_required", "failed"]);

/**
 * P5: the live PaymentIntent must be the one this row was created for - same amount, currency
 * and (when Stripe carries one) tenant - before account captures or cancels it.
 */
function assertStripeMatchesRow(pi, payment) {
  const metaTenant = pi?.metadata?.tenantId;
  if (
    Number(pi?.amount) !== Number(payment.amount) ||
    String(pi?.currency || "").toLowerCase() !== String(payment.currency || "").toLowerCase() ||
    (metaTenant && String(metaTenant) !== String(payment.tenantId))
  ) {
    throw new AppError("PaymentIntent does not match this payment", 409, "STRIPE_MISMATCH");
  }
}

async function recordBoundAudit(payment, bound, status, ctx = {}) {
  if (!bound) return;
  await Payment.updateOne(
    { _id: payment._id, tenantId: payment.tenantId },
    {
      $push: { auditHistory: boundAuditEntry(bound.cmd, status, ctx.correlationId) },
      $set: { "audit.updatedBy": `internal:${bound.cmd.actorUserId}` },
    },
  );
}

export async function capturePaymentIntent(paymentIntentId, ctx = {}, linkFields = {}, opts = {}) {
  if (!paymentIntentId) {
    throw AppError.badRequest("paymentIntentId is required");
  }

  if (await isOrphanedIntent(paymentIntentId)) {
    throw bindingError("This PaymentIntent can no longer be used", 409, "INTENT_ORPHANED");
  }

  const stripe = getStripe();
  const payment = await loadPaymentForIntent(paymentIntentId, ctx);
  const { bound } = opts;

  // P5 transition rules (both the bound command and the transitional user path).
  if (payment.mode && payment.mode !== "stripe") {
    throw new AppError("This payment is not a card payment", 409, "TRANSITION_NOT_ALLOWED");
  }
  if (payment.isActiveAttempt === false) {
    throw new AppError("This payment attempt was superseded", 409, "PAYMENT_SUPERSEDED");
  }
  if (NOT_CAPTURABLE_ROW.has(payment.status)) {
    throw new AppError(`A ${payment.status} payment cannot be captured`, 409, "TRANSITION_NOT_ALLOWED");
  }
  // P5 payer binding: a registration payment may be captured only while it is the registration's
  // CURRENT holder (legacy pre-binding rows are adopted first). A released/replaced row never captures.
  if (payment.registrationId && payment.registrationBinding !== String(payment.registrationId)) {
    await adoptLegacyRegistrationHolder({ tenantId: payment.tenantId, registrationId: String(payment.registrationId) });
    const fresh = await Payment.findOne({ _id: payment._id, tenantId: payment.tenantId }).select({ registrationBinding: 1 }).lean();
    if (fresh?.registrationBinding !== String(payment.registrationId)) {
      throw new AppError("This payment is no longer the registration's payment", 409, "PAYMENT_NOT_BOUND");
    }
    payment.registrationBinding = fresh.registrationBinding;
  }

  // Callers resolving profileId/memberId only at approval (e.g. events-service
  // linking a just-created/linked attendee Profile) can attach it here,
  // immediately before capture - reconcileStripeEvent below re-reads the
  // Payment doc fresh from the DB, so this is picked up by GL posting
  // (postJournalForPayment) without any separate reassignment step.
  // P5: set-once only - an already-linked payment is never re-pointed at another profile or
  // member (409 PROFILE_ALREADY_BOUND, nothing captured).
  await setPaymentLinkOnce(payment, linkFields);

  const current = await stripe.paymentIntents.retrieve(paymentIntentId);
  assertStripeMatchesRow(current, payment);

  if (current.status === "succeeded") {
    await reconcileStripeEvent(
      {
        eventId: `manual-capture-existing-${paymentIntentId}`,
        type: "payment_intent.succeeded",
        payment: paymentDataFromIntent(current),
      },
      ctx,
    );
    await recordBoundAudit(payment, bound, "succeeded", ctx);
    return {
      ok: true,
      captured: false,
      alreadyCaptured: true,
      status: "succeeded",
      paymentIntentId,
      paymentId: payment._id.toString(),
    };
  }

  if (current.status !== "requires_capture") {
    throw new AppError(
      `PaymentIntent cannot be captured from status ${current.status}`,
      409,
      "NOT_CAPTURABLE",
      { stripeStatus: current.status, paymentIntentId },
    );
  }

  // P5: the Stripe idempotency key is derived from the stored row, never from the request.
  const captured = await stripe.paymentIntents.capture(
    paymentIntentId,
    {},
    { idempotencyKey: stripeIdempotencyKey("capture", payment._id.toString(), paymentIntentId) },
  );

  if (captured.status !== "succeeded") {
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: normalizeStripeStatusForPayment(captured.status),
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );
    throw AppError.conflict(
      `Payment capture did not succeed. Stripe status is ${captured.status}`,
      { stripeStatus: captured.status, paymentIntentId },
    );
  }

  await reconcileStripeEvent(
    {
      eventId: `manual-capture-${paymentIntentId}`,
      type: "payment_intent.succeeded",
      payment: paymentDataFromIntent(captured),
    },
    ctx,
  );
  await recordBoundAudit(payment, bound, "succeeded", ctx);

  return {
    ok: true,
    captured: true,
    status: "succeeded",
    paymentIntentId,
    paymentId: payment._id.toString(),
  };
}

export async function cancelPaymentIntent(paymentIntentId, ctx = {}, opts = {}) {
  if (!paymentIntentId) {
    throw AppError.badRequest("paymentIntentId is required");
  }

  const stripe = getStripe();
  const payment = await loadPaymentForIntent(paymentIntentId, ctx);
  const { bound } = opts;
  if (payment.mode && payment.mode !== "stripe") {
    throw new AppError("This payment is not a card payment", 409, "TRANSITION_NOT_ALLOWED");
  }
  // A superseded attempt may still be cancelled (releases a stray hold).
  const current = await stripe.paymentIntents.retrieve(paymentIntentId);
  assertStripeMatchesRow(current, payment);

  if (current.status === "canceled") {
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: "canceled",
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );
    await recordBoundAudit(payment, bound, "canceled", ctx);
    return {
      ok: true,
      canceled: false,
      alreadyCanceled: true,
      status: "canceled",
      paymentIntentId,
      paymentId: payment._id.toString(),
    };
  }

  if (current.status === "succeeded") {
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: "refund_required",
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );
    await recordBoundAudit(payment, bound, "refund_required", ctx);
    return {
      ok: true,
      canceled: false,
      status: "refund_required",
      stripeStatus: "succeeded",
      paymentIntentId,
      paymentId: payment._id.toString(),
    };
  }

  if (current.status !== "requires_capture") {
    const nextStatus =
      current.status === "requires_payment_method"
        ? "payment_required"
        : normalizeStripeStatusForPayment(current.status);
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: nextStatus,
          "stripe.status": current.status,
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );
    return {
      ok: true,
      canceled: false,
      status: nextStatus,
      stripeStatus: current.status,
      paymentIntentId,
      paymentId: payment._id.toString(),
    };
  }

  const canceled = await stripe.paymentIntents.cancel(
    paymentIntentId,
    {},
    { idempotencyKey: stripeIdempotencyKey("cancel", payment._id.toString(), paymentIntentId) },
  );

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: normalizeStripeStatusForPayment(canceled.status),
        "audit.updatedBy": ctx.userId || ctx.memberId || "system",
      },
    },
  );

  await recordBoundAudit(payment, bound, normalizeStripeStatusForPayment(canceled.status), ctx);

  return {
    ok: true,
    canceled: canceled.status === "canceled",
    status: normalizeStripeStatusForPayment(canceled.status),
    paymentIntentId,
    paymentId: payment._id.toString(),
  };
}

/**
 * Payment-link fallback for a PaymentIntent event that arrives without (or before)
 * checkout.session.completed. The PI metadata written at session creation only LOCATES the
 * link's Payment; the persisted record decides: it must be that link's Payment, not yet
 * bound to another PaymentIntent, with the same amount and currency, and a metadata tenant
 * (when present) must equal the persisted tenant. Otherwise nothing is attached.
 */
async function attachLinkPaymentFromIntentMetadata(parsed) {
  const m = parsed.payment.metadata || {};
  const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
  if (!isId(m.paymentId) || !isId(m.paymentLinkId)) return null;
  const candidate = await Payment.findOne({ _id: m.paymentId, paymentLinkId: m.paymentLinkId }).lean();
  if (!candidate) return null;
  if (m.tenantId && String(m.tenantId) !== String(candidate.tenantId)) return null;
  if (candidate.stripe?.paymentIntentId) {
    return candidate.stripe.paymentIntentId === parsed.payment.paymentIntentId ? candidate : null;
  }
  if (
    Number(parsed.payment.amount) !== Number(candidate.amount) ||
    String(parsed.payment.currency || "").toLowerCase() !== String(candidate.currency || "").toLowerCase()
  ) {
    return null;
  }
  return Payment.findOneAndUpdate(
    { _id: candidate._id, tenantId: candidate.tenantId, "stripe.paymentIntentId": { $in: [null] } },
    { $set: { "stripe.paymentIntentId": parsed.payment.paymentIntentId } },
    { new: true },
  ).lean();
}

export async function reconcileStripeEvent(input, ctx) {
  const parsed = zReconcile.parse(input);
  ensureIntegerCents(parsed.payment.amount);

  // Webhook / in-process capture callers: search by paymentIntentId first (without
  // tenantId filter) so the stored payment's tenant wins over a webhook metadata tenant.
  // HTTP callers (POST /payments/reconcile via reconcilePaymentFromStripe) pass
  // ctx.scopeToTenantId: the lookup is then pinned to that trusted tenant and an
  // unknown PaymentIntent is rejected instead of upserted.
  const scopedTenantId = ctx?.scopeToTenantId
    ? String(ctx.scopeToTenantId)
    : null;
  const intentLookup = {
    "stripe.paymentIntentId": parsed.payment.paymentIntentId,
  };
  if (scopedTenantId) intentLookup.tenantId = scopedTenantId;

  let existingPayment = null;
  if (parsed.payment.paymentIntentId) {
    existingPayment = await Payment.findOne(intentLookup).lean();
    if (!existingPayment && !scopedTenantId) {
      existingPayment = await attachLinkPaymentFromIntentMetadata(parsed);
    }
    if (!existingPayment && scopedTenantId) {
      throw AppError.notFound("Payment not found for PaymentIntent");
    }

    if (existingPayment?.webhookEventIds?.includes(parsed.eventId)) {
      const logger = (await import("../config/logger.js")).default;
      logger.info(
        {
          paymentId: existingPayment._id,
          paymentIntentId: parsed.payment.paymentIntentId,
          eventId: parsed.eventId,
          eventType: parsed.type,
        },
        "Skipping duplicate Stripe webhook event",
      );
      await publishApplicationPaymentUpdate(existingPayment, parsed, ctx);
      return { ok: true, duplicate: true };
    }

  }

  // Tenant authority (Phase 2C): the PERSISTED payment decides the tenant. Stripe metadata
  // (ctx.metadataTenantId, webhook path) may only help locate the record; it can never create
  // a payment in a tenant or move one. Unscoped callers (webhook, in-process capture/cancel)
  // must find an existing payment, and neither the trusted caller tenant nor the metadata
  // tenant may disagree with it.
  if (!scopedTenantId) {
    const logger = (await import("../config/logger.js")).default;
    if (!existingPayment) {
      logger.warn(
        { paymentIntentId: parsed.payment.paymentIntentId, eventId: parsed.eventId, eventType: parsed.type },
        "Stripe event rejected: no persisted payment for this PaymentIntent (metadata is not a tenant authority)",
      );
      return { ok: false, rejected: "unknown_payment_intent" };
    }
    const persistedTenant = String(existingPayment.tenantId);
    const claims = [
      ["caller", ctx?.tenantId],
      ["stripe-metadata", ctx?.metadataTenantId],
    ].filter(([, t]) => t != null && String(t) !== "" && String(t) !== persistedTenant);
    if (claims.length) {
      logger.warn(
        {
          paymentId: existingPayment._id,
          paymentIntentId: parsed.payment.paymentIntentId,
          eventId: parsed.eventId,
          mismatchedSources: claims.map(([src]) => src),
        },
        "Stripe event rejected: tenant does not match the persisted payment's tenant",
      );
      return { ok: false, rejected: "tenant_mismatch" };
    }
  }

  // Log if we found an existing payment
  if (existingPayment) {
    const logger = (await import("../config/logger.js")).default;
    logger.info(
      {
        paymentId: existingPayment._id,
        paymentIntentId: parsed.payment.paymentIntentId,
        existingTenantId: existingPayment.tenantId,
        webhookTenantId: ctx.tenantId,
      },
      "Found existing payment for webhook reconciliation",
    );
  }

  // Extract memberId and applicationId from metadata
  // IMPORTANT: Do NOT use userId as memberId - userId is just a user identifier, not a member identifier
  // For application payments, applicationId should be used, not memberId
  // Also preserve existing memberId/applicationId from payment if metadata doesn't have them
  const metadata = parsed.payment.metadata || {};
  const memberIdFromMetadata =
    metadata.memberId || metadata.member_id || undefined; // Do not use userId as memberId
  const applicationIdFromMetadata =
    metadata.applicationId || metadata.application_id || undefined;

  // Use metadata values if present, otherwise preserve existing payment values
  // This ensures journal entries can be created even if webhook metadata is incomplete
  // Prioritize applicationId - if it exists in metadata, use it (even if existing payment has memberId)
  // The persisted payment's links win: metadata may fill a missing link but never re-point
  // a payment at another application/member.
  const applicationId =
    existingPayment?.applicationId || applicationIdFromMetadata || undefined;
  const memberId =
    // Only use memberId if applicationId is not present
    (!applicationId && (existingPayment?.memberId || memberIdFromMetadata)) ||
    undefined;
  if (
    existingPayment &&
    ((existingPayment.applicationId && applicationIdFromMetadata && String(applicationIdFromMetadata) !== String(existingPayment.applicationId)) ||
      (existingPayment.memberId && memberIdFromMetadata && String(memberIdFromMetadata) !== String(existingPayment.memberId)))
  ) {
    const logger = (await import("../config/logger.js")).default;
    logger.warn(
      { paymentId: existingPayment._id, paymentIntentId: parsed.payment.paymentIntentId, eventId: parsed.eventId },
      "Stripe metadata application/member differs from the persisted payment - keeping the persisted links",
    );
  }

  // Build filter - ALWAYS use existing payment's tenantId if found
  // This prevents creating duplicates when tenantId doesn't match
  const filter = {
    tenantId: existingPayment?.tenantId || scopedTenantId,
    "stripe.paymentIntentId": parsed.payment.paymentIntentId,
  };

  // If no existing payment and no tenantId, we can't safely upsert
  if (!existingPayment && !filter.tenantId) {
    throw AppError.badRequest(
      "tenantId is required for payment reconciliation when no existing payment found",
      { paymentIntentId: parsed.payment.paymentIntentId },
    );
  }

  const lifecycleLogger = (await import("../config/logger.js")).default;
  const decision = decideWebhookStatus(existingPayment, parsed, {
    log: (obj, msg) => lifecycleLogger.warn(obj, msg),
  });
  const finalStatus = decision.status;
  const auditEntry = buildWebhookAuditEntry(parsed, finalStatus);

  const update = {
    $set: {
      amount: parsed.payment.amount,
      currency: parsed.payment.currency,
      status: finalStatus,
      "stripe.chargeId": parsed.payment.chargeId,
      "stripe.customerId": parsed.payment.customerId,
      "stripe.paymentMethodId": parsed.payment.paymentMethodId,
      "stripe.paymentIntentId": parsed.payment.paymentIntentId, // Ensure it's set
      metadata: metadata,
      "audit.updatedBy": ctx.userId || ctx.memberId || "system",
    },
    $addToSet: {
      webhookEventIds: parsed.eventId,
    },
    $push: {
      auditHistory: {
        $each: [auditEntry],
        $slice: -100,
      },
    },
  };

  appendDefinedStripeFields(update.$set, parsed);

  // Set memberId and applicationId - prioritize applicationId over memberId
  // If applicationId is present, do not set memberId (payment is for an application, not an approved member)
  // This is critical for journal entry creation
  if (applicationId) {
    // Application payment - use applicationId, clear memberId if it was incorrectly set
    update.$set.applicationId = applicationId;
    update.$unset = update.$unset || {};
    update.$unset.memberId = "";
  } else if (memberId) {
    // Member payment - only set memberId if applicationId is not present
    update.$set.memberId = memberId;
  } else {
    // Preserve existing values if metadata doesn't have them
    if (existingPayment?.applicationId) {
      update.$set.applicationId = existingPayment.applicationId;
      update.$unset = update.$unset || {};
      update.$unset.memberId = "";
    } else if (existingPayment?.memberId) {
      update.$set.memberId = existingPayment.memberId;
    }
  }

  // If existing payment found, ensure we update the correct one
  if (existingPayment) {
    filter._id = existingPayment._id;
    filter.webhookEventIds = { $ne: parsed.eventId };
  }

  const options = {
    // P5 (b7): reconciliation never creates a Payment. Every path above returns or throws when
    // no persisted payment exists, so the former upsert (with a default purpose "subscriptionFee")
    // could only ever mint a row whose purpose and binding nobody authorised. Fail closed instead.
    upsert: false,
    new: true,
    setDefaultsOnInsert: true,
  };

  try {
    const doc = await Payment.findOneAndUpdate(filter, update, options);

    if (!doc) {
      const logger = (await import("../config/logger.js")).default;
      logger.error(
        {
          paymentIntentId: parsed.payment.paymentIntentId,
          filter,
          existingPayment: existingPayment?._id,
          update,
          options,
        },
        "Payment.findOneAndUpdate returned null - payment not found or not updated",
      );

      // Try to find the payment again - maybe it was created by another request
      const retryPayment = await Payment.findOne(intentLookup).lean();

      if (retryPayment) {
        if (retryPayment.webhookEventIds?.includes(parsed.eventId)) {
          logger.info(
            {
              paymentId: retryPayment._id,
              paymentIntentId: parsed.payment.paymentIntentId,
              eventId: parsed.eventId,
            },
            "Payment webhook event was processed by another worker",
          );
          await publishApplicationPaymentUpdate(retryPayment, parsed, ctx);
          return { ok: true, duplicate: true };
        }

        logger.info(
          {
            paymentId: retryPayment._id,
            paymentIntentId: parsed.payment.paymentIntentId,
            status: retryPayment.status,
          },
          "Found payment on retry - payment was created by another request",
        );

        // Ensure journal entry exists if status is succeeded
        if (
          parsed.payment.status === "succeeded" &&
          retryPayment.status === "succeeded"
        ) {
          const GLTransactionModule =
            await import("../models/glTransaction.model.js");
          const GLTransaction = GLTransactionModule.default;
          const existingJournal = await GLTransaction.findOne({
            tenantId: retryPayment.tenantId,
            docNo: `RCP-${retryPayment._id}`,
          }).lean();

          if (!existingJournal) {
            try {
              const journal = await postJournalForPayment(
                retryPayment,
                paymentJournalCtx(retryPayment, ctx),
              );
              if (journal) {
                logger.info(
                  {
                    paymentId: retryPayment._id,
                    journalId: journal._id,
                    docNo: journal.docNo,
                  },
                  "Journal entry created for payment found on retry",
                );
              }
            } catch (journalError) {
              logger.error(
                {
                  paymentId: retryPayment._id,
                  error: journalError.message,
                },
                "Failed to create journal entry for payment found on retry",
              );
            }
          }
        }

        await publishApplicationPaymentUpdate(retryPayment, parsed, ctx);
        return { ok: true };
      }

      throw new Error(
        `Failed to update or create payment for paymentIntentId: ${parsed.payment.paymentIntentId}`,
      );
    }

    // Only create journal entry if status is succeeded and we haven't already created one
    if (parsed.payment.status === "succeeded") {
      // Check if journal entry already exists for this payment
      const GLTransactionModule =
        await import("../models/glTransaction.model.js");
      const GLTransaction = GLTransactionModule.default;
      const existingJournal = await GLTransaction.findOne({
        tenantId: doc.tenantId,
        docNo: `RCP-${doc._id}`,
      }).lean();

      if (!existingJournal) {
        const logger = (await import("../config/logger.js")).default;
        logger.info(
          {
            paymentId: doc._id,
            paymentIntentId: parsed.payment.paymentIntentId,
            memberId: doc.memberId,
            applicationId: doc.applicationId,
            status: doc.status,
          },
          "Creating journal entry for succeeded payment",
        );
        try {
          const journal = await postJournalForPayment(
            doc,
            paymentJournalCtx(doc, ctx),
          );
          if (journal) {
            logger.info(
              {
                paymentId: doc._id,
                journalId: journal._id,
                docNo: journal.docNo,
              },
              "Journal entry created successfully for payment",
            );
          } else {
            logger.warn(
              {
                paymentId: doc._id,
                memberId: doc.memberId,
                applicationId: doc.applicationId,
              },
              "Journal entry creation returned null - missing memberId or applicationId",
            );
          }
        } catch (journalError) {
          logger.error(
            {
              paymentId: doc._id,
              error: journalError.message,
              stack: journalError.stack,
            },
            "Failed to create journal entry for payment",
          );
          // Don't throw - payment is reconciled, journal can be created manually
        }
      } else {
        const logger = (await import("../config/logger.js")).default;
        logger.info(
          {
            paymentId: doc._id,
            journalId: existingJournal._id,
            docNo: existingJournal.docNo,
          },
          "Journal entry already exists for payment",
        );
      }
    } else if (parsed.payment.status === "requires_capture" && doc.ledgerDomain === "events" && doc.registrationId) {
      // Manual-capture events/course registration payment has been
      // authorized (funds held, not yet captured) - let events-service know
      // so it can surface "payment authorized, awaiting CRM approval"
      // instead of leaving the registration looking untouched. No GL entry
      // is posted here - that only happens on capture (status "succeeded"
      // above), at CRM approval time.
      const { publishPaymentStatusUpdated } = await import(
        "../handlers/eventRegistration.approval.listener.js"
      );
      await publishPaymentStatusUpdated({
        tenantId: doc.tenantId, // the persisted payment's tenant, never caller/metadata
        paymentId: String(doc._id),
        paymentIntentId: doc.stripe?.paymentIntentId || null,
        registrationId: doc.registrationId,
        status: "requires_capture",
      });
    }

    await publishApplicationPaymentUpdate(doc, parsed, ctx);
    return { ok: true };
  } catch (error) {
    const logger = (await import("../config/logger.js")).default;

    logger.error(
      {
        error: error.message,
        stack: error.stack,
        paymentIntentId: parsed.payment.paymentIntentId,
        existingPayment: existingPayment?._id,
        status: parsed.payment.status,
      },
      "Error in reconcileStripeEvent",
    );

    // If payment already exists and is succeeded, that's okay - just ensure journal entry exists
    if (
      existingPayment &&
      existingPayment.status === "succeeded" &&
      parsed.payment.status === "succeeded"
    ) {
      logger.info(
        {
          paymentId: existingPayment._id,
          paymentIntentId: parsed.payment.paymentIntentId,
          existingStatus: existingPayment.status,
        },
        "Payment already succeeded - ensuring journal entry exists",
      );

      // Check if journal entry exists
      const GLTransactionModule =
        await import("../models/glTransaction.model.js");
      const GLTransaction = GLTransactionModule.default;
      const existingJournal = await GLTransaction.findOne({
        tenantId: existingPayment.tenantId,
        docNo: `RCP-${existingPayment._id}`,
      }).lean();

      if (!existingJournal) {
        // Try to get the full payment document
        const fullPayment = await Payment.findOne({
          _id: existingPayment._id,
          tenantId: existingPayment.tenantId,
        }).lean();
        if (fullPayment) {
          try {
            // postJournalForPayment is defined in this file, call it directly
            // We need to import it at the top level, but for now use the function reference
            const journal = await postJournalForPayment(
              fullPayment,
              paymentJournalCtx(fullPayment, ctx),
            );
            if (journal) {
              logger.info(
                {
                  paymentId: fullPayment._id,
                  journalId: journal._id,
                  docNo: journal.docNo,
                },
                "Journal entry created for already-succeeded payment",
              );
            }
          } catch (journalError) {
            logger.error(
              {
                paymentId: fullPayment._id,
                error: journalError.message,
              },
              "Failed to create journal entry for already-succeeded payment",
            );
          }
        }
      }

      await publishApplicationPaymentUpdate(existingPayment, parsed, ctx);
      return { ok: true };
    }

    // Handle duplicate key errors (race condition)
    if (error.code === 11000) {
      // Try to find the existing payment by paymentIntentId alone
      const existing = await Payment.findOne({
        "stripe.paymentIntentId": parsed.payment.paymentIntentId,
      }).lean();

      if (existing) {
        if (existing.webhookEventIds?.includes(parsed.eventId)) {
          logger.info(
            {
              paymentId: existing._id,
              paymentIntentId: parsed.payment.paymentIntentId,
              eventId: parsed.eventId,
            },
            "Duplicate key recovery found already-processed webhook event",
          );
          return { ok: true, duplicate: true };
        }

        // Update the existing payment instead
        // Preserve existing memberId/applicationId if metadata doesn't have them
        const memberIdToUse = memberId || existing.memberId;
        const applicationIdToUse = applicationId || existing.applicationId;
        const recoveryStatus = decideWebhookStatus(existing, parsed).status;
        const recoveryAuditEntry = buildWebhookAuditEntry(
          parsed,
          recoveryStatus,
        );

        const updateOnly = {
          $set: {
            amount: parsed.payment.amount,
            currency: parsed.payment.currency,
            status: recoveryStatus,
            "stripe.chargeId": parsed.payment.chargeId,
            "stripe.customerId": parsed.payment.customerId,
            "stripe.paymentMethodId": parsed.payment.paymentMethodId,
            "stripe.paymentIntentId": parsed.payment.paymentIntentId,
            metadata: metadata,
            "audit.updatedBy": ctx.userId || ctx.memberId || "system",
          },
          $addToSet: {
            webhookEventIds: parsed.eventId,
          },
          $push: {
            auditHistory: {
              $each: [recoveryAuditEntry],
              $slice: -100,
            },
          },
        };
        appendDefinedStripeFields(updateOnly.$set, parsed);
        if (memberIdToUse) updateOnly.$set.memberId = memberIdToUse;
        if (applicationIdToUse)
          updateOnly.$set.applicationId = applicationIdToUse;

        const doc = await Payment.findOneAndUpdate(
          { _id: existing._id, webhookEventIds: { $ne: parsed.eventId } },
          updateOnly,
          { new: true },
        );

        if (!doc) {
          return { ok: true, duplicate: true };
        }

        if (parsed.payment.status === "succeeded") {
          const GLTransactionModule =
            await import("../models/glTransaction.model.js");
          const GLTransaction = GLTransactionModule.default;
          const existingJournal = await GLTransaction.findOne({
            tenantId: doc.tenantId,
            docNo: `RCP-${doc._id}`,
          }).lean();

          if (!existingJournal) {
            const logger = (await import("../config/logger.js")).default;
            logger.info(
              {
                paymentId: doc._id,
                paymentIntentId: parsed.payment.paymentIntentId,
                memberId: doc.memberId,
                applicationId: doc.applicationId,
                status: doc.status,
              },
              "Creating journal entry for succeeded payment (duplicate key recovery)",
            );
            try {
              const journal = await postJournalForPayment(
                doc,
                paymentJournalCtx(doc, ctx),
              );
              if (journal) {
                logger.info(
                  {
                    paymentId: doc._id,
                    journalId: journal._id,
                    docNo: journal.docNo,
                  },
                  "Journal entry created successfully for payment (duplicate key recovery)",
                );
              } else {
                logger.warn(
                  {
                    paymentId: doc._id,
                    memberId: doc.memberId,
                    applicationId: doc.applicationId,
                  },
                  "Journal entry creation returned null - missing memberId or applicationId (duplicate key recovery)",
                );
              }
            } catch (journalError) {
              logger.error(
                {
                  paymentId: doc._id,
                  error: journalError.message,
                  stack: journalError.stack,
                },
                "Failed to create journal entry for payment (duplicate key recovery)",
              );
              // Don't throw - payment is reconciled, journal can be created manually
            }
          }
        }

        await publishApplicationPaymentUpdate(doc, parsed, ctx);
        return { ok: true };
      }
    }

    // If we get here, it's an unexpected error
    // Try one more time to find the payment and create journal entry if needed
    if (
      parsed.payment.paymentIntentId &&
      parsed.payment.status === "succeeded"
    ) {
      const finalRetry = await Payment.findOne({
        "stripe.paymentIntentId": parsed.payment.paymentIntentId,
      }).lean();

      if (finalRetry && finalRetry.status === "succeeded") {
        logger.info(
          {
            paymentId: finalRetry._id,
            paymentIntentId: parsed.payment.paymentIntentId,
          },
          "Found payment on final retry - ensuring journal entry exists",
        );

        const GLTransactionModule =
          await import("../models/glTransaction.model.js");
        const GLTransaction = GLTransactionModule.default;
        const existingJournal = await GLTransaction.findOne({
          tenantId: finalRetry.tenantId,
          docNo: `RCP-${finalRetry._id}`,
        }).lean();

        if (!existingJournal) {
          try {
            const journal = await postJournalForPayment(
              finalRetry,
              paymentJournalCtx(finalRetry, ctx),
            );
            if (journal) {
              logger.info(
                {
                  paymentId: finalRetry._id,
                  journalId: journal._id,
                  docNo: journal.docNo,
                },
                "Journal entry created on final retry",
              );
            }
          } catch (journalError) {
            logger.error(
              {
                paymentId: finalRetry._id,
                error: journalError.message,
              },
              "Failed to create journal entry on final retry",
            );
          }
        }

        // Return success even if original update failed - payment exists and journal is handled
        await publishApplicationPaymentUpdate(finalRetry, parsed, ctx);
        return { ok: true };
      }
    }

    // Log the error but don't throw - allow webhook to return 200
    // This prevents Stripe from retrying and creating more errors
    logger.error(
      {
        error: error.message,
        stack: error.stack,
        paymentIntentId: parsed.payment.paymentIntentId,
      },
      "reconcileStripeEvent failed - payment may need manual reconciliation",
    );

    // Webhook callers (ctx.rethrowOnError) answer 500 so Stripe retries a transient failure;
    // the retry is safe because the event id is only recorded on a successful update.
    // Other callers (capture/cancel/HTTP reconcile) keep the existing swallow-and-log.
    if (ctx?.rethrowOnError) throw error;

    // Return success to prevent webhook retries
    return {
      ok: true,
      warning: "Payment reconciliation had errors but was attempted",
    };
  }
}

/**
 * POST /api/payments/reconcile (HTTP). Never trusts the caller's amount/status/currency/
 * metadata: the Payment is looked up by {tenantId: trusted tenant, paymentIntentId}, the
 * PaymentIntent is re-read from Stripe (the authoritative source for what was actually
 * authorized/captured), and only that Stripe state is fed into reconcileStripeEvent.
 * A PaymentIntent whose Stripe metadata names a different tenant is rejected.
 */
export async function reconcilePaymentFromStripe(input, ctx = {}, deps = {}) {
  const parsed = zReconcileRequest.parse(input || {});
  const tenantId = ctx?.tenantId ? String(ctx.tenantId) : null;
  if (!tenantId) {
    throw AppError.unauthorized("Tenant context required");
  }
  const paymentIntentId = String(
    parsed.paymentIntentId || parsed.payment?.paymentIntentId,
  ).trim();

  const PaymentModel = deps.Payment || Payment;
  const reconcile = deps.reconcileStripeEvent || reconcileStripeEvent;

  const payment = await PaymentModel.findOne({
    tenantId,
    "stripe.paymentIntentId": paymentIntentId,
  }).lean();
  if (!payment) {
    throw AppError.notFound("Payment not found for PaymentIntent");
  }

  const stripe = (deps.getStripe || getStripe)();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!pi || pi.id !== paymentIntentId) {
    throw AppError.notFound("Payment not found for PaymentIntent");
  }
  const stripeTenant = pi.metadata?.tenantId || pi.metadata?.tenant_id;
  if (stripeTenant && String(stripeTenant) !== tenantId) {
    const logger = (await import("../config/logger.js")).default;
    logger.warn(
      { paymentId: String(payment._id), paymentIntentId, tenantId },
      "Reconcile rejected: Stripe PaymentIntent metadata tenant does not match caller tenant",
    );
    throw AppError.notFound("Payment not found for PaymentIntent");
  }

  const paymentData = paymentDataFromIntent(pi);
  const result = await reconcile(
    {
      eventId: `manual-reconcile-${pi.id}-${pi.status}-${paymentData.amount}`,
      type: `manual-reconcile.${paymentData.status}`,
      payment: paymentData,
    },
    { ...ctx, tenantId, scopeToTenantId: tenantId },
  );
  return {
    ok: true,
    paymentId: String(payment._id),
    paymentIntentId,
    status: paymentData.status,
    amount: paymentData.amount,
    currency: paymentData.currency,
    duplicate: result?.duplicate === true,
  };
}

export async function recordExternal(input, ctx) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  const parsed = zRecordExternal.parse(input);
  ensureIntegerCents(parsed.amount);

  if (parsed.direction === "in") {
    const payment = await Payment.create({
      tenantId: ctx.tenantId,
      purpose: "subscriptionFee",
      amount: parsed.amount,
      currency: parsed.currency,
      status: "succeeded",
      mode: "external",
      memberId: parsed.memberId,
      applicationId: parsed.applicationId,
      invoiceId: parsed.invoiceId,
      external: { externalRef: parsed.externalRef },
      metadata: parsed.metadata || {},
    });
    await postJournalForPayment(payment, paymentJournalCtx(payment, ctx));
    return { ok: true, paymentId: payment._id.toString() };
  }

  // direction === "out" maps to refund
  const refund = await Refund.create({
    tenantId: ctx.tenantId,
    mode: "external",
    amount: parsed.amount,
    currency: parsed.currency,
    refNo: parsed.refNo,
    metadata: parsed.metadata || {},
  });
  return { ok: true, refundId: refund._id.toString() };
}

async function sumRefundedForPayment(tenantId, paymentId) {
  const agg = await Refund.aggregate([
    { $match: { tenantId, paymentId } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return agg[0]?.total ?? 0;
}

async function loadRefundPayment(parsed, ctx) {
  if (parsed.mode === "stripe") {
    const pi =
      parsed.paymentIntentId != null &&
      String(parsed.paymentIntentId).trim() !== ""
        ? String(parsed.paymentIntentId).trim()
        : null;
    if (pi) {
      return Payment.findOne({
        tenantId: ctx.tenantId,
        "stripe.paymentIntentId": pi,
      }).lean();
    }
    if (parsed.paymentId) {
      return Payment.findOne({
        _id: parsed.paymentId,
        tenantId: ctx.tenantId,
      }).lean();
    }
    return null;
  }
  if (parsed.paymentId) {
    return Payment.findOne({
      _id: parsed.paymentId,
      tenantId: ctx.tenantId,
    }).lean();
  }
  return Payment.findOne({
    tenantId: ctx.tenantId,
    "stripe.paymentIntentId": parsed.paymentIntentId,
  }).lean();
}

function assertPaymentAllowsRefund(payment) {
  if (!["succeeded", "partially_refunded"].includes(payment.status)) {
    throw AppError.badRequest("Payment status does not allow refund", {
      status: payment.status,
    });
  }
}

async function applyRefundGlAndUpdateDoc(refundDoc, payment, ctx) {
  const logger = (await import("../config/logger.js")).default;
  const docNo = `RFD-${refundDoc._id}`;
  try {
    const journal = await postJournalForRefund(refundDoc, payment, ctx);
    if (journal?.docNo) {
      await Refund.updateOne(
        { _id: refundDoc._id },
        { $set: { glDocNo: journal.docNo, glStatus: "posted" } },
      );
      return { glPosted: true, glDocNo: journal.docNo };
    }
    await Refund.updateOne(
      { _id: refundDoc._id },
      { $set: { glStatus: "gl_failed" } },
    );
    return { glPosted: false, glDocNo: null };
  } catch (err) {
    logger.error(
      { err, docNo, refundId: String(refundDoc._id) },
      "postJournalForRefund failed",
    );
    await Refund.updateOne(
      { _id: refundDoc._id },
      { $set: { glStatus: "gl_failed" } },
    ).catch(() => {});
    return { glPosted: false, glDocNo: null };
  }
}

function refundDocumentDate(parsed) {
  if (parsed.refundDate != null && String(parsed.refundDate).trim() !== "") {
    return new Date(parsed.refundDate);
  }
  return new Date();
}

function paymentLikeForRefund(parsed, payment) {
  if (payment) return payment;
  const meta =
    parsed.metadata && Object.keys(parsed.metadata).length
      ? new Map(Object.entries(parsed.metadata))
      : new Map();
  if (parsed.memberId && !meta.has("memberId"))
    meta.set("memberId", parsed.memberId);
  if (parsed.applicationId && !meta.has("applicationId"))
    meta.set("applicationId", parsed.applicationId);
  return {
    mode: "external",
    memberId: parsed.memberId ?? null,
    applicationId: parsed.applicationId ?? null,
    metadata: meta,
  };
}

export async function createRefund(input, ctx) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  const parsed = zCreateRefund.parse(input);
  const stripe = getStripe();

  const isStandaloneExternal =
    parsed.mode === "external" &&
    !parsed.paymentId &&
    !(
      parsed.paymentIntentId != null &&
      String(parsed.paymentIntentId).trim() !== ""
    );

  const payment = isStandaloneExternal
    ? null
    : await loadRefundPayment(parsed, ctx);
  if (!isStandaloneExternal && !payment) {
    throw AppError.badRequest("Payment not found for refund");
  }
  if (payment) {
    if (parsed.mode === "stripe" && payment.mode !== "stripe") {
      throw AppError.badRequest(
        "Stripe refund requires a Stripe payment record",
      );
    }
    if (parsed.mode === "external" && payment.mode !== "external") {
      throw AppError.badRequest(
        "External refund requires an external payment record",
      );
    }
    assertPaymentAllowsRefund(payment);
  }

  const refundAmount =
    payment && parsed.amount == null ? payment.amount : parsed.amount;
  ensureIntegerCents(refundAmount);

  let linkedPaymentRemainingCents;
  if (payment) {
    const alreadyRefunded = await sumRefundedForPayment(
      ctx.tenantId,
      payment._id,
    );
    linkedPaymentRemainingCents = payment.amount - alreadyRefunded;
    if (refundAmount > linkedPaymentRemainingCents) {
      const remainingRefundableAmount = centsToEuros(
        linkedPaymentRemainingCents,
      );
      throw AppError.badRequest(
        `Refund exceeds remaining refundable amount on payment. Maximum refundable amount is ${remainingRefundableAmount} EUR.`,
        {
          refundCents: refundAmount,
          remainingRefundableCents: linkedPaymentRemainingCents,
          remainingRefundableAmount,
        },
      );
    }
  }

  const refundBusinessDate = refundDocumentDate(parsed);
  const journalYear = refundBusinessDate.getFullYear();
  const paymentLike = paymentLikeForRefund(parsed, payment);
  await assertRefundWithinCredit(refundAmount, paymentLike, journalYear, {
    linkedPaymentRemainingCents,
    tenantId: ctx.tenantId,
  });

  const meta =
    parsed.metadata && Object.keys(parsed.metadata).length
      ? new Map(Object.entries(parsed.metadata))
      : undefined;

  if (parsed.mode === "stripe") {
    const piFromRequest =
      parsed.paymentIntentId != null &&
      String(parsed.paymentIntentId).trim() !== ""
        ? String(parsed.paymentIntentId).trim()
        : null;

    let stripeRefundId = null;
    let stripeChargeId = parsed.chargeId ?? undefined;
    const paymentIntentForRecord =
      piFromRequest ?? payment.stripe?.paymentIntentId ?? undefined;

    if (piFromRequest) {
      const refund = await stripe.refunds.create(
        {
          charge: parsed.chargeId,
          payment_intent: piFromRequest,
          amount: refundAmount,
          metadata: parsed.metadata || {},
        },
        { idempotencyKey: ctx.idempotencyKey || undefined },
      );
      stripeRefundId = refund.id;
      stripeChargeId = refund.charge || stripeChargeId;
    }

    const refundDoc = await Refund.create({
      tenantId: ctx.tenantId,
      paymentId: payment._id,
      mode: "stripe",
      ...(parsed.memberId && { memberId: parsed.memberId }),
      ...(parsed.applicationId && { applicationId: parsed.applicationId }),
      amount: refundAmount,
      currency: payment.currency,
      refundDate: refundBusinessDate,
      refNo: parsed.refNo,
      stripe: {
        ...(stripeRefundId && { refundId: stripeRefundId }),
        ...(stripeChargeId && { chargeId: stripeChargeId }),
        ...(paymentIntentForRecord && {
          paymentIntentId: paymentIntentForRecord,
        }),
      },
      memo: parsed.memo,
      ...(parsed.payoutMethod ? { payoutMethod: parsed.payoutMethod } : {}),
      ...(meta && { metadata: meta }),
    });

    const newStatus =
      refundAmount < payment.amount ? "partially_refunded" : "refunded";
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: newStatus,
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );

    const { glPosted, glDocNo } = await applyRefundGlAndUpdateDoc(
      refundDoc,
      payment,
      ctx,
    );

    return {
      ...(stripeRefundId != null && { refundId: stripeRefundId }),
      refundDocId: refundDoc._id.toString(),
      status: "ok",
      glPosted,
      glDocNo,
      ...(piFromRequest == null && { stripeApiSkipped: true }),
    };
  }

  const refundDoc = await Refund.create({
    tenantId: ctx.tenantId,
    ...(payment && { paymentId: payment._id }),
    ...(parsed.memberId && { memberId: parsed.memberId }),
    ...(parsed.applicationId && { applicationId: parsed.applicationId }),
    mode: "external",
    amount: refundAmount,
    currency: payment?.currency ?? parsed.currency ?? "eur",
    refundDate: refundBusinessDate,
    refNo: parsed.refNo,
    memo: parsed.memo,
    payoutMethod: parsed.payoutMethod ?? "bank_transfer",
    ...(meta && { metadata: meta }),
  });

  if (payment) {
    const newStatus =
      refundAmount < payment.amount ? "partially_refunded" : "refunded";
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: newStatus,
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      },
    );
  }

  const { glPosted, glDocNo } = await applyRefundGlAndUpdateDoc(
    refundDoc,
    paymentLike,
    ctx,
  );

  return {
    ok: true,
    refundDocId: refundDoc._id.toString(),
    glPosted,
    glDocNo,
    ...(isStandaloneExternal && { standaloneExternal: true }),
  };
}

/**
 * CoA for the credit leg of a refund (where payout is recognized).
 * - Stripe API refund (no payoutMethod on doc): 1220.
 * - GL-only stripe refund: payoutMethod bank_transfer 1200, cheque 1210, credit_card 1220.
 * - External: same payoutMethod map; default bank_transfer.
 */
export function clearingAccountCodeForRefund(refundDoc, payment) {
  const refundMode =
    refundDoc?.mode ?? (payment?.mode === "stripe" ? "stripe" : "external");

  if (refundMode === "stripe") {
    const pm = refundDoc?.payoutMethod;
    if (pm === "bank_transfer") return "1200";
    if (pm === "cheque") return "1210";
    if (pm === "credit_card") return "1220";
    return "1220";
  }

  const pm = refundDoc?.payoutMethod ?? "bank_transfer";
  if (pm === "cheque") return "1210";
  if (pm === "credit_card") return "1220";
  return "1200";
}

/**
 * GL refund: DR member buckets (mirror receipt), CR clearing.
 * Idempotent docNo RFD-{refundId}; postBalancedJournal also dedupes by docNo.
 */
export async function postJournalForRefund(refundDoc, payment, ctx) {
  const { postBalancedJournal } =
    await import("../controllers/journal.controller.js");
  const { buildMemberRefundDebitEntries } = await import(
    "../helpers/paymentReceiptAllocation.js"
  );
  const logger = (await import("../config/logger.js")).default;
  const GLTransaction = (await import("../models/glTransaction.model.js"))
    .default;

  // The refund row is tenant-owned; a caller tenant that disagrees is refused.
  const tenantId = requireTenantId(refundDoc?.tenantId || ctx?.tenantId);
  if (ctx?.tenantId && String(ctx.tenantId) !== tenantId) {
    throw AppError.notFound("Refund not found");
  }
  const amount = refundDoc.amount;
  const clearingCode = clearingAccountCodeForRefund(refundDoc, payment);

  let metadataObj = {};
  if (payment?.metadata) {
    if (payment.metadata instanceof Map) {
      metadataObj = Object.fromEntries(payment.metadata);
    } else if (typeof payment.metadata === "object") {
      metadataObj = payment.metadata;
    }
  }

  let memberId =
    refundDoc.memberId ||
    payment?.memberId ||
    metadataObj.memberId ||
    metadataObj.member_id ||
    null;
  const applicationId =
    refundDoc.applicationId ||
    payment?.applicationId ||
    metadataObj.applicationId ||
    metadataObj.application_id ||
    null;

  if (!memberId && applicationId) {
    memberId = await getClaimRecipientMemberIdForApplication(applicationId, tenantId);
  }

  if (!memberId && !applicationId) {
    logger.warn(
      {
        refundId: refundDoc._id,
        paymentId: payment?._id,
      },
      "Skipping refund journal — memberId or applicationId required",
    );
    return null;
  }

  const journalDate = refundDoc.refundDate
    ? new Date(refundDoc.refundDate)
    : new Date();

  /** @type {object[]} */
  let debitLines;
  if (memberId) {
    debitLines = await buildMemberRefundDebitEntries(
      memberId,
      amount,
      journalDate,
      { tenantId },
    );
  } else {
    debitLines = [
      {
        accountCode: "2020",
        dc: "D",
        amount,
        periodBucket: "current",
        applicationId,
      },
    ];
  }

  if (!debitLines.length) {
    logger.warn(
      { refundId: refundDoc._id, memberId, applicationId, amount },
      "postJournalForRefund: no debit lines built",
    );
    return null;
  }

  const lines = [...debitLines, { accountCode: clearingCode, dc: "C", amount }];

  const docNo = `RFD-${refundDoc._id}`;
  const existing = await GLTransaction.findOne({ tenantId, docNo }).lean();
  if (existing) return existing;
  const refNoStr =
    refundDoc.refNo != null ? String(refundDoc.refNo).trim() : "";
  const memoStr = refundDoc.memo != null ? String(refundDoc.memo).trim() : "";
  const reference = refNoStr || undefined;
  const memo =
    memoStr !== ""
      ? memoStr
      : memberId
        ? `Refund (member ${memberId})`
        : applicationId
          ? `Refund (app ${applicationId})`
          : "Refund";

  return postBalancedJournal({
    date: journalDate,
    userId: ctx?.userId,
    tenantId,
    docType: "Refund",
    docNo,
    reference,
    memo,
    lines,
    operation: "refund_posted",
  });
}

// The payment row's own tenant is authoritative for its ledger postings; a caller/webhook
// context naming a different tenant is refused rather than overriding it.
function paymentJournalCtx(payment, ctx = {}) {
  const tenantId = requireTenantId(payment?.tenantId || ctx?.tenantId);
  if (ctx?.tenantId && String(ctx.tenantId) !== tenantId) {
    throw AppError.notFound("Payment not found");
  }
  return {
    ...ctx,
    tenantId,
  };
}

export async function postJournalForPayment(payment, ctx) {
  const journalCtx = paymentJournalCtx(payment, ctx);

  // Events/courses payments post to a segregated set of CoA codes via a
  // separate function (see eventRegistration.approval.listener.js) rather
  // than sharing this function's membership-specific 1400/2020 logic below.
  if (payment.ledgerDomain === "events") {
    const { postJournalForEventPayment } = await import(
      "../handlers/eventRegistration.approval.listener.js"
    );
    return postJournalForEventPayment(payment, journalCtx);
  }

  // Import required modules
  const { postBalancedJournal } =
    await import("../controllers/journal.controller.js");
  const { stripeFeeBreakdown } = await import("../helpers/fees.js");
  const logger = (await import("../config/logger.js")).default;

  // Amount is already in cents (minor units) - use directly
  // No conversion needed - all money is stored as integer cents
  const amount = payment.amount; // Integer in cents

  logger.info(
    {
      paymentId: payment._id,
      amount,
      amountInEuros: (amount / 100).toFixed(2), // For logging clarity
      mode: payment.mode,
      memberId: payment.memberId,
      applicationId: payment.applicationId,
    },
    "postJournalForPayment called",
  );

  // Determine clearing code based on payment method
  // 1220 = Card Gateway Clearing (for Stripe/card payments)
  // 1210 = Undeposited Cheques
  // 1230 = Salary Deduction Clearing
  // 1240 = Standing Order Clearing
  // 1250 = Direct Debit Clearing
  const clearingCode = payment.mode === "stripe" ? "1220" : "1210";

  // Extract memberId and applicationId from payment document or metadata
  // Handle metadata as Map (MongoDB) or plain object
  let metadataObj = {};
  if (payment.metadata) {
    if (payment.metadata instanceof Map) {
      metadataObj = Object.fromEntries(payment.metadata);
    } else if (typeof payment.metadata === "object") {
      metadataObj = payment.metadata;
    }
  }

  // Get memberId/applicationId from document first, then fallback to metadata
  // IMPORTANT: Do NOT use userId as memberId - userId is just a user identifier, not a member identifier
  // For application payments, applicationId should be used, not memberId
  const memberId =
    payment.memberId || metadataObj.memberId || metadataObj.member_id || null;
  const applicationId =
    payment.applicationId ||
    metadataObj.applicationId ||
    metadataObj.application_id ||
    null;

  if (!memberId && !applicationId) {
    // Log warning but don't throw - payment is recorded, journal entry can be created manually
    const logger = (await import("../config/logger.js")).default;
    logger.warn(
      {
        paymentId: payment._id,
        memberId: payment.memberId,
        applicationId: payment.applicationId,
        metadata: metadataObj,
      },
      "Skipping journal entry - memberId or applicationId required",
    );
    return null;
  }

  const date = new Date().toISOString().split("T")[0];
  const docNo = `RCP-${payment._id}`;

  const { buildMemberReceiptCreditEntries } = await import(
    "../helpers/paymentReceiptAllocation.js"
  );

  /** @type {object[]} */
  let creditEntries;
  if (applicationId) {
    creditEntries = [
      {
        accountCode: "2020",
        dc: "C",
        amount,
        periodBucket: "current",
        applicationId,
      },
    ];
  } else if (memberId) {
    creditEntries = await buildMemberReceiptCreditEntries(
      memberId,
      amount,
      date,
      { tenantId: journalCtx.tenantId },
    );
  } else {
    creditEntries = [];
  }

  if (!creditEntries.length) {
    logger.warn(
      { paymentId: payment._id, memberId, applicationId },
      "postJournalForPayment: no credit lines built",
    );
    return null;
  }

  const lines = [
    { accountCode: clearingCode, dc: "D", amount },
    ...creditEntries,
  ];

  // Add Stripe fee entries if payment is via Stripe
  let settlement = null;
  if (payment.mode === "stripe") {
    const { feeNoVat } = stripeFeeBreakdown(amount);
    lines.push({ accountCode: "5100", dc: "D", amount: feeNoVat }); // Payment processing fees
    lines.push({ accountCode: clearingCode, dc: "C", amount: feeNoVat }); // Credit clearing for fees
    // Set settlement info for Stripe payments
    settlement = {
      provider: "Stripe",
      status: "PENDING",
    };
  }

  // Create receipt memo - prioritize applicationId if present, otherwise use memberId
  const memo = applicationId
    ? `Receipt (app ${applicationId})`
    : memberId
      ? `Receipt (member ${memberId})`
      : "Receipt";

  // Create journal entry using the exported function
  // Note: postBalancedJournal needs to be exported from journal.controller.js
  const journal = await postBalancedJournal({
    date,
    userId: journalCtx?.userId,
    tenantId: journalCtx?.tenantId,
    profileId: payment?.profileId || undefined,
    docType: "Receipt",
    docNo,
    memo,
    lines,
    settlement,
    operation: "online_payment_receipt",
    paymentMethod: "online_payment",
  });

  return journal;
}

/**
 * @param {Object} ctx - { tenantId }
 * @param {Object} options - from zListRefundsQuery
 */
export async function listRefunds(ctx, options) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  const { limit, skip, memberId, mode, from, to } = options;
  const query = { tenantId: ctx.tenantId };
  if (mode) query.mode = mode;
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) query.createdAt.$lte = new Date(to);
  }
  if (memberId) {
    const pids = await Payment.find({
      tenantId: ctx.tenantId,
      memberId,
    }).distinct("_id");
    query.$or = [
      { memberId },
      ...(pids.length ? [{ paymentId: { $in: pids } }] : []),
    ];
  }
  const [items, total] = await Promise.all([
    Refund.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "paymentId",
        select:
          "memberId applicationId invoiceId amount currency mode status purpose createdAt",
      })
      .lean(),
    Refund.countDocuments(query),
  ]);
  return { items, total, limit, skip };
}

/**
 * List payments by member IDs (for gateway aggregation / subscription service).
 * @param {Object} ctx - { tenantId }
 * @param {string[]} memberIds - membership numbers
 * @param {Object} options - { status?, purpose? }
 * @returns {Promise<Object[]>} payments (lean)
 */
export async function listByMemberIds(memberIds, ctx, options = {}) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  if (!memberIds || memberIds.length === 0) return [];
  const query = {
    tenantId: ctx.tenantId,
    memberId: { $in: memberIds },
  };
  if (options.status) query.status = options.status;
  if (options.purpose) query.purpose = options.purpose;
  const payments = await Payment.find(query).sort({ createdAt: -1 }).lean();
  return payments;
}

export async function associateMemberLinks(input, ctx) {
  requireTenantId(ctx); // fail closed: trusted tenant (req.ctx) required, never a global query
  const {
    memberId,
    applicationId,
    paymentIds = [],
    refundIds = [],
    includePayments = true,
    includeRefunds = true,
    onlyIfMissingMemberId = true,
  } = input;

  const tenantId = ctx.tenantId;
  const paymentIdSet = new Set(paymentIds.map((id) => String(id)));

  // Add payment ids discovered from applicationId.
  if (applicationId) {
    const appPaymentIds = await Payment.find({ tenantId, applicationId })
      .select("_id")
      .lean();
    for (const p of appPaymentIds) paymentIdSet.add(String(p._id));
  }

  // Add payment ids discovered from explicit refundIds.
  if (refundIds.length) {
    const linkedRefunds = await Refund.find({
      tenantId,
      _id: { $in: refundIds },
      paymentId: { $exists: true, $ne: null },
    })
      .select("paymentId")
      .lean();
    for (const r of linkedRefunds) paymentIdSet.add(String(r.paymentId));
  }

  const targetPaymentIds = [...paymentIdSet];

  let paymentsMatched = 0;
  let paymentsUpdated = 0;
  let refundsMatched = 0;
  let refundsUpdated = 0;

  if (includePayments && targetPaymentIds.length) {
    if (applicationId) {
      await Payment.updateMany(
        {
          tenantId,
          _id: { $in: targetPaymentIds },
          $or: [
            { applicationId: { $exists: false } },
            { applicationId: null },
            { applicationId: "" },
          ],
        },
        { $set: { applicationId } }
      );
    }
    const paymentFilter = { tenantId, _id: { $in: targetPaymentIds } };
    if (onlyIfMissingMemberId) {
      paymentFilter.$or = [
        { memberId: { $exists: false } },
        { memberId: null },
        { memberId: "" },
      ];
    }
    const result = await Payment.updateMany(paymentFilter, { $set: { memberId } });
    paymentsMatched = result.matchedCount || 0;
    paymentsUpdated = result.modifiedCount || 0;
  }

  if (includeRefunds) {
    const refundOr = [];
    if (applicationId) refundOr.push({ applicationId });
    if (refundIds.length) refundOr.push({ _id: { $in: refundIds } });
    if (targetPaymentIds.length) refundOr.push({ paymentId: { $in: targetPaymentIds } });

    if (refundOr.length) {
      if (applicationId) {
        await Refund.updateMany(
          {
            tenantId,
            $or: refundOr,
            $and: [
              {
                $or: [
                  { applicationId: { $exists: false } },
                  { applicationId: null },
                  { applicationId: "" },
                ],
              },
            ],
          },
          { $set: { applicationId } }
        );
      }
      const refundFilter = { tenantId, $or: refundOr };
      if (onlyIfMissingMemberId) {
        refundFilter.$and = [
          {
            $or: [
              { memberId: { $exists: false } },
              { memberId: null },
              { memberId: "" },
            ],
          },
        ];
      }
      const result = await Refund.updateMany(refundFilter, { $set: { memberId } });
      refundsMatched = result.matchedCount || 0;
      refundsUpdated = result.modifiedCount || 0;
    }
  }

  return {
    ok: true,
    selectors: {
      applicationId: applicationId || null,
      paymentIds: paymentIds.length,
      refundIds: refundIds.length,
    },
    includePayments,
    includeRefunds,
    onlyIfMissingMemberId,
    memberId,
    payments: {
      targetedBySelectors: targetPaymentIds.length,
      matched: paymentsMatched,
      updated: paymentsUpdated,
    },
    refunds: {
      matched: refundsMatched,
      updated: refundsUpdated,
    },
    glTransactions: {
      updated: 0,
      note: "No GL transactions mutated; ledger remains immutable for audit safety",
    },
  };
}

export default {
  createIntent,
  findByStripePaymentIntent,
  reconcileStripeEvent,
  reconcilePaymentFromStripe,
  recordExternal,
  createRefund,
  postJournalForPayment,
  postJournalForRefund,
  clearingAccountCodeForRefund,
  listRefunds,
  listByMemberIds,
  associateMemberLinks,
};
