import { AppError } from "../errors/AppError.js";
import { yearBoundsFrom, prorataForPeriod } from "./prorata.js";

/**
 * Builds balanced GL lines + memo for a mid-year membership category change (CATNET).
 * Pure function — no DB. Used by postCategoryChangeJournals and unit tests.
 *
 * @returns {{
 *   lines: object[],
 *   memo: string,
 *   year: number,
 *   incrementalCents: number,
 *   amountNewTier: number,
 *   amountOldUnused: number,
 * }}
 */
export function buildCategoryChangeJournalPayload({
  memberId,
  oldIncomeCode,
  oldCategoryName,
  oldAnnualFee,
  newIncomeCode,
  newCategoryName,
  newAnnualFee,
  changeDate,
  previousSubscriptionStartDate,
  periodBucket = "current",
}) {
  if (!Number.isInteger(oldAnnualFee) || oldAnnualFee < 0) {
    throw AppError.badRequest(
      "oldAnnualFee must be a non-negative integer (minor units)",
    );
  }
  if (!Number.isInteger(newAnnualFee) || newAnnualFee < 0) {
    throw AppError.badRequest(
      "newAnnualFee must be a non-negative integer (minor units)",
    );
  }

  const { endISO, year } = yearBoundsFrom(changeDate);

  const prevStartYmd = String(previousSubscriptionStartDate ?? "")
    .trim()
    .split("T")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prevStartYmd)) {
    throw AppError.badRequest(
      "previousSubscriptionStartDate is required (YYYY-MM-DD): same as subscription startDate before category change",
    );
  }

  const amountOldUnused =
    oldAnnualFee > 0
      ? prorataForPeriod(oldAnnualFee, changeDate, endISO)
      : 0;
  const amountNewTier =
    newAnnualFee > 0
      ? prorataForPeriod(newAnnualFee, changeDate, endISO)
      : 0;

  if (amountOldUnused === 0 && amountNewTier === 0) {
    throw AppError.badRequest(
      "Category change would produce zero amounts — check annual fees and changeDate",
    );
  }

  const incrementalCents = amountNewTier - amountOldUnused;
  const isUpgrade = newAnnualFee > oldAnnualFee;
  const isDowngrade = newAnnualFee < oldAnnualFee;

  const lines = [];

  if (amountNewTier > 0) {
    lines.push({
      accountCode: "1400",
      dc: "D",
      amount: amountNewTier,
      memberId,
      periodBucket,
    });
  }
  if (amountOldUnused > 0) {
    lines.push({
      accountCode: "1400",
      dc: "C",
      amount: amountOldUnused,
      memberId,
      periodBucket,
    });
  }

  if (amountNewTier > 0) {
    if (isUpgrade && incrementalCents > 0) {
      lines.push({
        accountCode: newIncomeCode,
        dc: "C",
        amount: incrementalCents,
        revenueSubType: "Fee Increase",
        categoryName: newCategoryName,
      });
      const remainder = amountNewTier - incrementalCents;
      if (remainder > 0) {
        lines.push({
          accountCode: newIncomeCode,
          dc: "C",
          amount: remainder,
          revenueSubType: "fee",
          categoryName: newCategoryName,
        });
      }
    } else {
      lines.push({
        accountCode: newIncomeCode,
        dc: "C",
        amount: amountNewTier,
        revenueSubType: "fee",
        categoryName: newCategoryName,
      });
    }
  }

  if (amountOldUnused > 0) {
    lines.push({
      accountCode: oldIncomeCode,
      dc: "D",
      amount: amountOldUnused,
      revenueSubType:
        isDowngrade && incrementalCents < 0 ? "Fee Decrease" : "fee",
      categoryName: oldCategoryName,
      adjSubType: "category-change-old-tier-release",
    });
  }

  const memo =
    `Category change ${year}: ${oldCategoryName} (unused tail ${changeDate}→${endISO} ${amountOldUnused}c) → ` +
    `${newCategoryName} (${changeDate}→${endISO} ${amountNewTier}c); net AR ${incrementalCents}c; old tier from ${prevStartYmd}`;

  return {
    lines,
    memo,
    year,
    incrementalCents,
    amountNewTier,
    amountOldUnused,
  };
}
