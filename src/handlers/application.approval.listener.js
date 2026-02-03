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
 * This should integrate with your subscription/fee service
 */
async function getMembershipPricing({
  categoryName,
  subscriptionDetails,
  startDate,
  tenantId,
  profileId,
  applicationId,
}) {
  let annualFee = subscriptionDetails?.annualFee ?? null;
  let incomeCode = null;
  let product = null;

  if (!tenantId) {
    logger.warn(
      { categoryName, profileId, applicationId },
      "Missing tenantId for product lookup"
    );
  } else {
    // Try to match product by code first (exact match, case-insensitive)
    // Then try by name (case-insensitive)
    const categoryUpper = categoryName?.toUpperCase().trim();
    const categoryRegex = new RegExp(`^${escapeRegex(categoryName)}$`, "i");

    product = await Product.findOne({
      tenantId,
      isDeleted: false,
      isActive: true,
      $or: [{ code: categoryUpper }, { name: categoryRegex }],
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

      if (product.code) {
        incomeCode = product.code;
      }

      // Get pricing for the matched product
      // Pricing must be active and subscription startDate must be between effectiveFrom and effectiveTo
      if (annualFee == null && product._id) {
        // Use subscription startDate (dateJoined) for pricing lookup
        // Ensure it's a proper Date object for comparison
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
            annualFee =
              pricing.price ??
              pricing.memberPrice ??
              pricing.nonMemberPrice ??
              null;
            logger.info(
              {
                productId: product._id,
                pricingId: pricing._id,
                annualFee,
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

  if (incomeCode == null) {
    incomeCode = await getIncomeCodeForCategory(categoryName);
  }

  if (annualFee == null) {
    // fallback defaults if no pricing found
    const defaultFees = {
      "General All Grades": 500.0,
      Associate: 300.0,
      Student: 0.0,
    };
    annualFee = defaultFees[categoryName] || 500.0;
    logger.warn(
      {
        categoryName,
        annualFee,
        profileId,
        applicationId,
      },
      "Using default annual fee - no product or pricing found"
    );
  }

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

    // Get income code and annual fee (from pricing if available)
    // Match products by code OR name against membershipCategory
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

    // Create invoice
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
      "Creating invoice for approved application"
    );

    // Call invoice controller
    const req = {
      body: {
        date: invoiceDate,
        docNo,
        memberId,
        annualFee,
        incomeCode,
        categoryName,
        periodBucket: "current",
        joinDate: dateJoined !== invoiceDate ? dateJoined : undefined,
      },
    };

    const res = {
      created: (data) => {
        logger.info(
          { docNo, invoiceCount: Array.isArray(data) ? data.length : 1 },
          "Invoice created successfully"
        );
      },
      status: () => res,
      json: () => {},
    };

    const next = (err) => {
      if (err) {
        logger.error(
          { error: err.message, applicationId, docNo },
          "Failed to create invoice"
        );
        throw err;
      }
    };

    await invoice(req, res, next);

    // If payment was received before approval, claim the credit
    if (memberId && applicationId) {
      const claimReq = {
        body: {
          date: invoiceDate,
          docNo: `CLAIM-${applicationId}`,
          applicationId,
          memberId,
          bucket: "current",
        },
      };
      try {
        await claimApplicationCredit(claimReq, res, next);
      } catch (claimError) {
        logger.warn(
          { applicationId, memberId, error: claimError.message },
          "Claim credit skipped or failed"
        );
      }
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
 * Claims application credit if payment was received before approval
 */
export async function handleMemberCreated(payload) {
  try {
    const { applicationId, memberId, tenantId } = payload.data || payload;

    if (!applicationId || !memberId) {
      logger.warn(
        { applicationId, memberId },
        "Missing required fields for credit claim"
      );
      return;
    }

    logger.info(
      { applicationId, memberId },
      "Claiming application credit for new member"
    );

    const req = {
      body: {
        date: new Date().toISOString().split("T")[0],
        docNo: `CLAIM-${applicationId}`,
        applicationId,
        memberId,
        bucket: "current",
      },
    };

    const res = {
      created: (data) => {
        logger.info({ docNo: req.body.docNo }, "Credit claimed successfully");
      },
      status: () => res,
      json: () => {},
    };

    const next = (err) => {
      if (err) {
        logger.error(
          { error: err.message, applicationId, memberId },
          "Failed to claim application credit"
        );
      }
    };

    await claimApplicationCredit(req, res, next);
  } catch (error) {
    logger.error(
      { error: error.message, memberId: payload?.data?.memberId },
      "Error handling member created event"
    );
  }
}
