// Example listener for application approval events
// This creates invoices automatically when applications are approved

import logger from "../config/logger.js";
import { invoice } from "../controllers/journal.controller.js";
import { claimApplicationCredit } from "../controllers/journal.controller.js";
import CoA from "../models/coa.model.js";
import Product from "../models/product.model.js";
import Pricing from "../models/pricing.model.js";

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
async function getMembershipPricing({
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
 * This ensures memberId is available before creating accounting entries
 */
export async function handleMemberCreated(payload) {
  try {
    const {
      applicationId,
      memberId,
      tenantId,
      profileId,
      effective,
      subscriptionAttributes,
    } = payload.data || payload;

    if (!applicationId || !memberId) {
      logger.warn(
        { applicationId, memberId },
        "Missing required fields (applicationId or memberId) for invoice creation and credit claim"
      );
      return;
    }

    logger.info(
      { applicationId, memberId, profileId },
      "Member created - creating invoice and claiming application credit"
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

    // Get income code and annual fee (from pricing if available)
    const { incomeCode, annualFee } = await getMembershipPricing({
      categoryName,
      subscriptionDetails: subDetails,
      startDate: dateJoined,
      tenantId,
      profileId,
      applicationId,
    });

    // Generate invoice document number
    const year = new Date().getFullYear();
    const docNo = `INV-${year}-${applicationId}`;
    const invoiceDate = new Date().toISOString().split("T")[0];

    logger.info(
      {
        applicationId,
        memberId,
        categoryName,
        annualFee,
        incomeCode,
        docNo,
      },
      "Creating invoice for newly created member"
    );

    // Step 1: Create invoice
    // Note: annualFee from pricing is in cents, but invoice function expects base currency
    // Convert from cents to base currency (divide by 100)
    // If pricing is already in base currency, remove this conversion
    const annualFeeInBaseCurrency = annualFee / 100;

    const invoiceReq = {
      body: {
        date: invoiceDate,
        docNo,
        memberId,
        annualFee: annualFeeInBaseCurrency,
        incomeCode,
        categoryName,
        periodBucket: "current",
        joinDate: dateJoined !== invoiceDate ? dateJoined : undefined,
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
        logger.error(
          { error: err.message, applicationId, memberId, docNo },
          "Failed to create invoice for new member"
        );
        throw err;
      }
    };

    try {
      await invoice(invoiceReq, invoiceRes, invoiceNext);
    } catch (invoiceError) {
      logger.error(
        {
          error: invoiceError.message,
          applicationId,
          memberId,
          docNo,
        },
        "Failed to create invoice - will not claim credit"
      );
      // Don't proceed to claim credit if invoice creation failed
      return;
    }

    // Step 2: Claim application credit (if payment was received before approval)
    logger.info(
      { applicationId, memberId },
      "Attempting to claim application credit for new member"
    );

    const claimReq = {
      body: {
        date: invoiceDate,
        docNo: `CLAIM-${applicationId}`,
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
        // If no credit found, that's okay - just means no payment was received before approval
        if (err.message?.includes("No credit entry found")) {
          logger.info(
            {
              applicationId,
              memberId,
            },
            "No application credit to claim - no payment received before approval"
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
      // If no credit entry found, that's fine - just means no payment was received
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
