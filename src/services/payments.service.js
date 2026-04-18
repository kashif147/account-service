import Payment, {
  zCreateIntent,
  zReconcile,
  zRecordExternal,
} from "../models/payment.model.js";
import Refund, { zCreateRefund } from "../models/refund.model.js";
import { AppError } from "../errors/AppError.js";
import { getStripe } from "../lib/stripe.js";
import {
  assertRefundWithinCredit,
  getClaimRecipientMemberIdForApplication,
} from "./refundCredit.service.js";
import { centsToEuros } from "../helpers/money.js";

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

  // Extract memberId and applicationId from metadata if not provided directly
  // (needed for duplicate check before Stripe API call)
  // IMPORTANT: Do NOT use userId as memberId - userId is just a user identifier, not a member identifier
  // For application payments, applicationId should be used, not memberId
  const metadata = parsed.metadata || {};
  const memberIdFromMetadata =
    metadata.memberId || metadata.member_id || undefined; // Do not use userId as memberId
  const applicationIdFromMetadata =
    metadata.applicationId || metadata.application_id;

  const memberId = parsed.memberId || memberIdFromMetadata;
  const applicationId = parsed.applicationId || applicationIdFromMetadata;

  // Idempotency and duplicate protection: check for existing payments BEFORE Stripe API call
  // 1. Check by idempotency key (if provided)
  if (ctx.idempotencyKey) {
    const existingByIdem = await Payment.findOne({
      tenantId: ctx.tenantId,
      idempotencyKey: ctx.idempotencyKey,
    })
      .select("stripe status _id memberId applicationId")
      .lean();
    if (existingByIdem) {
      const logger = (await import("../config/logger.js")).default;
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

  // 2. Check for recent duplicate payments (same member/application, amount, purpose)
  // This prevents duplicates even when different idempotency keys are used
  // Check for payments created in the last 10 minutes (increased window for race conditions)
  // Include ALL statuses to catch any recent payment attempt
  if (memberId || applicationId) {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const duplicateCheck = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      createdAt: { $gte: tenMinutesAgo },
      // Don't filter by status - check ALL recent payments to prevent duplicates
    };

    if (memberId) {
      duplicateCheck.memberId = memberId;
    }
    if (applicationId) {
      duplicateCheck.applicationId = applicationId;
    }

    const existingDuplicate = await Payment.findOne(duplicateCheck)
      .select("stripe status _id memberId applicationId")
      .sort({ createdAt: -1 })
      .lean();

    if (existingDuplicate) {
      const logger = (await import("../config/logger.js")).default;
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
          await Payment.findByIdAndUpdate(existingDuplicate._id, {
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

  // Final duplicate check right before Stripe API call to catch race conditions
  // This is the last chance to prevent duplicate Stripe payment intents
  // Check for ANY recent payment with same parameters (not just in-progress)
  if (memberId || applicationId) {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000); // Check last 2 minutes
    const lastSecondCheck = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      createdAt: { $gte: twoMinutesAgo },
      // Check ALL statuses to catch any recent payment attempt
    };

    if (memberId) {
      lastSecondCheck.memberId = memberId;
    }
    if (applicationId) {
      lastSecondCheck.applicationId = applicationId;
    }

    const recentPayment = await Payment.findOne(lastSecondCheck)
      .select("stripe status _id memberId applicationId createdAt")
      .sort({ createdAt: -1 })
      .lean();

    if (recentPayment) {
      const logger = (await import("../config/logger.js")).default;
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
          await Payment.findByIdAndUpdate(recentPayment._id, {
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

  // Use client's idempotency key for Stripe if provided, otherwise generate a unique one
  // Stripe requires idempotency keys to be used with exact same parameters, so we can't use
  // a deterministic key based on payment parameters (they might vary between requests)
  // We already have duplicate payment checks in place, so we don't need deterministic keys
  const crypto = await import("crypto");
  let stripeIdempotencyKey = null;

  if (ctx.idempotencyKey) {
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

  const logger = (await import("../config/logger.js")).default;
  logger.info(
    {
      clientIdempotencyKey: ctx.idempotencyKey,
      stripeIdempotencyKey,
      memberId,
      applicationId,
      amount: parsed.amount,
      purpose: parsed.purpose,
    },
    "Creating Stripe payment intent with idempotency key",
  );

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
      { idempotencyKey: stripeIdempotencyKey },
    );
    stripeResult = session;
    status = "requires_action";
    stripeIds = {
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
    };

    // After creating Stripe checkout session, check if a payment with this session ID already exists
    // This catches race conditions where two requests create sessions simultaneously
    if (stripeIds.checkoutSessionId) {
      const existingBySession = await Payment.findOne({
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
    if (memberId || applicationId) {
      const recentCheck = {
        tenantId: ctx.tenantId,
        purpose: parsed.purpose,
        amount: parsed.amount,
        createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) }, // Last 2 minutes
        "stripe.paymentIntentId": { $exists: true, $ne: null },
      };
      if (memberId) recentCheck.memberId = memberId;
      if (applicationId) recentCheck.applicationId = applicationId;

      const recentWithIntent = await Payment.findOne(recentCheck)
        .select("stripe status _id memberId applicationId")
        .lean();

      if (recentWithIntent && recentWithIntent.stripe?.paymentIntentId) {
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
            await Payment.findByIdAndUpdate(recentWithIntent._id, {
              $set: updateFields,
            });
          }
        }

        return await buildIntentResponse(recentWithIntent, stripe);
      }
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: parsed.amount,
          currency: normalizedCurrency,
          payment_method_types: ["card"],
          metadata: parsed.metadata || {},
        },
        { idempotencyKey: stripeIdempotencyKey },
      );
    } catch (stripeError) {
      // Handle Stripe idempotency errors - retry without idempotency key
      // This happens when the same key was used with different parameters
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
          metadata: parsed.metadata || {},
        });
      } else {
        throw stripeError;
      }
    }

    stripeResult = intent;
    status = mapStripeStatusToDomain(intent.status) || "requires_action";
    stripeIds = {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
    };

    // After creating Stripe payment intent, check if a payment with this intent ID already exists
    // This catches race conditions where two requests create intents simultaneously
    if (stripeIds.paymentIntentId) {
      const existingByIntent = await Payment.findOne({
        "stripe.paymentIntentId": stripeIds.paymentIntentId,
      })
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
            await Payment.findByIdAndUpdate(existingByIntent._id, {
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
      const existingByIntentId = await Payment.findOne({
        "stripe.paymentIntentId": stripeIds.paymentIntentId,
      })
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
            await Payment.findByIdAndUpdate(existingByIntentId._id, {
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
      amount: parsed.amount,
      currency: normalizedCurrency,
      status,
      // Only set memberId if applicationId is not present
      ...(applicationId ? { applicationId } : memberId ? { memberId } : {}),
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
        },
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

  // ALWAYS search by paymentIntentId first (without tenantId filter)
  // This ensures we find the existing payment regardless of tenantId mismatch
  let existingPayment = null;
  if (parsed.payment.paymentIntentId) {
    // Search by paymentIntentId alone first (most reliable)
    existingPayment = await Payment.findOne({
      "stripe.paymentIntentId": parsed.payment.paymentIntentId,
    }).lean();

    // If found, log tenantId comparison for debugging
    if (
      existingPayment &&
      ctx.tenantId &&
      existingPayment.tenantId !== ctx.tenantId
    ) {
      const logger = (await import("../config/logger.js")).default;
      logger.warn(
        {
          paymentId: existingPayment._id,
          paymentIntentId: parsed.payment.paymentIntentId,
          existingTenantId: existingPayment.tenantId,
          webhookTenantId: ctx.tenantId,
        },
        "TenantId mismatch in webhook reconciliation - using existing payment's tenantId",
      );
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
  const applicationId =
    applicationIdFromMetadata || existingPayment?.applicationId || undefined;
  const memberId =
    // Only use memberId if applicationId is not present
    (!applicationId && (memberIdFromMetadata || existingPayment?.memberId)) ||
    undefined;

  // Build filter - ALWAYS use existing payment's tenantId if found
  // This prevents creating duplicates when tenantId doesn't match
  const filter = {
    tenantId: existingPayment?.tenantId || ctx.tenantId,
    "stripe.paymentIntentId": parsed.payment.paymentIntentId,
  };

  // If no existing payment and no tenantId, we can't safely upsert
  if (!existingPayment && !filter.tenantId) {
    throw AppError.badRequest(
      "tenantId is required for payment reconciliation when no existing payment found",
      { paymentIntentId: parsed.payment.paymentIntentId },
    );
  }

  const update = {
    $set: {
      amount: parsed.payment.amount,
      currency: parsed.payment.currency,
      status: parsed.payment.status,
      "stripe.chargeId": parsed.payment.chargeId,
      "stripe.customerId": parsed.payment.customerId,
      "stripe.paymentMethodId": parsed.payment.paymentMethodId,
      "stripe.paymentIntentId": parsed.payment.paymentIntentId, // Ensure it's set
      metadata: metadata,
      "audit.updatedBy": ctx.userId || ctx.memberId || "system",
    },
    $setOnInsert: {
      tenantId: filter.tenantId, // Ensure tenantId is set on insert
      purpose: "subscriptionFee",
      mode: "stripe",
      "audit.createdBy": ctx.userId || ctx.memberId || "system",
    },
  };

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
  }

  const options = {
    upsert: !existingPayment,
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
      const retryPayment = await Payment.findOne({
        "stripe.paymentIntentId": parsed.payment.paymentIntentId,
      }).lean();

      if (retryPayment) {
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
            docNo: `RCP-${retryPayment._id}`,
          }).lean();

          if (!existingJournal) {
            try {
              const journal = await postJournalForPayment(retryPayment, ctx);
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
          const journal = await postJournalForPayment(doc, ctx);
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
    }

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
        docNo: `RCP-${existingPayment._id}`,
      }).lean();

      if (!existingJournal) {
        // Try to get the full payment document
        const fullPayment = await Payment.findById(existingPayment._id).lean();
        if (fullPayment) {
          try {
            // postJournalForPayment is defined in this file, call it directly
            // We need to import it at the top level, but for now use the function reference
            const journal = await postJournalForPayment(fullPayment, ctx);
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

      return { ok: true };
    }

    // Handle duplicate key errors (race condition)
    if (error.code === 11000) {
      // Try to find the existing payment by paymentIntentId alone
      const existing = await Payment.findOne({
        "stripe.paymentIntentId": parsed.payment.paymentIntentId,
      }).lean();

      if (existing) {
        // Update the existing payment instead
        // Preserve existing memberId/applicationId if metadata doesn't have them
        const memberIdToUse = memberId || existing.memberId;
        const applicationIdToUse = applicationId || existing.applicationId;

        const updateOnly = {
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
        };
        if (memberIdToUse) updateOnly.$set.memberId = memberIdToUse;
        if (applicationIdToUse)
          updateOnly.$set.applicationId = applicationIdToUse;

        const doc = await Payment.findByIdAndUpdate(existing._id, updateOnly, {
          new: true,
        });

        if (parsed.payment.status === "succeeded") {
          const GLTransactionModule =
            await import("../models/glTransaction.model.js");
          const GLTransaction = GLTransactionModule.default;
          const existingJournal = await GLTransaction.findOne({
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
              const journal = await postJournalForPayment(doc, ctx);
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
          docNo: `RCP-${finalRetry._id}`,
        }).lean();

        if (!existingJournal) {
          try {
            const journal = await postJournalForPayment(finalRetry, ctx);
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

    // Return success to prevent webhook retries
    return {
      ok: true,
      warning: "Payment reconciliation had errors but was attempted",
    };
  }
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
export async function postJournalForRefund(refundDoc, payment, _ctx) {
  const { postBalancedJournal } =
    await import("../controllers/journal.controller.js");
  const { buildMemberRefundDebitEntries } = await import(
    "../helpers/paymentReceiptAllocation.js"
  );
  const logger = (await import("../config/logger.js")).default;
  const GLTransaction = (await import("../models/glTransaction.model.js"))
    .default;

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
    memberId = await getClaimRecipientMemberIdForApplication(applicationId);
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
  const existing = await GLTransaction.findOne({ docNo }).lean();
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
    docType: "Refund",
    docNo,
    reference,
    memo,
    lines,
  });
}

export async function postJournalForPayment(payment, ctx) {
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
    docType: "Receipt",
    docNo,
    memo,
    lines,
    settlement,
  });

  return journal;
}

/**
 * @param {Object} ctx - { tenantId }
 * @param {Object} options - from zListRefundsQuery
 */
export async function listRefunds(ctx, options) {
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
  recordExternal,
  createRefund,
  postJournalForPayment,
  postJournalForRefund,
  clearingAccountCodeForRefund,
  listRefunds,
  listByMemberIds,
  associateMemberLinks,
};
