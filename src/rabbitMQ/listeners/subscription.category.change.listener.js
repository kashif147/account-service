import logger from "../../config/logger.js";
import { getMembershipPricing } from "../../handlers/application.approval.listener.js";
import { postCategoryChangeJournals } from "../../controllers/journal.controller.js";
import { globalDBLimiter } from "../../config/globalLimiter.js";

function toYmd(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

/**
 * membership.events → members.subscription.category.changed.v1
 * Uses pricing for old/new category at respective start dates, then posts the same
 * prorated journals as POST /api/journal/change-category (changeDate = new subscription start).
 */
export async function handleSubscriptionCategoryChanged(payload) {
  const data = payload.data || payload;
  const {
    subscriptionId,
    profileId,
    tenantId,
    applicationId,
    memberId,
    adjustmentKey,
    previousMembershipCategory,
    membershipCategory,
    previousStartDate,
    subscriptionStartDate,
  } = data;

  if (!subscriptionId) {
    logger.warn("category.changed: missing subscriptionId");
    return;
  }
  if (!adjustmentKey) {
    logger.warn({ subscriptionId }, "category.changed: missing adjustmentKey");
    return;
  }
  if (
    memberId == null ||
    (typeof memberId === "string" && memberId.trim() === "")
  ) {
    logger.warn(
      { subscriptionId },
      "category.changed: no memberId — skip GL (assign membership number and re-trigger if needed)"
    );
    return;
  }

  const prevCat =
    previousMembershipCategory != null &&
    String(previousMembershipCategory).trim()
      ? String(previousMembershipCategory).trim()
      : "General All Grades";
  const newCat =
    membershipCategory != null && String(membershipCategory).trim()
      ? String(membershipCategory).trim()
      : "General All Grades";

  const prevStart = toYmd(previousStartDate);
  const newStart = toYmd(subscriptionStartDate);
  if (!prevStart || !newStart) {
    logger.warn(
      { subscriptionId, previousStartDate, subscriptionStartDate },
      "category.changed: invalid start dates"
    );
    return;
  }

  const docNoBase = `CAT-${subscriptionId}-${adjustmentKey}`;

  const journalDate = new Date().toISOString().split("T")[0];

  const { incomeCode: oldIncomeCode, annualFee: oldAnnualFee } =
    await globalDBLimiter(async () =>
      getMembershipPricing({
        categoryName: prevCat,
        subscriptionDetails: {},
        startDate: prevStart,
        tenantId,
        profileId,
        applicationId,
        referenceIsoDate: journalDate,
      })
    );

  const { incomeCode: newIncomeCode, annualFee: newAnnualFee } =
    await globalDBLimiter(async () =>
      getMembershipPricing({
        categoryName: newCat,
        subscriptionDetails: {},
        startDate: newStart,
        tenantId,
        profileId,
        applicationId,
        referenceIsoDate: journalDate,
      })
    );

  await postCategoryChangeJournals({
    date: journalDate,
    docNoBase,
    memberId,
    oldIncomeCode,
    oldCategoryName: prevCat,
    oldAnnualFee,
    newIncomeCode,
    newCategoryName: newCat,
    newAnnualFee,
    changeDate: newStart,
    previousSubscriptionStartDate: prevStart,
    periodBucket: "current",
  });

  logger.info(
    { subscriptionId, docNoBase, memberId, prevCat, newCat },
    "category.changed: GL journals posted"
  );
}
