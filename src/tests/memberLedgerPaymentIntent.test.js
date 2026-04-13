import { describe, expect, test, jest, beforeEach } from "@jest/globals";

const paymentFindMock = jest.fn();
const refundFindMock = jest.fn();

await jest.unstable_mockModule("../models/payment.model.js", () => ({
  default: { find: paymentFindMock },
}));

await jest.unstable_mockModule("../models/refund.model.js", () => ({
  default: { find: refundFindMock },
}));

const { attachPaymentIntentIdsToLedgerItems } = await import(
  "../helpers/memberLedgerPaymentIntent.js"
);

describe("attachPaymentIntentIdsToLedgerItems", () => {
  beforeEach(() => {
    paymentFindMock.mockReset();
    refundFindMock.mockReset();
  });

  test("returns null paymentIntentId when tenantId missing", async () => {
    const items = [{ docNo: "RCP-507f1f77bcf86cd799439011", docType: "Receipt" }];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "");
    expect(out[0].paymentIntentId).toBeNull();
    expect(paymentFindMock).not.toHaveBeenCalled();
  });

  test("resolves RCP- from Payment.stripe.paymentIntentId", async () => {
    const pid = "507f1f77bcf86cd799439011";
    paymentFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: pid, stripe: { paymentIntentId: "pi_test_123" } },
      ]),
    });
    refundFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const items = [{ docNo: `RCP-${pid}`, docType: "Receipt" }];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "t1");
    expect(out[0].paymentIntentId).toBe("pi_test_123");
  });

  test("resolves RFD- from Refund.stripe.paymentIntentId", async () => {
    const rid = "607f1f77bcf86cd799439022";
    paymentFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    refundFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: rid,
          paymentId: null,
          stripe: { paymentIntentId: "pi_from_refund" },
        },
      ]),
    });

    const items = [{ docNo: `RFD-${rid}`, docType: "Refund" }];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "t1");
    expect(out[0].paymentIntentId).toBe("pi_from_refund");
  });

  test("resolves CLAIM- from Payment by applicationId and claim amount", async () => {
    const appId = "9cd7bf3b-6750-4d58-9cf1-f1f929336170";
    paymentFindMock.mockImplementation((query) => {
      const chain = {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn(),
      };
      if (query.applicationId) {
        chain.lean.mockResolvedValue([
          {
            _id: "pay0",
            applicationId: appId,
            amount: 10000,
            status: "succeeded",
            mode: "stripe",
            createdAt: new Date("2026-04-07"),
            stripe: { paymentIntentId: "pi_member_payment" },
          },
          {
            _id: "pay1",
            applicationId: appId,
            amount: 8150,
            status: "succeeded",
            mode: "stripe",
            createdAt: new Date("2026-04-01"),
            stripe: { paymentIntentId: "pi_claimed_app" },
          },
        ]);
      } else {
        chain.lean.mockResolvedValue([]);
      }
      return chain;
    });
    refundFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const items = [
      {
        docNo: `CLAIM-${appId}`,
        docType: "Receipt",
        entries: [
          {
            accountCode: "2020",
            dc: "D",
            amount: 8150,
            applicationId: appId,
            periodBucket: "current",
          },
          {
            accountCode: "2020",
            dc: "C",
            amount: 8150,
            memberId: "B00004",
            periodBucket: "current",
          },
        ],
      },
    ];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "t1");
    expect(out[0].paymentIntentId).toBe("pi_claimed_app");
  });

  test("resolves RFD- via Refund.paymentId when stripe subdoc has no pi", async () => {
    const rid = "607f1f77bcf86cd799439022";
    const payOid = "507f1f77bcf86cd799439011";
    refundFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: rid,
          paymentId: payOid,
          stripe: {},
        },
      ]),
    });
    paymentFindMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: payOid, stripe: { paymentIntentId: "pi_via_payment" } },
      ]),
    });

    const items = [{ docNo: `RFD-${rid}`, docType: "Refund" }];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "t1");
    expect(out[0].paymentIntentId).toBe("pi_via_payment");
  });
});
