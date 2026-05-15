import { describe, expect, test } from "@jest/globals";
import {
  prorataForPeriod,
  prorataFromJoinToYearEnd,
  diffDaysInclusive,
  yearBoundsFrom,
  daysInYear,
} from "../helpers/prorata.js";
import { buildCategoryChangeJournalPayload } from "../helpers/categoryChangeJournal.js";

const MEMBER = "M-SCENARIO";
const OLD_INC = "4100";
const NEW_INC = "4200";

function sumDc(lines) {
  let d = 0;
  let c = 0;
  for (const l of lines) {
    if (l.dc === "D") d += l.amount;
    else c += l.amount;
  }
  return { debit: d, credit: c };
}

function netAr1400(lines, memberId = MEMBER) {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    if (l.accountCode !== "1400" || l.memberId !== memberId) continue;
    if (l.dc === "D") debit += l.amount;
    else credit += l.amount;
  }
  return debit - credit;
}

function revenueSubTypes(lines) {
  return lines
    .filter((l) => l.revenueSubType)
    .map((l) => ({
      st: l.revenueSubType,
      dc: l.dc,
      amount: l.amount,
      cat: l.categoryName,
    }));
}

/** Inputs matching postCategoryChangeJournals / Rabbit snapshot */
function catNetPayload({
  changeDate,
  previousSubscriptionStartDate,
  oldAnnualFee,
  newAnnualFee,
  oldCat = "Old Cat",
  newCat = "New Cat",
}) {
  return buildCategoryChangeJournalPayload({
    memberId: MEMBER,
    oldIncomeCode: OLD_INC,
    oldCategoryName: oldCat,
    oldAnnualFee,
    newIncomeCode: NEW_INC,
    newCategoryName: newCat,
    newAnnualFee,
    changeDate,
    previousSubscriptionStartDate,
    periodBucket: "current",
  });
}

describe("Scenario 1 — Jan 1 join / renewal: full annual, no join prorata; same-fee change has no net AR", () => {
  test("example: join 2025-01-01 on $365.00 annual → prorata Jan→year-end equals full 36500¢", () => {
    const annual = 365_00;
    const join = "2025-01-01";
    const { endISO } = yearBoundsFrom(join);
    const days = diffDaysInclusive(join, endISO);
    expect(days).toBe(daysInYear(2025));
    expect(prorataFromJoinToYearEnd(annual, join)).toBe(annual);
    expect(prorataForPeriod(annual, join, endISO)).toBe(annual);
  });

  test("example: leap-year join 2024-01-01 → full annual maps to 366/366 days", () => {
    const annual = 366_00;
    const join = "2024-01-01";
    expect(daysInYear(2024)).toBe(366);
    expect(prorataFromJoinToYearEnd(annual, join)).toBe(annual);
  });

  test("same annual fee category rename: CATNET nets AR to 0; no Fee Increase / Fee Decrease", () => {
    const annual = 365_00;
    const p = catNetPayload({
      changeDate: "2025-07-01",
      previousSubscriptionStartDate: "2025-01-01",
      oldAnnualFee: annual,
      newAnnualFee: annual,
      oldCat: "Full Time",
      newCat: "Full Time (display)",
    });
    const { debit, credit } = sumDc(p.lines);
    expect(debit).toBe(credit);
    expect(netAr1400(p.lines)).toBe(0);
    expect(p.incrementalCents).toBe(0);
    const adj4900 = p.lines.filter((l) => l.accountCode === "4900");
    expect(adj4900.length).toBeGreaterThan(0);
    const subs = revenueSubTypes(p.lines).map((x) => x.st);
    expect(subs).not.toContain("Fee Increase");
    expect(subs).not.toContain("Fee Decrease");
  });
});

describe("Scenario 2 — Jan 1 full fee, later downgrade to part-time → Fee Decrease on old-tier release", () => {
  test("example: $365 full → $182.50 part, change 2025-07-01", () => {
    const fullAnnual = 365_00;
    const partAnnual = 182_50;
    const changeDate = "2025-07-01";
    const { endISO } = yearBoundsFrom(changeDate);
    const tailDays = diffDaysInclusive(changeDate, endISO);
    expect(tailDays).toBe(184);

    const p = catNetPayload({
      changeDate,
      previousSubscriptionStartDate: "2025-01-01",
      oldAnnualFee: fullAnnual,
      newAnnualFee: partAnnual,
      oldCat: "Full Time",
      newCat: "Part Time",
    });

    expect(p.amountOldUnused).toBe(
      prorataForPeriod(fullAnnual, changeDate, endISO),
    );
    expect(p.amountNewTier).toBe(
      prorataForPeriod(partAnnual, changeDate, endISO),
    );
    expect(p.incrementalCents).toBeLessThan(0);

    const { debit, credit } = sumDc(p.lines);
    expect(debit).toBe(credit);
    expect(netAr1400(p.lines)).toBe(p.incrementalCents);

    const oldDebit = p.lines.find(
      (l) =>
        l.accountCode === "4900" &&
        l.dc === "D" &&
        l.adjSubType === "fee-decrease-adjustment",
    );
    expect(oldDebit).toBeDefined();
    expect(oldDebit.revenueSubType).toBe("Fee Decrease");

    const subs = revenueSubTypes(p.lines);
    expect(subs.some((x) => x.st === "Fee Increase")).toBe(false);
    expect(p.lines.filter((l) => l.accountCode === "4900" && l.dc === "C").length).toBeGreaterThan(0);
  });
});

describe("Scenario 3 — Jan 1 part-time, later upgrade to full-time → Fee Increase on incremental", () => {
  test("example: $182.50 part → $365 full, change 2025-07-01", () => {
    const fullAnnual = 365_00;
    const partAnnual = 182_50;
    const changeDate = "2025-07-01";
    const { endISO } = yearBoundsFrom(changeDate);

    const p = catNetPayload({
      changeDate,
      previousSubscriptionStartDate: "2025-01-01",
      oldAnnualFee: partAnnual,
      newAnnualFee: fullAnnual,
      oldCat: "Part Time",
      newCat: "Full Time",
    });

    expect(p.incrementalCents).toBeGreaterThan(0);
    expect(netAr1400(p.lines)).toBe(p.incrementalCents);

    const feeInc = p.lines.find(
      (l) =>
        l.accountCode === "4900" &&
        l.dc === "C" &&
        l.revenueSubType === "Fee Increase",
    );
    expect(feeInc).toBeDefined();
    expect(feeInc.amount).toBe(p.incrementalCents);
    expect(feeInc.adjSubType).toBe("fee-increase-adjustment");

    const feeRemainder = p.lines.find(
      (l) =>
        l.accountCode === "4900" &&
        l.dc === "C" &&
        l.adjSubType === "category-change-prorata-credit",
    );
    expect(feeRemainder).toBeDefined();
    expect(feeInc.amount + feeRemainder.amount).toBe(p.amountNewTier);

    const oldDebit = p.lines.find(
      (l) => l.accountCode === "4900" && l.dc === "D",
    );
    expect(oldDebit.adjSubType).toBe("category-downgrade-unused-credit");

    const { debit, credit } = sumDc(p.lines);
    expect(debit).toBe(credit);
  });
});

describe("Scenario 4 — Mid-year join: initial subscription prorata only (no category change)", () => {
  test("example: join 2025-04-01 $365 annual → charge < full year through Dec 31", () => {
    const annual = 365_00;
    const join = "2025-04-01";
    const { endISO } = yearBoundsFrom(join);
    const slice = prorataFromJoinToYearEnd(annual, join);
    expect(slice).toBeLessThan(annual);
    expect(slice).toBe(prorataForPeriod(annual, join, endISO));

    const daysLeft = diffDaysInclusive(join, endISO);
    expect(daysLeft).toBe(275);
    expect(slice).toBe(Math.round((annual * daysLeft) / daysInYear(2025)));
  });
});

describe("Scenario 5 — Mid-year join + prorata, later upgrade → Fee Increase & positive net AR", () => {
  test("example: join 2025-04-01 part-time; upgrade 2025-09-01 to full-time", () => {
    const partAnnual = 182_50;
    const fullAnnual = 365_00;
    const join = "2025-04-01";
    const changeDate = "2025-09-01";

    const initialCharge = prorataFromJoinToYearEnd(partAnnual, join);
    expect(initialCharge).toBeGreaterThan(0);

    const p = catNetPayload({
      changeDate,
      previousSubscriptionStartDate: join,
      oldAnnualFee: partAnnual,
      newAnnualFee: fullAnnual,
      oldCat: "Part Time",
      newCat: "Full Time",
    });

    expect(p.incrementalCents).toBeGreaterThan(0);
    expect(netAr1400(p.lines)).toBe(p.incrementalCents);

    const feeInc = p.lines.find(
      (l) =>
        l.accountCode === "4900" &&
        l.revenueSubType === "Fee Increase" &&
        l.dc === "C",
    );
    expect(feeInc.amount).toBe(p.incrementalCents);

    const { debit, credit } = sumDc(p.lines);
    expect(debit).toBe(credit);

    const { endISO } = yearBoundsFrom(changeDate);
    expect(p.amountNewTier).toBe(
      prorataForPeriod(fullAnnual, changeDate, endISO),
    );
    expect(p.amountOldUnused).toBe(
      prorataForPeriod(partAnnual, changeDate, endISO),
    );
  });
});

describe("Scenario 6 — Mid-year join + prorata, later downgrade → Fee Decrease & negative net AR", () => {
  test("example: join 2025-04-01 full-time; downgrade 2025-09-01 to part-time", () => {
    const fullAnnual = 365_00;
    const partAnnual = 182_50;
    const join = "2025-04-01";
    const changeDate = "2025-09-01";

    const initialCharge = prorataFromJoinToYearEnd(fullAnnual, join);
    expect(initialCharge).toBeGreaterThan(0);

    const p = catNetPayload({
      changeDate,
      previousSubscriptionStartDate: join,
      oldAnnualFee: fullAnnual,
      newAnnualFee: partAnnual,
      oldCat: "Full Time",
      newCat: "Part Time",
    });

    expect(p.incrementalCents).toBeLessThan(0);
    expect(netAr1400(p.lines)).toBe(p.incrementalCents);

    const oldRelease = p.lines.find(
      (l) =>
        l.accountCode === "4900" &&
        l.dc === "D" &&
        l.adjSubType === "fee-decrease-adjustment",
    );
    expect(oldRelease.revenueSubType).toBe("Fee Decrease");

    const { debit, credit } = sumDc(p.lines);
    expect(debit).toBe(credit);
  });
});

describe("CATNET invariants", () => {
  test("net AR equals prorated (new − old) annual delta over change→year-end tail", () => {
    const changeDate = "2025-11-15";
    const { endISO } = yearBoundsFrom(changeDate);
    const oldA = 120_000;
    const newA = 95_000;
    const p = catNetPayload({
      changeDate,
      previousSubscriptionStartDate: "2025-02-01",
      oldAnnualFee: oldA,
      newAnnualFee: newA,
    });
    const expectedNet =
      prorataForPeriod(newA, changeDate, endISO) -
      prorataForPeriod(oldA, changeDate, endISO);
    expect(p.incrementalCents).toBe(expectedNet);
    expect(netAr1400(p.lines)).toBe(expectedNet);
  });

  test("new annual 0: credit-only AR from releasing old tier tail", () => {
    const p = catNetPayload({
      changeDate: "2025-10-01",
      previousSubscriptionStartDate: "2025-01-01",
      oldAnnualFee: 50_00,
      newAnnualFee: 0,
      oldCat: "Paid",
      newCat: "Comp",
    });
    expect(p.amountNewTier).toBe(0);
    expect(p.amountOldUnused).toBeGreaterThan(0);
    expect(netAr1400(p.lines)).toBe(-p.amountOldUnused);
    const { debit, credit } = sumDc(p.lines);
    expect(debit).toBe(credit);
  });
});
