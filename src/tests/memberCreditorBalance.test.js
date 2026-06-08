import { describe, it, expect } from "vitest";
import { computeMemberBalanceFromGl } from "../helpers/memberCreditorBalance.helper.js";

describe("computeMemberBalanceFromGl", () => {
  it("treats 2020 prepayment (negative POA) as creditor liability", () => {
    const r = computeMemberBalanceFromGl({ ar1400: 0, poa2020: -5000 });
    expect(r.net).toBe(-5000);
    expect(r.amountCents).toBe(5000);
  });

  it("treats negative AR as creditor", () => {
    const r = computeMemberBalanceFromGl({ ar1400: -3000, poa2020: 0 });
    expect(r.amountCents).toBe(3000);
  });

  it("keeps CN transfer on 2020 as creditor", () => {
    const r = computeMemberBalanceFromGl({ ar1400: 0, poa2020: -8000 });
    expect(r.amountCents).toBe(8000);
  });

  it("offsets POA against AR for net creditor", () => {
    const r = computeMemberBalanceFromGl({ ar1400: 10000, poa2020: -15000 });
    expect(r.net).toBe(-5000);
    expect(r.amountCents).toBe(5000);
  });

  it("excludes net debtors", () => {
    const r = computeMemberBalanceFromGl({ ar1400: 10000, poa2020: -3000 });
    expect(r.net).toBe(7000);
    expect(r.amountCents).toBe(0);
    expect(r.debtorCents).toBe(7000);
  });
});
