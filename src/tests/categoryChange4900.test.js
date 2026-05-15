import { describe, expect, test } from "@jest/globals";
import { buildCategoryChangeJournalPayload } from "../helpers/categoryChangeJournal.js";

describe("category change posts to 4900 only", () => {
  test("no 4xxx income lines on CATNET", () => {
    const p = buildCategoryChangeJournalPayload({
      memberId: "M1",
      oldIncomeCode: "4000",
      oldCategoryName: "Old",
      oldAnnualFee: 365_00,
      newIncomeCode: "4010",
      newCategoryName: "New",
      newAnnualFee: 182_50,
      changeDate: "2025-07-01",
      previousSubscriptionStartDate: "2025-01-01",
    });
    const fourxxx = p.lines.filter((l) => /^40\d{2}$/.test(l.accountCode));
    expect(fourxxx).toHaveLength(0);
    expect(p.lines.some((l) => l.accountCode === "4900")).toBe(true);
  });
});
