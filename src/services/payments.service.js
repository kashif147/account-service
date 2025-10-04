import Payment, {
  zCreateIntent,
  zReconcile,
  zRecordExternal,
} from "../models/payment.model.js";
import Refund, { zCreateRefund } from "../models/refund.model.js";
import { AppError } from "../errors/AppError.js";
import { getStripe } from "../lib/stripe.js";

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
      return "processing";
    case "processing":
      return "processing";
    case "succeeded":
      return "succeeded";
    case "canceled":
      return "failed";
    default:
      return "processing";
  }
}

async function buildIntentResponse(payment, stripe) {
  let clientSecret;
  let checkoutUrl;
  if (payment?.stripe?.paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        payment.stripe.paymentIntentId
      );
      clientSecret = pi?.client_secret;
    } catch (_) {}
  }
  if (payment?.stripe?.checkoutSessionId) {
    try {
      const cs = await stripe.checkout.sessions.retrieve(
        payment.stripe.checkoutSessionId
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
    id: payment._id.toString(),
  };
}

export async function createIntent(input, ctx) {
  const parsed = zCreateIntent.parse(input);
  ensureIntegerCents(parsed.amount);

  const stripe = getStripe();

  // Idempotency and duplicate protection: check for existing payments BEFORE Stripe API call
  if (ctx.idempotencyKey) {
    const existingByIdem = await Payment.findOne({
      tenantId: ctx.tenantId,
      idempotencyKey: ctx.idempotencyKey,
    });
    if (existingByIdem) {
      return await buildIntentResponse(existingByIdem, stripe);
    }
  }

  let stripeResult = {};
  let status = "created";
  let mode = "stripe";
  let stripeIds = {};

  if (parsed.useCheckout) {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        currency: parsed.currency || "eur",
        line_items: [
          {
            price_data: {
              currency: parsed.currency || "eur",
              product_data: { name: parsed.purpose },
              unit_amount: parsed.amount,
            },
            quantity: 1,
          },
        ],
        success_url: `${
          process.env.PORTAL_BASE_URL || "https://example.com"
        }/payments/success`,
        cancel_url: `${
          process.env.PORTAL_BASE_URL || "https://example.com"
        }/payments/cancel`,
      },
      { idempotencyKey: ctx.idempotencyKey || undefined }
    );
    stripeResult = session;
    status = "requires_action";
    stripeIds = { checkoutSessionId: session.id };
  } else {
    const intent = await stripe.paymentIntents.create(
      {
        amount: parsed.amount,
        currency: parsed.currency || "eur",
        payment_method_types: ["card"],
        metadata: parsed.metadata || {},
      },
      { idempotencyKey: ctx.idempotencyKey || undefined }
    );
    stripeResult = intent;
    status = mapStripeStatusToDomain(intent.status) || "requires_action";
    stripeIds = { paymentIntentId: intent.id };
  }

  // Check for existing payment with the same Stripe payment intent ID
  if (stripeIds.paymentIntentId) {
    const existingByPi = await Payment.findOne({
      tenantId: ctx.tenantId,
      "stripe.paymentIntentId": stripeIds.paymentIntentId,
    });
    if (existingByPi) {
      return await buildIntentResponse(existingByPi, stripe);
    }
  }

  try {
    const paymentData = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      currency: parsed.currency || "eur",
      status,
      memberId: parsed.memberId,
      applicationId: parsed.applicationId,
      invoiceId: parsed.invoiceId,
      source: "portal",
      mode,
      stripe: stripeIds,
      metadata: parsed.metadata || {},
    };

    // Only include idempotencyKey if it's actually provided (not null or undefined)
    if (ctx.idempotencyKey) {
      paymentData.idempotencyKey = ctx.idempotencyKey;
    }

    const payment = await Payment.create(paymentData);

    return {
      paymentIntentId: stripeIds.paymentIntentId,
      checkoutSessionId: stripeIds.checkoutSessionId,
      clientSecret: stripeResult.client_secret,
      checkoutUrl: stripeResult.url,
      status,
      id: payment._id.toString(),
    };
  } catch (e) {
    // Handle MongoDB duplicate key errors (11000) by returning existing payment
    if (e && e.code === 11000) {
      // Try to find existing payment by idempotency key first
      if (ctx.idempotencyKey) {
        const existing = await Payment.findOne({
          tenantId: ctx.tenantId,
          idempotencyKey: ctx.idempotencyKey,
        });
        if (existing) {
          return await buildIntentResponse(existing, stripe);
        }
      }

      // Try to find existing payment by Stripe payment intent ID
      if (stripeIds.paymentIntentId) {
        const existingByPi = await Payment.findOne({
          tenantId: ctx.tenantId,
          "stripe.paymentIntentId": stripeIds.paymentIntentId,
        });
        if (existingByPi) {
          return await buildIntentResponse(existingByPi, stripe);
        }
      }

      // If we can't find an existing payment, it's a real constraint violation
      console.error(
        "MongoDB duplicate key error but no existing payment found:",
        {
          error: e,
          tenantId: ctx.tenantId,
          idempotencyKey: ctx.idempotencyKey,
          paymentIntentId: stripeIds.paymentIntentId,
        }
      );
    }
    throw e;
  }
}

export async function findByStripePaymentIntent(paymentIntentId, ctx) {
  const doc = await Payment.findOne({
    tenantId: ctx.tenantId,
    "stripe.paymentIntentId": paymentIntentId,
  });
  if (!doc) return null;
  return doc;
}

export async function reconcileStripeEvent(input, ctx) {
  const parsed = zReconcile.parse(input);
  ensureIntegerCents(parsed.payment.amount);
  const filter = {
    tenantId: ctx.tenantId,
    "stripe.paymentIntentId": parsed.payment.paymentIntentId,
  };
  const update = {
    $set: {
      amount: parsed.payment.amount,
      currency: parsed.payment.currency,
      status: parsed.payment.status,
      "stripe.chargeId": parsed.payment.chargeId,
      "stripe.customerId": parsed.payment.customerId,
      "stripe.paymentMethodId": parsed.payment.paymentMethodId,
      metadata: parsed.payment.metadata || {},
    },
    $setOnInsert: {
      purpose: "subscriptionFee",
      mode: "stripe",
    },
  };
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };
  const doc = await Payment.findOneAndUpdate(filter, update, options);

  if (parsed.payment.status === "succeeded") {
    await postJournalForPayment(doc, ctx);
  }

  return { ok: true };
}

export async function recordExternal(input, ctx) {
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
    await postJournalForPayment(payment, ctx);
    return { ok: true, paymentId: payment._id.toString() };
  }

  // direction === "out" maps to refund
  const refund = await Refund.create({
    tenantId: ctx.tenantId,
    mode: "external",
    amount: parsed.amount,
    currency: parsed.currency,
    reason: parsed.reason,
    metadata: parsed.metadata || {},
  });
  return { ok: true, refundId: refund._id.toString() };
}

export async function createRefund(input, ctx) {
  const parsed = zCreateRefund.parse(input);
  const stripe = getStripe();

  if (parsed.mode === "stripe") {
    const refund = await stripe.refunds.create(
      {
        charge: parsed.chargeId,
        payment_intent: parsed.paymentIntentId,
        amount: parsed.amount,
        reason: parsed.reason,
        metadata: parsed.metadata || {},
      },
      { idempotencyKey: ctx.idempotencyKey || undefined }
    );

    const payment = await Payment.findOne({
      tenantId: ctx.tenantId,
      "stripe.paymentIntentId": parsed.paymentIntentId,
    });

    const refundDoc = await Refund.create({
      tenantId: ctx.tenantId,
      paymentId: payment ? payment._id : undefined,
      mode: "stripe",
      amount: parsed.amount || (payment ? payment.amount : undefined),
      currency: payment ? payment.currency : "eur",
      reason: parsed.reason,
      stripe: {
        refundId: refund.id,
        chargeId: refund.charge || undefined,
        paymentIntentId: parsed.paymentIntentId,
      },
      note: parsed.note,
      metadata: parsed.metadata || {},
    });

    if (payment) {
      const newStatus =
        parsed.amount && parsed.amount < payment.amount
          ? "partially_refunded"
          : "refunded";
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: newStatus } }
      );
    }

    return { refundId: refund.id, status: "ok" };
  }

  // external refund
  const payment = parsed.paymentIntentId
    ? await Payment.findOne({
        tenantId: ctx.tenantId,
        "stripe.paymentIntentId": parsed.paymentIntentId,
      })
    : null;

  const refundDoc = await Refund.create({
    tenantId: ctx.tenantId,
    paymentId: payment ? payment._id : undefined,
    mode: "external",
    amount: parsed.amount || (payment ? payment.amount : undefined),
    currency: payment ? payment.currency : "eur",
    reason: parsed.reason,
    note: parsed.note,
    metadata: parsed.metadata || {},
  });

  if (payment) {
    const newStatus =
      parsed.amount && parsed.amount < payment.amount
        ? "partially_refunded"
        : "refunded";
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: newStatus } }
    );
  }

  return { ok: true };
}

export async function postJournalForPayment(payment, ctx) {
  const debit = {
    account: "Cash",
    amount: payment.amount,
    currency: payment.currency,
  };
  const credit = {
    account: "Revenue",
    amount: payment.amount,
    currency: payment.currency,
  };
  return {
    tenantId: ctx.tenantId,
    entries: [debit, credit],
    meta: { paymentId: payment._id.toString(), purpose: payment.purpose },
  };
}

export default {
  createIntent,
  findByStripePaymentIntent,
  reconcileStripeEvent,
  recordExternal,
  createRefund,
  postJournalForPayment,
};
