// Example listener for application approval events
// This creates invoices automatically when applications are approved

import logger from "../config/logger.js";
import { invoice } from "../controllers/journal.controller.js";
import { claimApplicationCredit } from "../controllers/journal.controller.js";
import CoA from "../models/coa.model.js";
import Product from "../models/product.model.js";
import Pricing from "../models/pricing.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import { globalDBLimiter } from "../config/globalLimiter.js";

/**
 * Maps membership category to income account code
 * Update this mapping based on your Chart of Accounts
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalize to YYYY-MM-DD or null. */
function toIsoDateOnly(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().split("T")[0];
  }
  const s = String(value).split("T")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Lexicographic max works for ISO calendar dates (YYYY-MM-DD). */
function laterIsoDate(isoA, isoB) {
  const a = toIsoDateOnly(isoA) || "";
  const b = toIsoDateOnly(isoB) || "";
  return a > b ? a : b;
}

async function getIncomeCodeForCategory(categoryName) {
  // Default mapping - customize based on your CoA
  const categoryToIncomeCode = {
    "General All Grades": "4000",
    "Short-term / Relief": "4010",
    "Private nursing home": "4040",
    "Affiliate members": "4050",
    Lecturing: "4060",
    Associate: "4070",
    "Retired Associate": "4080",
    Students: "4090",
    // Add more mappings as needed
  };

  const code = categoryToIncomeCode[categoryName];
  if (code) {
    // Verify account exists in CoA
    const coa = await CoA.findOne({ code }).lean();
    if (coa) return code;
  }

  // Default to 4000 if category not found or account doesn't exist
  logger.warn(
    { categoryName, code },
    "Using default income code 4000 for category"
  );
  return "4000";
}

/**
 * Gets annual fee for membership category
 * Matches products by code OR name against membershipCategory
 * Always looks up pricing from pricing table based on effective dates
 */
export async function getMembershipPricing({
  categoryName,
  subscriptionDetails,
  startDate,
  tenantId,
  profileId,
  applicationId,
}) {
  let annualFee = null; // Always start with null - ignore subscriptionDetails.annualFee
  let incomeCode = null;
  let product = null;

  if (!tenantId) {
    logger.warn(
      { categoryName, profileId, applicationId },
      "Missing tenantId for product lookup"
    );
  } else {
    // Try to match product by code first (exact match, case-insensitive)
    // Then try by name (case-insensitive, supports partial matching)
    const categoryUpper = categoryName?.toUpperCase().trim();
    const categoryEscaped = escapeRegex(categoryName?.trim() || "");

    // More flexible matching: exact match or contains
    const categoryRegex = new RegExp(
      `^${categoryEscaped}$|${categoryEscaped}`,
      "i"
    );

    product = await Product.findOne({
      tenantId,
      isDeleted: false,
      isActive: true,
      $or: [
        { code: categoryUpper },
        { name: categoryRegex },
        // Also try case-insensitive code match
        { code: { $regex: new RegExp(`^${categoryEscaped}$`, "i") } },
      ],
    }).lean();

    if (product) {
      logger.info(
        {
          categoryName,
          productId: product._id,
          productCode: product.code,
          productName: product.name,
          profileId,
          applicationId,
        },
        "Found matching product for membership category"
      );

      // Get income code from product if available
      // Note: product.code might be a product code, not income account code
      // We'll still use getIncomeCodeForCategory for income code mapping

      // Always look up pricing (ignore any annualFee from subscriptionDetails)
      if (product._id) {
        const subscriptionStartDate = parseDate(startDate);
        if (!subscriptionStartDate) {
          logger.warn(
            {
              productId: product._id,
              startDate,
              categoryName,
              profileId,
              applicationId,
            },
            "Invalid subscription startDate for pricing lookup"
          );
        } else {
          // Find pricing where:
          // - effectiveFrom <= subscriptionStartDate (pricing has started)
          // - effectiveTo >= subscriptionStartDate OR effectiveTo is null (pricing hasn't ended or has no end date)
          // Sort by effectiveFrom descending to get the most recent applicable pricing
          const pricing = await Pricing.findOne({
            tenantId,
            productId: product._id,
            isDeleted: false,
            isActive: true,
            effectiveFrom: { $lte: subscriptionStartDate },
            $or: [
              { effectiveTo: { $gte: subscriptionStartDate } },
              { effectiveTo: null },
            ],
          })
            .sort({ effectiveFrom: -1 })
            .lean();

          if (pricing) {
            // Prices are stored in cents, so use as-is
            // Priority: price > memberPrice > nonMemberPrice
            annualFee =
              pricing.price ??
              pricing.memberPrice ??
              pricing.nonMemberPrice ??
              null;

            if (annualFee != null) {
              logger.info(
                {
                  productId: product._id,
                  pricingId: pricing._id,
                  annualFee,
                  annualFeeInEuros: (annualFee / 100).toFixed(2), // For logging clarity
                  subscriptionStartDate: subscriptionStartDate.toISOString(),
                  pricingEffectiveFrom: pricing.effectiveFrom
                    ? new Date(pricing.effectiveFrom).toISOString()
                    : null,
                  pricingEffectiveTo: pricing.effectiveTo
                    ? new Date(pricing.effectiveTo).toISOString()
                    : null,
                  profileId,
                  applicationId,
                },
                "Found pricing for product matching subscription start date"
              );
            } else {
              logger.warn(
                {
                  productId: product._id,
                  pricingId: pricing._id,
                  profileId,
                  applicationId,
                },
                "Pricing found but no price value (price, memberPrice, or nonMemberPrice) is set"
              );
            }
          } else {
            // Log all available pricings for debugging
            const allPricings = await Pricing.find({
              tenantId,
              productId: product._id,
              isDeleted: false,
              isActive: true,
            })
              .sort({ effectiveFrom: -1 })
              .lean();

            logger.warn(
              {
                productId: product._id,
                subscriptionStartDate: subscriptionStartDate.toISOString(),
                categoryName,
                availablePricings: allPricings.map((p) => ({
                  pricingId: p._id,
                  effectiveFrom: p.effectiveFrom
                    ? new Date(p.effectiveFrom).toISOString()
                    : null,
                  effectiveTo: p.effectiveTo
                    ? new Date(p.effectiveTo).toISOString()
                    : null,
                  price: p.price ?? p.memberPrice ?? p.nonMemberPrice,
                  priceInEuros: p.price
                    ? (p.price / 100).toFixed(2)
                    : p.memberPrice
                    ? (p.memberPrice / 100).toFixed(2)
                    : p.nonMemberPrice
                    ? (p.nonMemberPrice / 100).toFixed(2)
                    : null,
                })),
                profileId,
                applicationId,
              },
              "No active pricing found for product matching subscription start date range"
            );
          }
        }
      }
    } else {
      logger.warn(
        {
          categoryName,
          categoryUpper,
          tenantId,
          profileId,
          applicationId,
        },
        "No product found matching code or name for membership category"
      );
    }
  }

  // Get income code from category mapping (not from product.code)
  if (incomeCode == null) {
    incomeCode = await getIncomeCodeForCategory(categoryName);
  }

  // Fallback to defaults only if no pricing found
  if (annualFee == null) {
    // fallback defaults if no pricing found (in cents to match pricing table format)
    const defaultFees = {
      "General All Grades": 50000, // 500.00 in cents
      Associate: 30000, // 300.00 in cents
      Student: 0,
    };
    annualFee = defaultFees[categoryName] || 50000; // Default to 500.00 in cents
    logger.warn(
      {
        categoryName,
        annualFee,
        annualFeeInEuros: (annualFee / 100).toFixed(2),
        profileId,
        applicationId,
      },
      "Using default annual fee - no product or pricing found"
    );
  }

  // Return annualFee in cents (as stored in pricing table)
  // Note: Caller should convert to base currency (divide by 100) when passing to invoice function
  return { incomeCode, annualFee };
}

/**
 * Handles application approved event
 * Creates invoice for the newly approved member
 */
export async function handleApplicationApproved(payload) {
  try {
    const {
      applicationId,
      profileId,
      memberId: payloadMemberId,
      effective,
      subscriptionAttributes,
      tenantId,
    } = payload.data || payload; // Handle both wrapped and unwrapped payloads

    if (!applicationId || !profileId) {
      logger.warn(
        { applicationId, profileId },
        "Missing required fields for invoice creation"
      );
      return;
    }

    // Extract subscription details
    const subDetails = effective?.subscriptionDetails || {};
    const categoryName =
      subDetails.membershipCategory ||
      effective?.professionalDetails?.membershipCategory ||
      "General All Grades";

    // Use subscription startDate (from subscription service) if available,
    // otherwise fall back to dateJoined from subscriptionDetails
    // This is the date that should be used for pricing lookup
    // Normalize to ISO date string (YYYY-MM-DD) for consistency
    let subscriptionStartDate =
      subscriptionAttributes?.startDate || subDetails.dateJoined || new Date();

    // Ensure it's a Date object first, then convert to ISO string
    if (subscriptionStartDate instanceof Date) {
      subscriptionStartDate = subscriptionStartDate.toISOString().split("T")[0];
    } else if (typeof subscriptionStartDate === "string") {
      // If it's already a string, ensure it's in YYYY-MM-DD format
      subscriptionStartDate = subscriptionStartDate.split("T")[0];
    } else {
      subscriptionStartDate = new Date().toISOString().split("T")[0];
    }

    const dateJoined = subscriptionStartDate;

    // Get memberId from subscription service or use profileId temporarily
    // Note: memberId should be available after member is created
    const memberId =
      payloadMemberId ||
      subscriptionAttributes?.memberId ||
      `profile:${profileId}`;

    // IMPORTANT: Invoice creation and credit claiming should happen AFTER member is created
    // If memberId is not yet available (temporary profile: prefix), skip invoice creation here
    // The handleMemberCreated function will handle both invoice creation and credit claiming
    if (memberId && !memberId.startsWith("profile:")) {
      logger.info(
        {
          applicationId,
          memberId,
        },
        "MemberId is available - will create invoice and claim credit in member created event"
      );
      // Store the data for later use in handleMemberCreated
      // The invoice will be created when the member is actually created
    } else {
      logger.info(
        {
          applicationId,
          memberId,
        },
        "MemberId not yet available - invoice creation will be handled by member created event"
      );
    }
  } catch (error) {
    logger.error(
      { error: error.message, applicationId: payload?.data?.applicationId },
      "Error handling application approved event"
    );
    // Don't throw - allow event processing to continue
    // The invoice can be created manually if needed
  }
}

/**
 * Handles member created event
 * Creates invoice and claims application credit after member is created
 * Requires membership number (memberId) on the event: invoices are never posted against applicationId alone.
 */
export async function handleMemberCreated(payload) {
  try {
    const {
      applicationId,
      memberId,
      subscriptionId,
      tenantId,
      profileId,
      effective,
      subscriptionAttributes,
    } = payload.data || payload;

    if (!subscriptionId) {
      logger.warn(
        { applicationId, memberId, profileId },
        "Missing subscriptionId on subscription current updated — cannot key invoice idempotently"
      );
      return;
    }

    if (
      memberId == null ||
      (typeof memberId === "string" && memberId.trim() === "")
    ) {
      logger.warn(
        { applicationId, subscriptionId, profileId },
        "Billing deferred: memberId (membership number) required — invoice and claim run only after membership number is on the event"
      );
      return;
    }

    logger.info(
      { applicationId, memberId, profileId, subscriptionId },
      "Subscription current updated — creating invoice on memberId (claim when applicationId also present)"
    );

    // Extract subscription details for invoice creation
    const subDetails = effective?.subscriptionDetails || {};
    const categoryName =
      subDetails.membershipCategory ||
      effective?.professionalDetails?.membershipCategory ||
      "General All Grades";

    // Use subscription startDate (from subscription service) if available,
    // otherwise fall back to dateJoined from subscriptionDetails
    let subscriptionStartDate =
      subscriptionAttributes?.startDate || subDetails.dateJoined || new Date();

    // Ensure it's a Date object first, then convert to ISO string
    if (subscriptionStartDate instanceof Date) {
      subscriptionStartDate = subscriptionStartDate.toISOString().split("T")[0];
    } else if (typeof subscriptionStartDate === "string") {
      subscriptionStartDate = subscriptionStartDate.split("T")[0];
    } else {
      subscriptionStartDate = new Date().toISOString().split("T")[0];
    }

    const dateJoined = subscriptionStartDate;

    // Bulk: subscriptionAttributes.processingDate = batch processing day; invoice = max(join, processing).
    // Single: no processingDate → invoice = dateJoined (membership start).
    const processingDateOnly = toIsoDateOnly(
      subscriptionAttributes?.processingDate
    );
    const invoiceDate = processingDateOnly
      ? laterIsoDate(dateJoined, processingDateOnly)
      : dateJoined;
    const prorationStartDate = invoiceDate;

    // Get income code and annual fee (from pricing if available)
    // Wrap in global limiter to prevent connection pool exhaustion
    const { incomeCode, annualFee } = await globalDBLimiter(async () => {
      return await getMembershipPricing({
        categoryName,
        subscriptionDetails: subDetails,
        startDate: dateJoined,
        tenantId,
        profileId,
        applicationId,
      });
    });

    // Invoice doc number: year from GL invoice (billing) date
    const invYear = parseInt(invoiceDate.slice(0, 4), 10);
    const year = Number.isFinite(invYear) ? invYear : new Date().getFullYear();
    const docNo = applicationId
      ? `INV-${year}-${applicationId}`
      : `INV-${year}-SUB-${subscriptionId}`;

    // Idempotency check: Check if invoice already exists before creating
    // Wrap in global limiter to prevent connection pool exhaustion
    const existingInvoice = await globalDBLimiter(async () => {
      return await GLTransaction.findOne({
        docNo: docNo,
      }).lean();
    });

    if (existingInvoice) {
      logger.info(
        {
          applicationId,
          memberId,
          docNo,
          existingInvoiceId: existingInvoice._id,
        },
        "Invoice already exists - skipping creation (idempotency check)"
      );
    } else {
      logger.info(
        {
          applicationId,
          memberId,
          categoryName,
          annualFee,
          incomeCode,
          docNo,
          dateJoined,
          processingDate: processingDateOnly ?? null,
          invoiceDate,
          prorationStartDate,
        },
        "Creating invoice for newly created member"
      );

      // Step 1: Create invoice
      // annualFee is already in cents (minor units) - use directly
      // All money is stored as integer cents throughout the system

      const invoiceReq = {
        body: {
          date: invoiceDate,
          docNo,
          memberId,
          annualFee: annualFee, // Integer in cents
          incomeCode,
          categoryName,
          periodBucket: "current",
          joinDate: prorationStartDate,
        },
      };

      const invoiceRes = {
        created: (data) => {
          logger.info(
            {
              docNo,
              memberId,
              invoiceCount: Array.isArray(data) ? data.length : 1,
            },
            "Invoice created successfully for new member"
          );
        },
        status: () => invoiceRes,
        json: () => {},
      };

      const invoiceNext = (err) => {
        if (err) {
          // Check if error is due to duplicate docNo (idempotency)
          if (
            err.message?.includes("duplicate") ||
            err.message?.includes("E11000") ||
            err.code === 11000
          ) {
            logger.info(
              {
                applicationId,
                memberId,
                docNo,
                error: err.message,
              },
              "Invoice creation failed due to duplicate - likely already exists (idempotency)"
            );
            // Don't throw - treat as success (idempotent operation)
            return;
          }
          logger.error(
            { error: err.message, applicationId, memberId, docNo },
            "Failed to create invoice for new member"
          );
          throw err;
        }
      };

      try {
        // Invoice creation is already limited via postBalancedJournal wrapper
        // No need to wrap here - postBalancedJournal handles the limiting
        await invoice(invoiceReq, invoiceRes, invoiceNext);
      } catch (invoiceError) {
        // Check if error is due to duplicate docNo (idempotency)
        if (
          invoiceError.message?.includes("duplicate") ||
          invoiceError.message?.includes("E11000") ||
          invoiceError.code === 11000
        ) {
          logger.info(
            {
              applicationId,
              memberId,
              docNo,
              error: invoiceError.message,
            },
            "Invoice creation failed due to duplicate - likely already exists (idempotency)"
          );
          // Continue to claim credit even if duplicate error
        } else {
          logger.error(
            {
              error: invoiceError.message,
              applicationId,
              memberId,
              docNo,
            },
            "Failed to create invoice - will not claim credit"
          );
          // Don't proceed to claim credit if invoice creation failed (non-duplicate error)
          return;
        }
      }
    }

    // Step 2: Claim application credit — requires both IDs (transfers 2020 app credit → member 2020)
    if (!applicationId || !memberId) {
      logger.info(
        { applicationId, memberId },
        "Skipping credit claim until both applicationId and memberId are available"
      );
    } else {
      const claimDocNo = `CLAIM-${applicationId}`;

      const existingClaim = await globalDBLimiter(async () => {
        return await GLTransaction.findOne({
          docNo: claimDocNo,
        }).lean();
      });

      if (existingClaim) {
        logger.info(
          {
            applicationId,
            memberId,
            claimDocNo,
            existingClaimId: existingClaim._id,
          },
          "Credit already claimed - skipping (idempotency check)"
        );
      } else {
        logger.info(
          { applicationId, memberId },
          "Attempting to claim application credit for new member"
        );

        const claimReq = {
          body: {
            date: invoiceDate,
            docNo: claimDocNo,
            applicationId,
            memberId,
            bucket: "current",
          },
        };

        const claimRes = {
          created: (data) => {
            logger.info(
              {
                applicationId,
                memberId,
                docNo: claimReq.body.docNo,
              },
              "Application credit claimed successfully for new member"
            );
          },
          status: () => claimRes,
          json: () => {},
        };

        const claimNext = (err) => {
          if (err) {
            if (err.message?.includes("No credit entry found")) {
              logger.info(
                {
                  applicationId,
                  memberId,
                },
                "No application credit to claim - no payment received before approval"
              );
            } else if (
              err.message?.includes("duplicate") ||
              err.message?.includes("E11000") ||
              err.code === 11000
            ) {
              logger.info(
                {
                  applicationId,
                  memberId,
                  claimDocNo,
                  error: err.message,
                },
                "Credit claim failed due to duplicate - likely already exists (idempotency)"
              );
            } else {
              logger.warn(
                {
                  applicationId,
                  memberId,
                  error: err.message,
                },
                "Failed to claim application credit"
              );
            }
          }
        };

        try {
          await claimApplicationCredit(claimReq, claimRes, claimNext);
        } catch (claimError) {
          if (
            claimError.message?.includes("No credit entry found") ||
            claimError.statusCode === 404
          ) {
            logger.info(
              {
                applicationId,
                memberId,
              },
              "No application credit to claim - no payment received before approval"
            );
          } else if (
            claimError.message?.includes("duplicate") ||
            claimError.message?.includes("E11000") ||
            claimError.code === 11000
          ) {
            logger.info(
              {
                applicationId,
                memberId,
                claimDocNo,
                error: claimError.message,
              },
              "Credit claim failed due to duplicate - likely already exists (idempotency)"
            );
          } else {
            logger.warn(
              {
                applicationId,
                memberId,
                error: claimError.message,
              },
              "Failed to claim application credit"
            );
          }
        }
      }
    }
  } catch (error) {
    logger.error(
      {
        error: error.message,
        memberId: payload?.data?.memberId,
        applicationId: payload?.data?.applicationId,
      },
      "Error handling member created event"
    );
    // Don't throw - allow event processing to continue
  }
}
