import { describe, expect, test } from "@jest/globals";
import { resolveTxTypeAccountCode } from "../helpers/glTransactionTxType.js";

describe("resolveTxTypeAccountCode", () => {
  test("Receipt: largest debit on clearing (Stripe main leg, not fee credit on 1220)", () => {
    const code = resolveTxTypeAccountCode({
      docType: "Receipt",
      entries: [
        { accountCode: "1220", dc: "D", amount: 10000 },
        { accountCode: "2020", dc: "C", amount: 10000 },
        { accountCode: "5100", dc: "D", amount: 165 },
        { accountCode: "1220", dc: "C", amount: 165 },
      ],
    });
    expect(code).toBe("1220");
  });

  test("Refund: credit to clearing", () => {
    const code = resolveTxTypeAccountCode({
      docType: "Refund",
      entries: [
        { accountCode: "2020", dc: "D", amount: 8150 },
        { accountCode: "1220", dc: "C", amount: 8150 },
      ],
    });
    expect(code).toBe("1220");
  });

  test("Receipt external: 1210 debit", () => {
    expect(
      resolveTxTypeAccountCode({
        docType: "Receipt",
        entries: [
          { accountCode: "1210", dc: "D", amount: 5000 },
          { accountCode: "2020", dc: "C", amount: 5000 },
        ],
      })
    ).toBe("1210");
  });

  test("CLAIM journal: only 2020 lines → null", () => {
    expect(
      resolveTxTypeAccountCode({
        docType: "Claim",
        entries: [
          { accountCode: "2020", dc: "D", amount: 8150, applicationId: "a1" },
          { accountCode: "2020", dc: "C", amount: 8150, memberId: "B1" },
        ],
      })
    ).toBeNull();
  });

  test("Invoice: no cash/clearing → null", () => {
    expect(
      resolveTxTypeAccountCode({
        docType: "Invoice",
        entries: [
          { accountCode: "1400", dc: "D", amount: 32600, memberId: "B1" },
          { accountCode: "4000", dc: "C", amount: 32600 },
        ],
      })
    ).toBeNull();
  });

  test("WriteOff: adjSubType writeoff line → 5200", () => {
    expect(
      resolveTxTypeAccountCode({
        docType: "WriteOff",
        entries: [
          { accountCode: "5200", dc: "D", amount: 200, adjSubType: "writeoff" },
          { accountCode: "1400", dc: "C", amount: 200, memberId: "B1" },
        ],
      })
    ).toBe("5200");
  });
});
