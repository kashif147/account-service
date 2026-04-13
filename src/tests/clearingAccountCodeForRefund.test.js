import { describe, expect, test } from "@jest/globals";
import { clearingAccountCodeForRefund } from "../services/payments.service.js";

describe("clearingAccountCodeForRefund", () => {
  const extPay = { mode: "external" };

  test("stripe refund without payoutMethod (API path) → 1220", () => {
    expect(clearingAccountCodeForRefund({ mode: "stripe" }, extPay)).toBe("1220");
  });

  test("stripe GL-only bank_transfer → 1200", () => {
    expect(
      clearingAccountCodeForRefund(
        { mode: "stripe", payoutMethod: "bank_transfer" },
        extPay
      )
    ).toBe("1200");
  });

  test("stripe GL-only cheque → 1210", () => {
    expect(
      clearingAccountCodeForRefund({ mode: "stripe", payoutMethod: "cheque" }, extPay)
    ).toBe("1210");
  });

  test("stripe GL-only card → 1220", () => {
    expect(
      clearingAccountCodeForRefund({ mode: "stripe", payoutMethod: "card" }, extPay)
    ).toBe("1220");
  });

  test("external refund bank_transfer → 1200", () => {
    expect(
      clearingAccountCodeForRefund(
        { mode: "external", payoutMethod: "bank_transfer" },
        extPay
      )
    ).toBe("1200");
  });

  test("external refund cheque → 1210", () => {
    expect(
      clearingAccountCodeForRefund({ mode: "external", payoutMethod: "cheque" }, extPay)
    ).toBe("1210");
  });

  test("external refund card → 1220", () => {
    expect(
      clearingAccountCodeForRefund({ mode: "external", payoutMethod: "card" }, extPay)
    ).toBe("1220");
  });

  test("external refund defaults payoutMethod to bank → 1200", () => {
    expect(clearingAccountCodeForRefund({ mode: "external" }, extPay)).toBe("1200");
  });

  test("legacy refund doc without mode: stripe payment → 1220", () => {
    expect(
      clearingAccountCodeForRefund({ amount: 100 }, { mode: "stripe", memberId: "m1" })
    ).toBe("1220");
  });

  test("legacy refund doc without mode: external payment + cheque → 1210", () => {
    expect(
      clearingAccountCodeForRefund({ amount: 100, payoutMethod: "cheque" }, extPay)
    ).toBe("1210");
  });

  test("legacy refund doc without mode: external payment, no payoutMethod → 1200", () => {
    expect(clearingAccountCodeForRefund({ amount: 100 }, extPay)).toBe("1200");
  });
});
