// Deferred application payment links (docs/design/IMPLEMENTATION_PLAN.md s.3, s.5.2).
//
// A link is a Stripe Checkout Session (manual capture, <= 24 h). It converges on the existing
// Payment/PaymentIntent lifecycle: the Payment created for the session gets its PaymentIntent
// from checkout.session.completed, reaches requires_capture, and CRM approval captures it with
// the existing POST /intents/:paymentIntentId/capture. Nothing here captures money.
//
// Every step of handlePaymentLinkRequested is idempotent (unique (tenant, application,
// linkVersion), Payment idempotencyKey, Stripe idempotency key), so a redelivered or
// half-processed request resumes instead of creating a second session or payment.
import PaymentLink from "../models/paymentLink.model.js";
import Payment from "../models/payment.model.js";
import { getStripe } from "../lib/stripe.js";
import logger from "../config/logger.js";
import { enqueueOutboxEvent, republishOutboxEvent } from "./outbox.service.js";
import { computeApplicationAmount, PriceError } from "./applicationPrice.service.js";
import { requireEnvelopeTenant } from "../helpers/eventTenant.js";
import { registerWebhookHooks } from "./webhookHooks.js";
import { enqueueLinkPaymentStatus } from "./payments.service.js";

export const AUTHORISED_STATUSES = ["requires_capture", "succeeded", "partially_refunded", "refunded"];
// Stripe allows expires_at up to 24 h after creation; keep a margin for clock skew.
const LINK_TTL_SECONDS = 24 * 3600 - 5 * 60;

let stripeOverride = null;
let pricingDeps = {};
/** Test seams. */
export function setPaymentLinkStripe(client) {
  stripeOverride = client;
}
export function setPaymentLinkPricingDeps(deps) {
  pricingDeps = deps || {};
}
const stripe = () => stripeOverride || getStripe();

const linkKey = (tenantId, applicationId, linkVersion) => `link:${tenantId}:${applicationId}:v${linkVersion}`;

function issuedData(link) {
  return {
    applicationId: link.applicationId,
    linkVersion: link.linkVersion,
    paymentLinkId: String(link._id),
    paymentId: link.paymentId ? String(link.paymentId) : null,
    checkoutSessionId: link.checkoutSessionId,
    checkoutUrl: link.checkoutUrl,
    expiresAt: link.expiresAt,
    amount: link.amount,
    currency: link.currency,
    paymentOption: link.paymentOption,
    pricingBasis: link.pricingBasis,
  };
}

async function publishIssued(link) {
  const eventKey = `${linkKey(link.tenantId, link.applicationId, link.linkVersion)}:issued`;
  const { created } = await enqueueOutboxEvent({
    eventKey,
    tenantId: link.tenantId,
    routingKey: "payments.payment-link.issued.v1",
    data: issuedData(link),
  });
  if (!created) await republishOutboxEvent(eventKey);
}

async function publishFailed({ tenantId, applicationId, linkVersion, reason, retryable = false }) {
  const eventKey = `${linkKey(tenantId, applicationId, linkVersion)}:failed`;
  const { created } = await enqueueOutboxEvent({
    eventKey,
    tenantId,
    routingKey: "payments.payment-link.failed.v1",
    data: { applicationId, linkVersion, reason, retryable },
  });
  if (!created) await republishOutboxEvent(eventKey);
}

async function failLink(ids, reason, extra = {}) {
  const { tenantId, applicationId, linkVersion } = ids;
  await PaymentLink.updateOne(
    { tenantId, applicationId, linkVersion, status: { $in: ["PENDING"] } },
    { $set: { status: "FAILED", failureReason: reason } },
  );
  await PaymentLink.updateOne(
    { tenantId, applicationId, linkVersion },
    {
      $setOnInsert: {
        tenantId,
        applicationId,
        linkVersion,
        status: "FAILED",
        failureReason: reason,
        action: extra.action || "ISSUE",
        requestedBy: extra.requestedBy,
      },
    },
    { upsert: true },
  );
  await publishFailed({ tenantId, applicationId, linkVersion, reason });
  logger.info({ tenantId, applicationId, linkVersion, reason }, "Payment link request failed");
  return { ok: true, failed: reason };
}

async function republishOutcome(link) {
  if (link.status === "FAILED") {
    await publishFailed({
      tenantId: link.tenantId,
      applicationId: link.applicationId,
      linkVersion: link.linkVersion,
      reason: link.failureReason || "UNKNOWN",
    });
  } else {
    await publishIssued(link);
  }
  return { ok: true, redelivery: true, status: link.status };
}

/**
 * Base for the Checkout success/cancel URLs: PAYMENT_LINK_RETURN_BASE_URL, required - there is no
 * fallback. Must be an absolute https URL (http only for localhost), without credentials, query
 * or fragment, and not a placeholder host. Trailing slashes are dropped so the URLs (part of the
 * Stripe idempotent request parameters) are stable.
 * @returns {{ ok: true, base: string } | { ok: false, reason: "missing"|"invalid"|"insecure"|"placeholder" }}
 */
export function paymentLinkReturnBase(raw = process.env.PAYMENT_LINK_RETURN_BASE_URL) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, reason: "missing" };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { ok: false, reason: "insecure" };
  if (url.username || url.password || url.search || url.hash) return { ok: false, reason: "invalid" };
  if (/(^|\.)example\.(com|org|net)$/i.test(url.hostname)) return { ok: false, reason: "placeholder" };
  return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/**
 * Expire every ISSUED link older than linkVersion. Returns {completed: true} if one of them
 * was already paid (its session completed), in which case no new link may be issued.
 */
async function retireIssuedLinks(tenantId, applicationId, linkVersion) {
  const older = await PaymentLink.find({ tenantId, applicationId, status: "ISSUED", linkVersion: { $lt: linkVersion } }).lean();
  for (const old of older) {
    if (old.checkoutSessionId) {
      try {
        await stripe().checkout.sessions.expire(old.checkoutSessionId);
      } catch (err) {
        const session = await stripe().checkout.sessions.retrieve(old.checkoutSessionId);
        if (session.status === "complete") return { completed: true, linkId: old._id };
        if (session.status !== "expired") throw err; // transient: retry the whole request
      }
    }
    await PaymentLink.updateOne(
      { _id: old._id, status: "ISSUED" },
      { $set: { status: "REPLACED", replacedAt: new Date() } },
    );
    if (old.paymentId) {
      await Payment.updateOne(
        { _id: old.paymentId, tenantId, "stripe.paymentIntentId": { $in: [null] }, status: { $in: ["created", "requires_action"] } },
        {
          $set: {
            status: "canceled",
            isActiveAttempt: false,
            supersededAt: new Date(),
            supersededReason: "payment_link_replaced",
            "stripe.cancellationReason": "payment_link_replaced",
          },
        },
      );
    }
  }
  return { completed: false };
}

async function ensureLinkPayment(link) {
  const idempotencyKey = linkKey(link.tenantId, link.applicationId, link.linkVersion);
  const existing = await Payment.findOne({ tenantId: link.tenantId, idempotencyKey }).lean();
  if (existing) return existing;
  const last = await Payment.findOne({ tenantId: link.tenantId, applicationId: link.applicationId })
    .sort({ attemptNumber: -1 })
    .select({ attemptNumber: 1 })
    .lean();
  try {
    const doc = await Payment.create({
      tenantId: link.tenantId,
      purpose: "applicationFee",
      ledgerDomain: "membership",
      amount: link.amount,
      currency: link.currency,
      status: "created",
      applicationId: link.applicationId,
      idempotencyKey,
      attemptNumber: (last?.attemptNumber || 0) + 1,
      isActiveAttempt: true,
      source: "payment-link",
      mode: "stripe",
      paymentLinkId: link._id,
      linkVersion: link.linkVersion,
      metadata: {
        applicationId: link.applicationId,
        paymentLinkId: String(link._id),
        linkVersion: String(link.linkVersion),
      },
      audit: { createdBy: link.requestedBy?.userId || "system" },
    });
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      return Payment.findOne({ tenantId: link.tenantId, idempotencyKey }).lean();
    }
    throw err;
  }
}

/** Session expiry for a new PENDING link, whole seconds (Stripe takes a Unix timestamp). */
function plannedCheckoutExpiry() {
  return new Date((Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS) * 1000);
}

/**
 * The expires_at sent to Stripe, frozen on the PENDING link. Stripe rejects a reused
 * idempotency key whose parameters differ, so a resumed request must send exactly the
 * parameters of the first attempt; a fresh Date.now() would turn every resume into an
 * idempotency_error -> STRIPE_ERROR while the first session is still open.
 */
async function frozenCheckoutExpiry(link) {
  if (link.checkoutExpiresAt) return Math.floor(new Date(link.checkoutExpiresAt).getTime() / 1000);
  // A PENDING row written before this field existed: freeze it once (first writer wins).
  await PaymentLink.updateOne(
    { _id: link._id, checkoutExpiresAt: { $exists: false } },
    { $set: { checkoutExpiresAt: plannedCheckoutExpiry() } },
  );
  const fresh = await PaymentLink.findById(link._id).select({ checkoutExpiresAt: 1 }).lean();
  return Math.floor(new Date(fresh.checkoutExpiresAt).getTime() / 1000);
}

function isRetryableStripeError(err) {
  return (
    ["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"].includes(err?.type) ||
    (err?.statusCode && err.statusCode >= 500)
  );
}

/**
 * Consumer for applications.payment-link.requested.v1 (profile -> account).
 * Throws only on transient failures (consumer retry -> DLQ); business outcomes are published.
 */
export async function handlePaymentLinkRequested(payload) {
  const eventType = "applications.payment-link.requested.v1";
  const tenant = requireEnvelopeTenant(payload);
  if (!tenant.ok) {
    logger.warn({ eventType, eventId: payload?.eventId, reason: tenant.reason }, "Payment link request without a trusted envelope tenant - ignored");
    return { ok: false, ignored: "tenant", reason: tenant.reason };
  }
  const { tenantId } = tenant;
  const d = payload?.data || {};
  const applicationId = String(d.applicationId || "").trim();
  const linkVersion = Number(d.linkVersion);
  const action = d.action;
  if (!applicationId || !Number.isInteger(linkVersion) || linkVersion < 1 || !["ISSUE", "REPLACE"].includes(action)) {
    logger.warn({ eventId: payload?.eventId }, "Invalid payment link request - ignored");
    return { ok: false, ignored: "invalid" };
  }
  const ids = { tenantId, applicationId, linkVersion };
  const requestedBy = {
    userId: d.requestedBy?.userId ? String(d.requestedBy.userId) : null,
    userType: d.requestedBy?.userType || null,
    channel: d.requestedBy?.channel || null,
  };

  // 1. Redelivery of a version already decided: re-publish its outcome.
  let link = await PaymentLink.findOne(ids).lean();
  if (link && link.status !== "PENDING") return republishOutcome(link);

  // A newer version exists: this request is stale.
  if (await PaymentLink.exists({ tenantId, applicationId, linkVersion: { $gt: linkVersion } })) {
    return { ok: true, ignored: "superseded" };
  }

  // Return URLs: configuration is checked before any Payment record or Stripe call.
  const returnBase = paymentLinkReturnBase();
  if (!returnBase.ok) {
    logger.error({ ...ids, reason: returnBase.reason }, "PAYMENT_LINK_RETURN_BASE_URL missing or invalid - no Checkout Session created");
    return failLink(ids, "PAYMENT_LINK_CONFIG_INVALID", { action, requestedBy });
  }

  // 2. One authorised/captured payment per application.
  if (await Payment.exists({ tenantId, applicationId, status: { $in: AUTHORISED_STATUSES } })) {
    return failLink(ids, "ALREADY_AUTHORISED", { action, requestedBy });
  }

  // Price (server side only) - frozen on the PENDING row so a resumed request keeps it.
  if (!link) {
    let price;
    try {
      price = await computeApplicationAmount(
        {
          tenantId,
          applicationId,
          membershipCategory: d.pricing?.membershipCategory,
          paymentType: d.pricing?.paymentType,
        },
        pricingDeps,
      );
    } catch (err) {
      if (err instanceof PriceError) return failLink(ids, err.reason, { action, requestedBy });
      throw err;
    }
    try {
      link = (
        await PaymentLink.create({
          ...ids,
          status: "PENDING",
          action,
          paymentOption: price.paymentOption,
          amount: price.amount,
          currency: price.currency,
          pricingBasis: price.pricingBasis,
          requestedBy,
          requestEventKey: d.eventKey || null,
          checkoutExpiresAt: plannedCheckoutExpiry(),
        })
      ).toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      link = await PaymentLink.findOne(ids).lean();
      if (link.status !== "PENDING") return republishOutcome(link);
    }
  }

  // 3. Replace earlier ISSUED links.
  const retired = await retireIssuedLinks(tenantId, applicationId, linkVersion);
  if (retired.completed) return failLink(ids, "ALREADY_AUTHORISED", { action, requestedBy });

  // 4. Payment record (the ordinary Payment the PaymentIntent will attach to), then session.
  const payment = await ensureLinkPayment(link);
  const expiresAtSeconds = await frozenCheckoutExpiry(link);
  const metadata = {
    tenantId,
    applicationId,
    paymentId: String(payment._id),
    paymentLinkId: String(link._id),
    linkVersion: String(linkVersion),
    purpose: "applicationFee",
    source: "payment-link",
  };
  const base = returnBase.base;
  let session;
  try {
    session = await stripe().checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        currency: link.currency,
        line_items: [
          {
            price_data: {
              currency: link.currency,
              product_data: {
                name: link.paymentOption === "FULL" ? "Membership fee (annual)" : "Membership fee (three months)",
              },
              unit_amount: link.amount,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: { capture_method: "manual", metadata },
        metadata,
        client_reference_id: applicationId,
        expires_at: expiresAtSeconds,
        success_url: `${base}/payments/success`,
        cancel_url: `${base}/payments/cancel`,
      },
      { idempotencyKey: linkKey(tenantId, applicationId, linkVersion) },
    );
  } catch (err) {
    if (isRetryableStripeError(err)) throw err;
    logger.error({ ...ids, stripeErrorType: err?.type, stripeErrorCode: err?.code }, "Checkout session creation failed");
    await Payment.updateOne(
      { _id: payment._id, status: "created" },
      { $set: { status: "canceled", isActiveAttempt: false, "stripe.cancellationReason": "checkout_session_failed" } },
    );
    return failLink(ids, "STRIPE_ERROR", { action, requestedBy });
  }

  await Payment.updateOne(
    { _id: payment._id, tenantId },
    {
      $set: {
        status: "requires_action",
        "stripe.checkoutSessionId": session.id,
        "stripe.checkoutUrl": session.url,
        "stripe.status": "checkout_session_created",
      },
    },
  );
  const issued = await PaymentLink.findOneAndUpdate(
    { _id: link._id, status: "PENDING" },
    {
      $set: {
        status: "ISSUED",
        checkoutSessionId: session.id,
        checkoutUrl: session.url,
        expiresAt: new Date(session.expires_at * 1000),
        paymentId: payment._id,
      },
    },
    { new: true },
  ).lean();
  const finalLink = issued || (await PaymentLink.findOne(ids).lean());
  await publishIssued(finalLink);
  logger.info({ ...ids, paymentLinkId: String(finalLink._id), paymentId: String(payment._id) }, "Payment link issued");
  return { ok: true, issued: true, paymentLinkId: String(finalLink._id), paymentId: String(payment._id) };
}

/** Mark the payment's link COMPLETED once its PaymentIntent is authorised or captured. */
async function markLinkCompleted(payment) {
  if (!payment?.paymentLinkId || !AUTHORISED_STATUSES.includes(payment.status)) return;
  await PaymentLink.updateOne(
    { _id: payment.paymentLinkId, tenantId: payment.tenantId, status: { $in: ["ISSUED", "REPLACED", "EXPIRED"] } },
    { $set: { status: "COMPLETED", completedAt: new Date() } },
  );
}

function keeperOrder(a, b) {
  const rank = (p) => (p.status === "requires_capture" ? 1 : 0); // captured payments always win
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const t = (p) => (p.authorisedAt ? new Date(p.authorisedAt).getTime() : Number.POSITIVE_INFINITY);
  if (t(a) !== t(b)) return t(a) - t(b);
  const c = new Date(a.createdAt) - new Date(b.createdAt);
  if (c) return c;
  return String(a._id).localeCompare(String(b._id));
}

/**
 * One authorised/captured payment per application. When a link payment is involved and two
 * payments are authorised, keep the first (captured > earliest authorised > earliest
 * created) and cancel every other uncaptured PaymentIntent. Never captured, so no refund.
 * Inline-only applications are left exactly as before.
 */
export async function enforceSingleAuthorisation(payment) {
  if (!payment?.applicationId || payment.status !== "requires_capture") return { cancelled: [] };
  await Payment.updateOne(
    { _id: payment._id, authorisedAt: { $exists: false } },
    { $set: { authorisedAt: new Date() } },
  );
  const set = await Payment.find({
    tenantId: payment.tenantId,
    applicationId: payment.applicationId,
    status: { $in: AUTHORISED_STATUSES },
  }).lean();
  if (set.length < 2 || !set.some((p) => p.paymentLinkId)) return { cancelled: [] };
  const [keeper] = [...set].sort(keeperOrder);
  const cancelled = [];
  for (const p of set) {
    if (String(p._id) === String(keeper._id) || p.status !== "requires_capture") continue;
    const piId = p.stripe?.paymentIntentId;
    if (piId) {
      await stripe().paymentIntents.cancel(piId, { cancellation_reason: "duplicate" }, { idempotencyKey: `dup-cancel-${p._id}` });
    }
    const updated = await Payment.findOneAndUpdate(
      { _id: p._id, tenantId: p.tenantId, status: "requires_capture" },
      {
        $set: {
          status: "canceled",
          isActiveAttempt: false,
          supersededAt: new Date(),
          supersededByPaymentId: keeper._id,
          supersededReason: "duplicate_authorisation",
          "stripe.cancellationReason": "duplicate",
        },
        $push: {
          auditHistory: {
            $each: [{ eventId: `dup-cancel-${p._id}`, eventType: "duplicate_authorisation", source: "account-service", status: "canceled", message: `Superseded by payment ${keeper._id}`, receivedAt: new Date() }],
            $slice: -100,
          },
        },
      },
      { new: true },
    ).lean();
    if (updated) {
      cancelled.push(String(p._id));
      logger.warn(
        { applicationId: p.applicationId, cancelledPaymentId: String(p._id), keptPaymentId: String(keeper._id) },
        "Duplicate authorisation resolved: newer uncaptured PaymentIntent cancelled",
      );
      if (updated.paymentLinkId) await enqueueLinkPaymentStatus(updated, { eventKeySuffix: "duplicate" });
    }
  }
  return { cancelled, keptPaymentId: String(keeper._id) };
}

/**
 * A link payment we already closed (replaced/superseded) whose session still completed: the
 * state machine refuses canceled -> requires_capture, so release the hold at Stripe instead of
 * leaving funds held until the 7-day expiry.
 */
async function releaseOrphanAuthorisation(payment, pi) {
  if (!payment.paymentLinkId || payment.status !== "canceled" || pi?.status !== "requires_capture") return;
  await stripe().paymentIntents.cancel(pi.id, { cancellation_reason: "duplicate" }, { idempotencyKey: `orphan-cancel-${payment._id}` });
  logger.warn(
    { applicationId: payment.applicationId, paymentId: String(payment._id) },
    "Authorisation on a closed payment link released (PaymentIntent cancelled)",
  );
}

async function onPaymentProgress(paymentId, tenantId, pi) {
  const fresh = await Payment.findOne({ _id: paymentId, tenantId }).lean();
  if (!fresh) return;
  await releaseOrphanAuthorisation(fresh, pi);
  await markLinkCompleted(fresh);
  await enforceSingleAuthorisation(fresh);
}

export function registerPaymentLinkWebhookHooks() {
  registerWebhookHooks({
    async afterCheckoutCompleted(payment, pi) {
      await onPaymentProgress(payment._id, payment.tenantId, pi);
    },
    async afterIntentReconciled(paymentIntentId) {
      const p = await Payment.findOne({ "stripe.paymentIntentId": paymentIntentId }).select({ _id: 1, tenantId: 1 }).lean();
      if (p) await onPaymentProgress(p._id, p.tenantId);
    },
    async afterCheckoutExpired(payment, session) {
      if (!payment.paymentLinkId) return;
      const expired = await PaymentLink.findOneAndUpdate(
        { _id: payment.paymentLinkId, tenantId: payment.tenantId, status: "ISSUED" },
        { $set: { status: "EXPIRED" } },
        { new: true },
      ).lean();
      if (!expired) return; // replaced/completed links: recorded, not announced
      await enqueueOutboxEvent({
        eventKey: `${linkKey(expired.tenantId, expired.applicationId, expired.linkVersion)}:expired`,
        tenantId: expired.tenantId,
        routingKey: "payments.payment-link.expired.v1",
        data: { applicationId: expired.applicationId, linkVersion: expired.linkVersion, checkoutSessionId: session.id },
      });
    },
  });
}

/** GET /api/internal/payment-links?applicationId= (trusted tenant only). */
export async function listPaymentLinks(tenantId, applicationId) {
  return PaymentLink.find({ tenantId, applicationId })
    .sort({ linkVersion: -1 })
    .select({ __v: 0 })
    .lean();
}
