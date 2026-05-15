import { describe, expect, test } from "@jest/globals";
import {
  buildMemberLastPayment,
  memberPaymentCreditCents,
  pickLastMemberPayment,
} from "../helpers/memberLastPayment.js";

describe("memberLastPayment", () => {
  const clearingDebit = { accountCode: "1210", dc: "D", amount: 5000 };

  test("sums 1400 and 2020 credits for the member", () => {
    const txn = {
      docType: "Receipt",
      entries: [
        { memberId: "M1", accountCode: "1400", dc: "C", amount: 3000 },
        { memberId: "M1", accountCode: "2020", dc: "C", amount: 2000 },
        clearingDebit,
      ],
    };
    expect(memberPaymentCreditCents("M1", txn)).toBe(5000);
  });

  test("picks newest receipt that only credits 1400 over older 2020 advance", () => {
    const txns = [
      {
        docType: "Receipt",
        docNo: "R-NEW",
        date: new Date("2026-03-15"),
        createdAt: new Date("2026-03-15T12:00:00Z"),
        memo: "Invoice payment",
        entries: [
          { memberId: "M1", accountCode: "1400", dc: "C", amount: 8000 },
          { accountCode: "1210", dc: "D", amount: 8000 },
        ],
      },
      {
        docType: "Receipt",
        docNo: "R-OLD",
        date: new Date("2026-01-10"),
        createdAt: new Date("2026-01-10T12:00:00Z"),
        memo: "Overpayment",
        entries: [
          { memberId: "M1", accountCode: "2020", dc: "C", amount: 5000 },
          { accountCode: "1210", dc: "D", amount: 5000 },
        ],
      },
    ];

    const picked = pickLastMemberPayment("M1", txns);
    expect(picked?.docNo).toBe("R-NEW");
    expect(buildMemberLastPayment("M1", picked)).toMatchObject({
      amount: 8000,
      docNo: "R-NEW",
    });
  });

  test("includes Claim journals", () => {
    const txns = [
      {
        docType: "Claim",
        docNo: "CLM-1",
        date: new Date("2026-04-01"),
        entries: [{ memberId: "M1", accountCode: "2020", dc: "C", amount: 1200 }],
      },
    ];
    expect(pickLastMemberPayment("M1", txns)?.docNo).toBe("CLM-1");
  });
});
