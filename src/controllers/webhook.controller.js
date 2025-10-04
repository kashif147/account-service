// src/controllers/webhook.controller.js
import stripe from "../lib/stripe.js";
import { reconcileStripeEvent } from "../services/payments.service.js";
import logger from "../config/logger.js";

export async function handleStripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
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
    logger.error({ err: err.message }, "Error processing Stripe webhook");
    return res.status(500).json({ received: false });
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
    return;
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
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = obj;
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

  await reconcileStripeEvent(
    {
      eventId: event.id,
      type: event.type,
      payment: paymentData,
    },
    { tenantId }
  );
}
