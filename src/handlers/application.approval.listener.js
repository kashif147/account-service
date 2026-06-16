// Example listener for application approval events
// This creates invoices automatically when applications are approved

import logger from "../config/logger.js";
import {
  invoice,
  claimApplicationCredit,
  relinkRefundGlFromApplicationToMember,
  relinkPostedRefundGlFromRefundDocuments,
} from "../controllers/journal.controller.js";
import CoA from "../models/coa.model.js";
import Product from "../models/product.model.js";
import Pricing from "../models/pricing.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
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
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        12,
        0,
        0,
        0
      )
    );
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const dmyMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0)
    );
  }
  const datePart = raw.split("T")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const [year, month, day] = datePart.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      12,
      0,
      0,
      0
    )
  );
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

/** Calendar days from anchor (UTC date-only) to reference (inclusive span); null if invalid. */
function utcCalendarDaysFromAnchorToReference(anchorDate, referenceDate) {
  if (
    !anchorDate ||
    !referenceDate ||
    Number.isNaN(anchorDate.getTime()) ||
    Number.isNaN(referenceDate.getTime())
  ) {
    return null;
  }
  const msPerDay = 86400000;
  return Math.floor(
    (referenceDate.getTime() - anchorDate.getTime()) / msPerDay
  );
}

function utcTodayDateOnly() {
  const n = new Date();
  return new Date(
    Date.UTC(
      n.getUTCFullYear(),
      n.getUTCMonth(),
      n.getUTCDate(),
      12,
      0,
      0,
      0
    )
  );
}

/**
 * Retrospective pricing when either:
 * - Any anchor (membership start / dateJoined, submissionDate, applicationDate) is strictly more than
 *   RETROSPECTIVE_PRICING_LAG_DAYS before today UTC (when this handler runs), or
 * - Any anchor falls in a calendar year before the reference year (e.g. joined late December, approved January —
 *   allows inactive catalogue rows for the membership-start year such as 2025 fees).
 * When true, fee lookup omits pricing isActive so inactive bands matching the subscription start may apply.
 */
const RETROSPECTIVE_PRICING_LAG_DAYS = 90;

function collectRetrospectiveAnchorDates(subscriptionDetails, membershipStartIso) {
  const anchors = [];
  const push = (value) => {
    const p = parseDate(value);
    if (p && !Number.isNaN(p.getTime())) anchors.push(p);
  };
  push(membershipStartIso);
  if (subscriptionDetails && typeof subscriptionDetails === "object") {
    push(subscriptionDetails.dateJoined);
    push(subscriptionDetails.submissionDate);
    push(subscriptionDetails.applicationDate);
  }
  const seen = new Set();
  const unique = [];
  for (const d of anchors) {
    const key = d.toISOString().split("T")[0];
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }
  return unique;
}

function isRetrospectivePricingCase({
  subscriptionDetails,
  membershipStartIso,
  referenceIsoDate,
}) {
  const refParsed = parseDate(referenceIsoDate) || utcTodayDateOnly();
  if (!refParsed || Number.isNaN(refParsed.getTime())) return false;
  const anchors = collectRetrospectiveAnchorDates(
    subscriptionDetails,
    membershipStartIso
  );
  const refYear = refParsed.getUTCFullYear();
  for (const anchor of anchors) {
    if (anchor.getUTCFullYear() < refYear) return true;
  }
  for (const anchor of anchors) {
    const days = utcCalendarDaysFromAnchorToReference(anchor, refParsed);
    if (days != null && days > RETROSPECTIVE_PRICING_LAG_DAYS) return true;
  }
  return false;
}

/**
 * Backfill refunds created against application credit so they follow the processed member.
 * This mirrors CLAIM transfer semantics for downstream reporting.
 */
async function associateRefundsWithMember({
  tenantId,
  applicationId,
  memberId,
}) {
  if (!tenantId || !applicationId || !memberId) return;

  // 1) Refund docs directly keyed by applicationId.
  const directResult = await globalDBLimiter(async () => {
    return Refund.updateMany(
      {
        tenantId,
        applicationId,
        $or: [{ memberId: { $exists: false } }, { memberId: null }, { memberId: "" }],
      },
      { $set: { memberId } }
    );
  });

  // 2) Refund docs linked to payments that were keyed by applicationId.
  const paymentIds = await globalDBLimiter(async () => {
    const payments = await Payment.find({ tenantId, applicationId })
      .select("_id")
      .lean();
    return payments.map((p) => p._id);
  });

  let linkedResult = { modifiedCount: 0 };
  if (paymentIds.length) {
    linkedResult = await globalDBLimiter(async () => {
      return Refund.updateMany(
        {
          tenantId,
          paymentId: { $in: paymentIds },
          $or: [{ memberId: { $exists: false } }, { memberId: null }, { memberId: "" }],
        },
        { $set: { memberId } }
      );
    });
  }

  const updatedCount =
    (directResult?.modifiedCount || 0) + (linkedResult?.modifiedCount || 0);

  if (updatedCount > 0) {
    logger.info(
      { tenantId, applicationId, memberId, updatedRefunds: updatedCount },
      "Associated historical refunds to processed member"
    );
  }
}

/** Collapse spaces and slash spacing so "Short-term / Relief" matches "Short-term/Relief (…)". */
function normalizeCategoryLabel(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .trim();
}

/**
 * Resolve CoA income code from CRM/subscription category string.
 * Exact match first; then prefix match on normalized labels (longer keys first).
 */
function resolveIncomeCodeKey(categoryName, categoryToIncomeCode) {
  if (categoryName != null && categoryToIncomeCode[categoryName]) {
    return categoryToIncomeCode[categoryName];
  }
  const fullNorm = normalizeCategoryLabel(categoryName);
  const pairs = Object.entries(categoryToIncomeCode).sort(
    (a, b) => normalizeCategoryLabel(b[0]).length - normalizeCategoryLabel(a[0]).length,
  );
  for (const [label, code] of pairs) {
    const kn = normalizeCategoryLabel(label);
    if (!kn) continue;
    if (fullNorm === kn) return code;
    if (fullNorm.startsWith(kn)) {
      const next = fullNorm[kn.length];
      if (next === undefined || next === " " || next === "(") return code;
    }
  }
  return null;
}

async function getIncomeCodeForCategory(categoryName) {
  // Default mapping - customize based on your CoA (keys are canonical; variants match via normalize + prefix)
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

  const code = resolveIncomeCodeKey(categoryName, categoryToIncomeCode);
  if (code) {
    const coa = await CoA.findOne({ code }).lean();
    if (coa) return code;
  }

  logger.warn(
    { categoryName, resolvedCode: code },
    "Using default income code 4000 for category (no map match or CoA row missing)"
  );
  return "4000";
}

/**
 * Gets annual fee for membership category
 * Matches products by code OR name against membershipCategory
 * Looks up pricing by effective dates. If retrospective (prior calendar year on any anchor, or >90 day lag),
 * inactive catalogue rows may match (isActive filter omitted); otherwise only active rows match.
 */
export async function getMembershipPricing({
  categoryName,
  subscriptionDetails,
  startDate,
  tenantId,
  profileId,
  applicationId,
  referenceIsoDate,
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
          const pricingDateStartUtc = new Date(subscriptionStartDate);
          pricingDateStartUtc.setUTCHours(0, 0, 0, 0);
          const pricingDateEndUtc = new Date(subscriptionStartDate);
          pricingDateEndUtc.setUTCHours(23, 59, 59, 999);

          const membershipStartIso = subscriptionStartDate
            .toISOString()
            .split("T")[0];
          const retrospective = isRetrospectivePricingCase({
            subscriptionDetails,
            membershipStartIso,
            referenceIsoDate:
              referenceIsoDate ||
              new Date().toISOString().split("T")[0],
          });

          const pricingQuery = {
            tenantId,
            productId: product._id,
            isDeleted: false,
            effectiveFrom: { $lte: pricingDateEndUtc },
            $or: [
              { effectiveTo: { $gte: pricingDateStartUtc } },
              { effectiveTo: null },
            ],
          };
          if (!retrospective) {
            pricingQuery.isActive = true;
          }

          const pricing = await Pricing.findOne(pricingQuery)
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
                  retrospectiveMembershipPricing: retrospective,
                  pricingIsActive: pricing.isActive,
                  pricingEffectiveFrom: pricing.effectiveFrom
                    ? new Date(pricing.effectiveFrom).toISOString()
                    : null,
                  pricingEffectiveTo: pricing.effectiveTo
                    ? new Date(pricing.effectiveTo).toISOString()
                    : null,
                  profileId,
                  applicationId,
                },
                retrospective
                  ? "Found pricing for delayed approval window (isActive not required)"
                  : "Found pricing for product matching subscription start date"
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
            const listQuery = {
              tenantId,
              productId: product._id,
              isDeleted: false,
            };
            if (!retrospective) {
              listQuery.isActive = true;
            }
            const allPricings = await Pricing.find(listQuery)
              .sort({ effectiveFrom: -1 })
              .lean();

            logger.warn(
              {
                productId: product._id,
                subscriptionStartDate: subscriptionStartDate.toISOString(),
                retrospectiveMembershipPricing: retrospective,
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
              retrospective
                ? "No pricing found for product in delayed-approval / retrospective window"
                : "No active pricing found for product matching subscription start date range"
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
 * Handles application processed event
 * Creates invoice for the newly processed member
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
      "Error handling application processed event"
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

    const processingDateOnly = toIsoDateOnly(
      subscriptionAttributes?.processingDate
    );

    // GL invoice posting date = when this handler generates the journal (UTC calendar date).
    // Membership fee and pro-rata always use dateJoined via joinDate on the invoice API.
    const invoicePostingDate = new Date().toISOString().split("T")[0];
    const retrospectiveReferenceIso = invoicePostingDate;

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
        referenceIsoDate: retrospectiveReferenceIso,
      });
    });

    // Invoice doc number: year from posting (generation) date
    const invYear = parseInt(invoicePostingDate.slice(0, 4), 10);
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
          invoicePostingDate,
        },
        "Creating invoice for newly created member"
      );

      // Step 1: Create invoice
      // annualFee is already in cents (minor units) - use directly
      // All money is stored as integer cents throughout the system

      const invoiceReq = {
        body: {
          date: invoicePostingDate,
          docNo,
          memberId,
          annualFee: annualFee, // Integer in cents
          incomeCode,
          categoryName,
          periodBucket: "current",
          joinDate: dateJoined,
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
          tenantId,
          ctx: tenantId ? { tenantId } : {},
          body: {
            date: invoicePostingDate,
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

      // Keep historical refunds aligned with member after application approval claim.
      await associateRefundsWithMember({ tenantId, applicationId, memberId });
      try {
        const byApp = await relinkRefundGlFromApplicationToMember({
          applicationId,
          memberId,
        });
        const byDoc = await relinkPostedRefundGlFromRefundDocuments({
          tenantId,
          applicationId,
          memberId,
        });
        const n = (byApp.updated || 0) + (byDoc.updated || 0);
        if (n > 0) {
          logger.info(
            {
              tenantId,
              applicationId,
              memberId,
              refundGlRelinkedByApplication: byApp.updated,
              refundGlRelinkedFromRefundDocs: byDoc.updated,
            },
            "Relinked refund GL journals and materialized balances to member",
          );
        }
      } catch (err) {
        logger.warn(
          {
            tenantId,
            applicationId,
            memberId,
            error: err.message,
          },
          "Failed to relink refund GL / materialized balances to member",
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
