import { AppError } from "../errors/AppError.js";
import { yearBoundsFrom, prorataForPeriod } from "./prorata.js";

/**
 * Builds balanced GL lines + memo for a mid-year membership category change (CATNET).
 * Category adjustments post to 4900; standard subscription invoices use 4xxx separately.
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
  void oldIncomeCode;
  void newIncomeCode;

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
        accountCode: "4900",
        dc: "C",
        amount: incrementalCents,
        adjSubType: "fee-increase-adjustment",
        categoryName: newCategoryName,
        revenueSubType: "Fee Increase",
      });
      const remainder = amountNewTier - incrementalCents;
      if (remainder > 0) {
        lines.push({
          accountCode: "4900",
          dc: "C",
          amount: remainder,
          adjSubType: "category-change-prorata-credit",
          categoryName: newCategoryName,
        });
      }
    } else {
      lines.push({
        accountCode: "4900",
        dc: "C",
        amount: amountNewTier,
        adjSubType: "category-change-prorata-credit",
        categoryName: newCategoryName,
      });
    }
  }

  if (amountOldUnused > 0) {
    lines.push({
      accountCode: "4900",
      dc: "D",
      amount: amountOldUnused,
      adjSubType: isDowngrade && incrementalCents < 0
        ? "fee-decrease-adjustment"
        : "category-downgrade-unused-credit",
      categoryName: oldCategoryName,
      revenueSubType:
        isDowngrade && incrementalCents < 0 ? "Fee Decrease" : undefined,
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
