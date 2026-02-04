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

  // Extract memberId and applicationId from metadata if not provided directly
  // (needed for duplicate check before Stripe API call)
  const metadata = parsed.metadata || {};
  const memberIdFromMetadata =
    metadata.memberId ||
    metadata.member_id ||
    metadata.userId ||
    metadata.user_id;
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
      .select("stripe status _id")
      .lean();
    if (existingByIdem) {
      return await buildIntentResponse(existingByIdem, stripe);
    }
  }

  // 2. Check for recent duplicate payments (same member/application, amount, purpose)
  // This prevents duplicates even when different idempotency keys are used
  // Only check for payments created in the last 5 minutes that are still in progress
  if (memberId || applicationId) {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const duplicateCheck = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      createdAt: { $gte: fiveMinutesAgo },
      status: {
        $in: ["created", "requires_action", "processing"],
      },
    };

    if (memberId) {
      duplicateCheck.memberId = memberId;
    }
    if (applicationId) {
      duplicateCheck.applicationId = applicationId;
    }

    const existingDuplicate = await Payment.findOne(duplicateCheck)
      .select("stripe status _id")
      .sort({ createdAt: -1 })
      .lean();

    if (existingDuplicate) {
      const logger = (await import("../config/logger.js")).default;
      logger.warn(
        {
          existingPaymentId: existingDuplicate._id,
          existingStatus: existingDuplicate.status,
          memberId,
          applicationId,
          amount: parsed.amount,
          purpose: parsed.purpose,
          idempotencyKey: ctx.idempotencyKey,
        },
        "Duplicate payment detected - returning existing payment"
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
            "Updated existing payment with memberId/applicationId"
          );
        }
      }

      return await buildIntentResponse(existingDuplicate, stripe);
    }
  }

  // Final duplicate check right before Stripe API call to catch race conditions
  // This is the last chance to prevent duplicate Stripe payment intents
  if (memberId || applicationId) {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000); // Check last 1 minute
    const lastSecondCheck = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      createdAt: { $gte: oneMinuteAgo },
      status: {
        $in: ["created", "requires_action", "processing"],
      },
    };

    if (memberId) {
      lastSecondCheck.memberId = memberId;
    }
    if (applicationId) {
      lastSecondCheck.applicationId = applicationId;
    }

    const recentPayment = await Payment.findOne(lastSecondCheck)
      .select("stripe status _id")
      .sort({ createdAt: -1 })
      .lean();

    if (recentPayment) {
      const logger = (await import("../config/logger.js")).default;
      logger.warn(
        {
          existingPaymentId: recentPayment._id,
          existingStatus: recentPayment.status,
          memberId,
          applicationId,
          amount: parsed.amount,
          purpose: parsed.purpose,
          idempotencyKey: ctx.idempotencyKey,
          timeSinceCreation:
            Date.now() - new Date(recentPayment.createdAt).getTime(),
        },
        "Race condition detected - payment created within last minute, returning existing payment"
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
            "Updated existing payment with memberId/applicationId (race condition)"
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
    "Creating Stripe payment intent with idempotency key"
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
      { idempotencyKey: stripeIdempotencyKey }
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
          "Payment with this Stripe checkout session ID already exists - returning existing payment"
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
          "Recent payment with paymentIntentId found - returning existing payment to prevent duplicate Stripe intent"
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
        { idempotencyKey: stripeIdempotencyKey }
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
          "Stripe idempotency error - retrying without idempotency key"
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
          "Payment with this Stripe payment intent ID already exists - returning existing payment"
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
              "Updated existing payment with memberId/applicationId (paymentIntentId check)"
            );
          }
        }

        return await buildIntentResponse(existingByIntent, stripe);
      }
    }
  }

  try {
    // memberId and applicationId already extracted above for duplicate check
    const paymentData = {
      tenantId: ctx.tenantId,
      purpose: parsed.purpose,
      amount: parsed.amount,
      currency: normalizedCurrency,
      status,
      memberId,
      applicationId,
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
        "TenantId mismatch in webhook reconciliation - using existing payment's tenantId"
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
      "Found existing payment for webhook reconciliation"
    );
  }

  // Extract memberId and applicationId from metadata
  // Support multiple naming conventions: memberId, member_id, userId
  // Also preserve existing memberId/applicationId from payment if metadata doesn't have them
  const metadata = parsed.payment.metadata || {};
  const memberIdFromMetadata =
    metadata.memberId ||
    metadata.member_id ||
    metadata.userId ||
    metadata.user_id ||
    undefined;
  const applicationIdFromMetadata =
    metadata.applicationId || metadata.application_id || undefined;

  // Use metadata values if present, otherwise preserve existing payment values
  // This ensures journal entries can be created even if webhook metadata is incomplete
  const memberId =
    memberIdFromMetadata || existingPayment?.memberId || undefined;
  const applicationId =
    applicationIdFromMetadata || existingPayment?.applicationId || undefined;

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
      { paymentIntentId: parsed.payment.paymentIntentId }
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

  // Set memberId and applicationId - prefer metadata, but preserve existing if metadata missing
  // This is critical for journal entry creation
  if (memberId) {
    update.$set.memberId = memberId;
  } else if (existingPayment?.memberId) {
    // Preserve existing memberId if metadata doesn't have it
    update.$set.memberId = existingPayment.memberId;
  }
  if (applicationId) {
    update.$set.applicationId = applicationId;
  } else if (existingPayment?.applicationId) {
    // Preserve existing applicationId if metadata doesn't have it
    update.$set.applicationId = existingPayment.applicationId;
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
        },
        "Payment.findOneAndUpdate returned null - payment not found or not updated"
      );
      throw new Error(
        `Failed to update or create payment for paymentIntentId: ${parsed.payment.paymentIntentId}`
      );
    }

    // Only create journal entry if status is succeeded and we haven't already created one
    if (parsed.payment.status === "succeeded") {
      // Check if journal entry already exists for this payment
      const { GLTransaction } = await import(
        "../models/glTransaction.model.js"
      );
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
          "Creating journal entry for succeeded payment"
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
              "Journal entry created successfully for payment"
            );
          } else {
            logger.warn(
              {
                paymentId: doc._id,
                memberId: doc.memberId,
                applicationId: doc.applicationId,
              },
              "Journal entry creation returned null - missing memberId or applicationId"
            );
          }
        } catch (journalError) {
          logger.error(
            {
              paymentId: doc._id,
              error: journalError.message,
              stack: journalError.stack,
            },
            "Failed to create journal entry for payment"
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
          "Journal entry already exists for payment"
        );
      }
    }

    return { ok: true };
  } catch (error) {
    const logger = (await import("../config/logger.js")).default;

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
        "Payment already succeeded - ensuring journal entry exists"
      );

      // Check if journal entry exists
      const { GLTransaction } = await import(
        "../models/glTransaction.model.js"
      );
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
                "Journal entry created for already-succeeded payment"
              );
            }
          } catch (journalError) {
            logger.error(
              {
                paymentId: fullPayment._id,
                error: journalError.message,
              },
              "Failed to create journal entry for already-succeeded payment"
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
          const { GLTransaction } = await import(
            "../models/glTransaction.model.js"
          );
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
              "Creating journal entry for succeeded payment (duplicate key recovery)"
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
                  "Journal entry created successfully for payment (duplicate key recovery)"
                );
              } else {
                logger.warn(
                  {
                    paymentId: doc._id,
                    memberId: doc.memberId,
                    applicationId: doc.applicationId,
                  },
                  "Journal entry creation returned null - missing memberId or applicationId (duplicate key recovery)"
                );
              }
            } catch (journalError) {
              logger.error(
                {
                  paymentId: doc._id,
                  error: journalError.message,
                  stack: journalError.stack,
                },
                "Failed to create journal entry for payment (duplicate key recovery)"
              );
              // Don't throw - payment is reconciled, journal can be created manually
            }
          }
        }

        return { ok: true };
      }
    }
    throw error;
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
  const logger = (await import("../config/logger.js")).default;

  // Convert amount from cents to currency units
  const amount = payment.amount / 100;

  logger.info(
    {
      paymentId: payment._id,
      amount,
      mode: payment.mode,
      memberId: payment.memberId,
      applicationId: payment.applicationId,
    },
    "postJournalForPayment called"
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
      "Skipping journal entry - memberId or applicationId required"
    );
    return null;
  }

  // Build entry for account 2020 - use memberId if present, otherwise applicationId
  const entry2020 = {
    accountCode: "2020",
    dc: "C",
    amount,
    periodBucket: "current",
  };

  if (memberId) {
    entry2020.memberId = memberId;
  } else if (applicationId) {
    entry2020.applicationId = applicationId;
  }

  const lines = [
    { accountCode: clearingCode, dc: "D", amount }, // Debit clearing account
    entry2020, // Credit Payment on Account - Member credits (2020)
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
    settlement,
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
