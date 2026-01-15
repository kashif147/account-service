// Example listener for application approval events
// This creates invoices automatically when applications are approved

import logger from "../config/logger.js";
import { invoice } from "../controllers/journal.controller.js";
import { claimApplicationCredit } from "../controllers/journal.controller.js";
import CoA from "../models/coa.model.js";

/**
 * Maps membership category to income account code
 * Update this mapping based on your Chart of Accounts
 */
async function getIncomeCodeForCategory(categoryName) {
  // Default mapping - customize based on your CoA
  const categoryToIncomeCode = {
    "General All Grades": "4000",
    "Short-term / Relief": "4010",
    "Private nursing home": "4040",
    "Affiliate members": "4050",
    "Lecturing": "4060",
    "Associate": "4070",
    "Retired Associate": "4080",
    "Students": "4090",
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
 * This should integrate with your subscription/fee service
 */
async function getAnnualFeeForCategory(categoryName, subscriptionDetails) {
  // If fee is in subscription details, use it
  if (subscriptionDetails?.annualFee) {
    return subscriptionDetails.annualFee;
  }

  // Otherwise, lookup from fee service or use defaults
  const defaultFees = {
    "General All Grades": 500.00,
    "Associate": 300.00,
    "Student": 150.00,
  };

  return defaultFees[categoryName] || 500.00;
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

    const dateJoined = subDetails.dateJoined
      ? new Date(subDetails.dateJoined).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    // Get memberId from subscription service or use profileId temporarily
    // Note: memberId should be available after member is created
    const memberId =
      payloadMemberId || subscriptionAttributes?.memberId || `profile:${profileId}`;

    // Get income code and annual fee
    const incomeCode = await getIncomeCodeForCategory(categoryName);
    const annualFee = await getAnnualFeeForCategory(categoryName, subDetails);

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
