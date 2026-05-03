// src/controllers/webhook.controller.js
import stripe from "../lib/stripe.js";
import { reconcileStripeEvent } from "../services/payments.service.js";
import { publishDomainEvent, APPLICATION_EVENTS } from "../rabbitMQ/index.js";
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
    await processStripeEvent(event);
    return res.json({ received: true });
  } catch (err) {
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
    // Don't return 500 - log the error but return 200 to prevent Stripe retries
    // The payment can be reconciled manually if needed
    return res.status(200).json({ received: true, error: err.message });
  }
}

async function processStripeEvent(event) {
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
    case "payment_intent.succeeded": {
      const pi = obj;
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: "succeeded",
        chargeId: pi.latest_charge || pi.charges?.data?.[0]?.id,
        customerId: pi.customer || undefined,
        paymentMethodId: pi.payment_method || undefined,
        metadata: pi.metadata || {},
      };

      // Publish portal event to update application status to submitted
      // Only publish if there's an applicationId and no memberId in metadata
      const applicationId = metadata.applicationId || metadata.application_id;
      const memberId = metadata.memberId || metadata.member_id;

      bizLogger.business("Stripe payment succeeded received", {
        eventType: "PaymentReceived",
        tenantId: tenantId || null,
        applicationId: applicationId || null,
        membershipId: memberId || metadata.membershipId || null,
        correlationId: metadata.correlationId || event.id,
      });

      if (applicationId && !memberId) {
        try {
          await publishDomainEvent(
            APPLICATION_EVENTS.STATUS_UPDATED,
            {
              applicationId,
              status: "submitted",
              paymentIntentId: pi.id,
              amount: pi.amount,
              currency: pi.currency,
              tenantId,
            },
            {
              source: "stripe-webhook",
              eventId: event.id,
            }
          );
          logger.info(
            {
              applicationId,
              paymentIntentId: pi.id,
              tenantId,
            },
            "Published application status update event to portal-service"
          );
        } catch (error) {
          logger.error(
            {
              error: error.message,
              applicationId,
              paymentIntentId: pi.id,
              tenantId,
            },
            "Failed to publish application status update event"
          );
          // Continue processing even if event publishing fails
        }
      } else if (memberId) {
        logger.info(
          {
            memberId,
            paymentIntentId: pi.id,
            tenantId,
          },
          "Skipping portal event publishing for member payment (memberId present)"
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
      bizLogger.error("Stripe payment failed", {
        eventType: "PaymentFailed",
        tenantId:
          pmd.tenantId || pmd.tenant_id || pmd.tenant || tenantId || null,
        applicationId: pmd.applicationId || pmd.application_id || null,
        membershipId: pmd.memberId || pmd.member_id || null,
        correlationId: pmd.correlationId || event.id,
      });
      paymentData = {
        paymentIntentId: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: "failed",
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
    await reconcileStripeEvent(
      {
        eventId: event.id,
        type: event.type,
        payment: paymentData,
      },
      { tenantId }
    );
  }
}
