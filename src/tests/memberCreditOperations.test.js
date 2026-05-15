import { describe, expect, test, jest } from "@jest/globals";
import { buildMemberApplyCreditEntries } from "../helpers/paymentReceiptAllocation.js";

describe("buildMemberApplyCreditEntries", () => {
  test("returns DR 2020 and CR 1400 lines when credit and AR exist", async () => {
    const MaterializedBalance = (
      await import("../models/materializedBalance.model.js")
    ).default;

    const findSpy = jest.spyOn(MaterializedBalance, "find").mockImplementation((q) => {
      if (q.accountCode === "2020") {
        return { lean: async () => [{ amount: -10000, bucket: "advance" }] };
      }
      if (q.accountCode === "1400") {
        return {
          lean: async () => [
            { amount: 6000, bucket: "arrears" },
            { amount: 4000, bucket: "current" },
          ],
        };
      }
      return { lean: async () => [] };
    });

    const lines = await buildMemberApplyCreditEntries(
      "M1",
      5000,
      "2026-05-15",
    );
    findSpy.mockRestore();

    expect(lines.some((l) => l.accountCode === "2020" && l.dc === "D")).toBe(
      true,
    );
    expect(lines.some((l) => l.accountCode === "1400" && l.dc === "C")).toBe(
      true,
    );
    const dr = lines
      .filter((l) => l.dc === "D")
      .reduce((s, l) => s + l.amount, 0);
    const cr = lines
      .filter((l) => l.dc === "C")
      .reduce((s, l) => s + l.amount, 0);
    expect(dr).toBe(cr);
  });
});
