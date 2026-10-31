// src/controllers/webhook.controller.js
import stripe from "../lib/stripe.js";
import { reconcileStripeEvent } from "../services/payments.service.js";
import {
  handleCheckoutSessionCompleted,
  handleCheckoutSessionExpired,
  handleRefundEvent,
  recordStripeRejection,
  resolveCapturableUntil,
} from "../services/stripeLifecycle.service.js";
import { webhookHooks } from "../services/webhookHooks.js";
import logger from "../config/logger.js";
import bizLogger from "../config/bizLogger.js";

export async function handleStripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];

  // Ensure body is a Buffer (raw body from express.raw())
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body));

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    logger.info({ type: event.type }, "Stripe webhook verified");
  } catch (err) {
    logger.error(
      { err: err.message },
      "Stripe webhook signature verification failed"
    );
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const result = await processStripeEvent(event);
    if (result && result.ok === false && result.rejected) {
      // Permanent: can never apply (unknown object, tenant mismatch). Recorded, then 2xx.
      await recordStripeRejection(event, result.rejected, result);
    }
    return res.json({ received: true });
  } catch (err) {
    if (err?.name === "ZodError") {
      try {
        await recordStripeRejection(event, "invalid_event_shape");
        return res.status(200).json({ received: true, rejected: "invalid_event_shape" });
      } catch {
        return res.status(500).json({ received: false });
      }
    }
    logger.error(
      {
        error: err.message,
        stack: err.stack,
        eventType: event?.type,
        eventId: event?.id,
        paymentIntentId:
          event?.data?.object?.id || event?.data?.object?.payment_intent,
      },
      "Error processing Stripe webhook"
    );
    // Transient failure (database, Stripe API, outbox): 500 so Stripe retries. Retries are
    // safe: an event id is only recorded on the payment once its update has succeeded.
    return res.status(500).json({ received: false });
  }
}

export async function processStripeEvent(event) {
  const obj = event?.data?.object || {};
  const metadata = obj?.metadata || {};
  const tenantId =
    metadata.tenantId || metadata.tenant_id || metadata.tenant || undefined;

  if (!tenantId) {
    logger.warn(
      { eventId: event.id, type: event.type },
      "Missing tenantId in Stripe event metadata"
    );
    // return; // TODO: Uncomment this when we have a way to handle this
  }

  let paymentData = {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutSessionCompleted(event, webhookHooks);
    case "checkout.session.expired":
      return handleCheckoutSessionExpired(event, webhookHooks);
    case "charge.refunded":
    case "charge.refund.updated":
    case "refund.updated":
      return handleRefundEvent(event);
    case "payment_intent.amount_capturable_updated": {
      const pi = obj;
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: "requires_capture",
        stripeStatus: pi.status,
        capturableUntil: await resolveCapturableUntil(pi),
        chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
        customerId: pi.customer || undefined,
        paymentMethodId: pi.payment_method || undefined,
        metadata: pi.metadata || {},
      };

      const applicationId = metadata.applicationId || metadata.application_id;
      const memberId = metadata.memberId || metadata.member_id;

      bizLogger.business("Stripe payment authorised received", {
        eventType: "PaymentAuthorised",
        tenantId: tenantId || null,
        applicationId: applicationId || null,
        membershipId: memberId || metadata.membershipId || null,
        correlationId: metadata.correlationId || event.id,
      });

      break;
    }
    case "payment_intent.succeeded": {
      const pi = obj;
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount_received || pi.amount,
        currency: pi.currency,
        status: "succeeded",
        stripeStatus: pi.status,
        capturedAt: new Date((pi.created || Math.floor(Date.now() / 1000)) * 1000),
        chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
        customerId: pi.customer || undefined,
        paymentMethodId: pi.payment_method || undefined,
        metadata: pi.metadata || {},
      };

      // Application status events are published from reconcileStripeEvent after
      // the payment document is persisted and classified as an application payment.
      const applicationId = metadata.applicationId || metadata.application_id;
      const memberId = metadata.memberId || metadata.member_id;

      bizLogger.business("Stripe payment succeeded received", {
        eventType: "PaymentReceived",
        tenantId: tenantId || null,
        applicationId: applicationId || null,
        membershipId: memberId || metadata.membershipId || null,
        correlationId: metadata.correlationId || event.id,
      });

      if (memberId) {
        logger.info(
          {
            memberId,
            paymentIntentId: pi.id,
            tenantId,
          },
          "Skipping portal event publishing for member payment (memberId present)"
        );
      } else if (applicationId) {
        logger.info(
          {
            applicationId,
            paymentIntentId: pi.id,
            tenantId,
          },
          "Application payment succeeded; status event will be published by reconciliation"
        );
      } else {
        logger.info(
          {
            paymentIntentId: pi.id,
            tenantId,
          },
          "Skipping portal event publishing - no applicationId found in metadata"
        );
      }
      break;
    }
    case "charge.succeeded": {
      // Handle charge.succeeded idempotently
      // Since payment_intent.succeeded is the primary event, we should skip charge.succeeded
      // to avoid processing the same payment twice and causing conflicts
      const charge = obj;
      const paymentIntentId = charge.payment_intent;

      if (!paymentIntentId) {
        logger.warn(
          {
            eventId: event.id,
            eventType: event.type,
            chargeId: charge.id,
          },
          "charge.succeeded event received but no payment_intent found - skipping"
        );
        return;
      }

      // Always skip charge.succeeded - payment_intent.succeeded is the source of truth
      // This prevents conflicts when charge.succeeded arrives first
      const { default: Payment } = await import("../models/payment.model.js");
      const existingPayment = await Payment.findOne({
        "stripe.paymentIntentId": paymentIntentId,
      }).lean();

      if (existingPayment) {
        logger.info(
          {
            eventId: event.id,
            eventType: event.type,
            paymentIntentId,
            paymentId: existingPayment._id,
            existingStatus: existingPayment.status,
          },
          "charge.succeeded event received but payment already exists - skipping (payment_intent.succeeded is primary)"
        );
        return; // Skip - payment_intent.succeeded will handle it
      }

      // Only process if payment doesn't exist at all (very rare edge case)
      logger.info(
        {
          eventId: event.id,
          eventType: event.type,
          paymentIntentId,
          chargeId: charge.id,
        },
        "charge.succeeded event received but payment not found - will be handled by payment_intent.succeeded"
      );
      return; // Skip - let payment_intent.succeeded handle it
    }
    case "payment_intent.payment_failed": {
      const pi = obj;
      const pmd = pi.metadata || {};
      const applicationId = pmd.applicationId || pmd.application_id;
      const memberId = pmd.memberId || pmd.member_id;
      bizLogger.error("Stripe payment failed", {
        eventType: "PaymentFailed",
        tenantId:
          pmd.tenantId || pmd.tenant_id || pmd.tenant || tenantId || null,
        applicationId: applicationId || null,
        membershipId: memberId || null,
        correlationId: pmd.correlationId || event.id,
      });
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: "failed",
        stripeStatus: pi.status,
        failureCode:
          pi.last_payment_error?.code ||
          pi.last_payment_error?.decline_code ||
          undefined,
        failureMessage: pi.last_payment_error?.message || undefined,
        chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
        customerId: pi.customer || undefined,
        paymentMethodId: pi.payment_method || undefined,
        metadata: pi.metadata || {},
      };
      break;
    }
    case "payment_intent.requires_action": {
      const pi = obj;
      const pmd = pi.metadata || {};
      const applicationId = pmd.applicationId || pmd.application_id;
      const memberId = pmd.memberId || pmd.member_id;
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: "requires_action",
        stripeStatus: pi.status,
        chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
        customerId: pi.customer || undefined,
        paymentMethodId: pi.payment_method || undefined,
        nextAction: pi.next_action || undefined,
        metadata: pi.metadata || {},
      };
      break;
    }
    case "payment_intent.canceled": {
      const pi = obj;
      const reason = pi.cancellation_reason;
      const pmd = pi.metadata || {};
      const applicationId = pmd.applicationId || pmd.application_id;
      const memberId = pmd.memberId || pmd.member_id;
      const status =
        reason === "abandoned" || reason === "automatic" || reason === "expired"
          ? "authorization_expired"
          : "canceled";
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status,
        stripeStatus: pi.status,
        canceledAt: new Date((pi.canceled_at || Math.floor(Date.now() / 1000)) * 1000),
        cancellationReason: reason || undefined,
        chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
        customerId: pi.customer || undefined,
        paymentMethodId: pi.payment_method || undefined,
        metadata: pi.metadata || {},
      };
      break;
    }
    default: {
      logger.info({ type: event.type }, "Unhandled Stripe event type");
      return;
    }
  }

  // Only reconcile if paymentData was set (not all cases set it)
  if (paymentData && paymentData.paymentIntentId) {
    paymentData.occurredAt = new Date((event.created || Math.floor(Date.now() / 1000)) * 1000);
    const result = await reconcileStripeEvent(
      {
        eventId: event.id,
        type: event.type,
        payment: paymentData,
      },
      // Stripe metadata tenant is only a claim, checked against the persisted payment.
      { metadataTenantId: tenantId, rethrowOnError: true }
    );
    if (result?.ok && webhookHooks.afterIntentReconciled) {
      await webhookHooks.afterIntentReconciled(paymentData.paymentIntentId, event);
    }
    return result;
  }
  return { ok: true };
}
