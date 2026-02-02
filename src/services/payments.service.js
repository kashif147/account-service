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
  // Use stored values if available, otherwise fetch from Stripe (fallback)
  let clientSecret = payment?.stripe?.clientSecret;
  let checkoutUrl = payment?.stripe?.checkoutUrl;

  // Only fetch from Stripe if stored values are missing (backward compatibility)
  if (!clientSecret && payment?.stripe?.paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        payment.stripe.paymentIntentId
      );
      clientSecret = pi?.client_secret;
    } catch (_) {}
  }
  if (!checkoutUrl && payment?.stripe?.checkoutSessionId) {
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

  // Normalize currency to lowercase (Stripe requires lowercase)
  const normalizedCurrency = parsed.currency
    ? parsed.currency.toLowerCase()
    : "eur";

  const stripe = getStripe();

  // Idempotency and duplicate protection: check for existing payments BEFORE Stripe API call
  if (ctx.idempotencyKey) {
    const existingByIdem = await Payment.findOne({
      tenantId: ctx.tenantId,
      idempotencyKey: ctx.idempotencyKey,
    })
      .select("stripe status _id")
      .lean();
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
    stripeIds = {
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
    };
  } else {
    const intent = await stripe.paymentIntents.create(
      {
        amount: parsed.amount,
        currency: normalizedCurrency,
        payment_method_types: ["card"],
        metadata: parsed.metadata || {},
      },
      { idempotencyKey: ctx.idempotencyKey || undefined }
    );
    stripeResult = intent;
    status = mapStripeStatusToDomain(intent.status) || "requires_action";
    stripeIds = {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
    };
  }

  try {
    // Extract memberId and applicationId from metadata if not provided directly
    const metadata = parsed.metadata || {};
    const memberIdFromMetadata =
      metadata.memberId ||
      metadata.member_id ||
      metadata.userId ||
      metadata.user_id;
    const applicationIdFromMetadata =
      metadata.applicationId || metadata.application_id;

    const paymentData = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      currency: normalizedCurrency,
      status,
      memberId: parsed.memberId || memberIdFromMetadata,
      applicationId: parsed.applicationId || applicationIdFromMetadata,
      invoiceId: parsed.invoiceId,
      source: "portal",
      mode,
      stripe: stripeIds,
      metadata: metadata,
      audit: {
        createdBy: ctx.userId || ctx.memberId || "system",
        updatedBy: ctx.userId || ctx.memberId || "system",
      },
    };

    // Only include idempotencyKey if it's actually provided (not null or undefined)
    if (ctx.idempotencyKey) {
      paymentData.idempotencyKey = ctx.idempotencyKey;
    }

    const payment = await Payment.create(paymentData);

    return {
      paymentIntentId: stripeIds.paymentIntentId,
      checkoutSessionId: stripeIds.checkoutSessionId,
      clientSecret: stripeIds.clientSecret || stripeResult.client_secret,
      checkoutUrl: stripeIds.checkoutUrl || stripeResult.url,
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
        })
          .select("stripe status _id")
          .lean();
        if (existing) {
          return await buildIntentResponse(existing, stripe);
        }
      }

      // Try to find existing payment by Stripe payment intent ID
      if (stripeIds.paymentIntentId) {
        const existingByPi = await Payment.findOne({
          tenantId: ctx.tenantId,
          "stripe.paymentIntentId": stripeIds.paymentIntentId,
        })
          .select("stripe status _id")
          .lean();
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

  // Extract memberId and applicationId from metadata
  // Support multiple naming conventions: memberId, member_id, userId
  const metadata = parsed.payment.metadata || {};
  const memberId =
    metadata.memberId ||
    metadata.member_id ||
    metadata.userId ||
    metadata.user_id ||
    undefined;
  const applicationId =
    metadata.applicationId || metadata.application_id || undefined;

  const update = {
    $set: {
      amount: parsed.payment.amount,
      currency: parsed.payment.currency,
      status: parsed.payment.status,
      "stripe.chargeId": parsed.payment.chargeId,
      "stripe.customerId": parsed.payment.customerId,
      "stripe.paymentMethodId": parsed.payment.paymentMethodId,
      metadata: metadata,
      "audit.updatedBy": ctx.userId || ctx.memberId || "system",
    },
    $setOnInsert: {
      purpose: "subscriptionFee",
      mode: "stripe",
      "audit.createdBy": ctx.userId || ctx.memberId || "system",
    },
  };

  // Set memberId and applicationId if present in metadata
  if (memberId) {
    update.$set.memberId = memberId;
  }
  if (applicationId) {
    update.$set.applicationId = applicationId;
  }

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
        {
          $set: {
            status: newStatus,
            "audit.updatedBy": ctx.userId || ctx.memberId || "system",
          },
        }
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
      {
        $set: {
          status: newStatus,
          "audit.updatedBy": ctx.userId || ctx.memberId || "system",
        },
      }
    );
  }

  return { ok: true };
}

export async function postJournalForPayment(payment, ctx) {
  // Import required modules
  const { postBalancedJournal } = await import(
    "../controllers/journal.controller.js"
  );
  const { stripeFeeBreakdown } = await import("../helpers/fees.js");

  // Convert amount from cents to currency units
  const amount = payment.amount / 100;

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
  const memberId =
    payment.memberId ||
    metadataObj.memberId ||
    metadataObj.member_id ||
    metadataObj.userId ||
    metadataObj.user_id ||
    null;
  const applicationId =
    payment.applicationId ||
    metadataObj.applicationId ||
    metadataObj.application_id ||
    null;

  // Determine effective member ID (prioritize memberId over applicationId)
  // Receipt should be against memberId if present, otherwise against applicationId
  const effectiveMemberId = memberId
    ? memberId
    : applicationId
    ? `app:${applicationId}`
    : null;

  if (!effectiveMemberId) {
    // Log warning but don't throw - payment is recorded, journal entry can be created manually
    const logger = (await import("../config/logger.js")).default;
    logger.warn(
      {
        paymentId: payment._id,
        memberId: payment.memberId,
        applicationId: payment.applicationId,
        metadata: metadataObj,
      },
      "Skipping journal entry - memberId or applicationId required"
    );
    return null;
  }

  const lines = [
    { accountCode: clearingCode, dc: "D", amount }, // Debit clearing account
    {
      accountCode: "2020",
      dc: "C",
      amount,
      memberId: effectiveMemberId,
      periodBucket: "current",
    }, // Credit Payment on Account - Member credits (2020)
  ];

  // Add Stripe fee entries if payment is via Stripe
  if (payment.mode === "stripe") {
    const { feeNoVat } = stripeFeeBreakdown(amount);
    lines.push({ accountCode: "5100", dc: "D", amount: feeNoVat }); // Payment processing fees
    lines.push({ accountCode: clearingCode, dc: "C", amount: feeNoVat }); // Credit clearing for fees
  }

  // Generate document number
  const docNo = `RCP-${payment._id}`;
  const date = new Date().toISOString().split("T")[0];

  // Create receipt memo - prioritize memberId if present, otherwise use applicationId
  const memo = memberId
    ? `Receipt (member ${memberId})`
    : applicationId
    ? `Receipt (app ${applicationId})`
    : "Receipt";

  // Create journal entry using the exported function
  // Note: postBalancedJournal needs to be exported from journal.controller.js
  const journal = await postBalancedJournal({
    date,
    docType: "Receipt",
    docNo,
    memo,
    lines,
  });

  return journal;
}

export default {
  createIntent,
  findByStripePaymentIntent,
  reconcileStripeEvent,
  recordExternal,
  createRefund,
  postJournalForPayment,
};
