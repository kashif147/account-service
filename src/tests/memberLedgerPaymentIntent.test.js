import { describe, expect, test, jest, beforeEach } from "@jest/globals";

const paymentFindMock = jest.fn();
const refundFindMock = jest.fn();
const glFindMock = jest.fn();

await jest.unstable_mockModule("../models/payment.model.js", () => ({
  default: { find: paymentFindMock },
}));

await jest.unstable_mockModule("../models/refund.model.js", () => ({
  default: { find: refundFindMock },
}));

await jest.unstable_mockModule("../models/glTransaction.model.js", () => ({
  default: { find: glFindMock },
}));

const { attachPaymentIntentIdsToLedgerItems } = await import(
  "../helpers/memberLedgerPaymentIntent.js"
);

describe("attachPaymentIntentIdsToLedgerItems", () => {
  beforeEach(() => {
    paymentFindMock.mockReset();
    refundFindMock.mockReset();
    glFindMock.mockReset();
    glFindMock.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
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
      if (query.$or || query.applicationId) {
        chain.lean.mockResolvedValue([
          {
            _id: "pay0",
            applicationId: appId,
            memberId: null,
            amount: 10000,
            status: "succeeded",
            mode: "stripe",
            createdAt: new Date("2026-04-07"),
            stripe: { paymentIntentId: "pi_member_payment" },
          },
          {
            _id: "pay1",
            applicationId: appId,
            memberId: null,
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

    glFindMock.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          docNo: "RCP-pay1",
          docType: "Receipt",
          entries: [
            { accountCode: "1220", dc: "D", amount: 8150 },
            {
              accountCode: "2020",
              dc: "C",
              amount: 8150,
              applicationId: appId,
              periodBucket: "current",
            },
          ],
        },
      ]),
    });

    const items = [
      {
        _id: "claimrow1",
        docNo: `CLAIM-${appId}`,
        docType: "Claim",
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
    expect(out[0].underlyingReceiptGl?.docNo).toBe("RCP-pay1");
    expect(out[0].underlyingReceiptGl?.entries?.[0]?.accountCode).toBe("1220");
  });

  test("CLAIM prefers Payment for claim recipient memberId over application-only payment", async () => {
    const appId = "9cd7bf3b-6750-4d58-9cf1-f1f929336171";
    paymentFindMock.mockImplementation((query) => {
      const chain = {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn(),
      };
      if (query.$or || query.applicationId) {
        chain.lean.mockResolvedValue([
          {
            _id: "payApp",
            applicationId: appId,
            memberId: null,
            amount: 8150,
            status: "succeeded",
            mode: "stripe",
            createdAt: new Date("2026-04-01"),
            stripe: { paymentIntentId: "pi_app_level" },
          },
          {
            _id: "payMem",
            applicationId: null,
            memberId: "B00005",
            amount: 8150,
            status: "succeeded",
            mode: "stripe",
            createdAt: new Date("2026-04-02"),
            stripe: { paymentIntentId: "pi_member_actual" },
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

    glFindMock.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          docNo: "RCP-payMem",
          docType: "Receipt",
          entries: [{ accountCode: "1220", dc: "D", amount: 8150 }],
        },
      ]),
    });

    const items = [
      {
        _id: "claimrow2",
        docNo: `CLAIM-${appId}`,
        docType: "Claim",
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
            memberId: "B00005",
            periodBucket: "current",
          },
        ],
      },
    ];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "t1");
    expect(out[0].paymentIntentId).toBe("pi_member_actual");
    expect(out[0].underlyingReceiptGl?.docNo).toBe("RCP-payMem");
  });

  test("CLAIM does not attach underlyingReceiptGl when RCP already in items", async () => {
    const appId = "9cd7bf3b-6750-4d58-9cf1-f1f929336199";
    const payId = "507f1f77bcf86cd799439055";
    paymentFindMock.mockImplementation((query) => {
      const chain = {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn(),
      };
      if (query.$or || query.applicationId) {
        chain.lean.mockResolvedValue([
          {
            _id: payId,
            applicationId: appId,
            memberId: null,
            amount: 5000,
            status: "succeeded",
            mode: "stripe",
            createdAt: new Date("2026-04-01"),
            stripe: { paymentIntentId: "pi_dup" },
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
      { docNo: `RCP-${payId}`, docType: "Receipt", entries: [] },
      {
        _id: "claim3",
        docNo: `CLAIM-${appId}`,
        docType: "Claim",
        entries: [
          {
            accountCode: "2020",
            dc: "D",
            amount: 5000,
            applicationId: appId,
            periodBucket: "current",
          },
          {
            accountCode: "2020",
            dc: "C",
            amount: 5000,
            memberId: "B00009",
            periodBucket: "current",
          },
        ],
      },
    ];
    const out = await attachPaymentIntentIdsToLedgerItems(items, "t1");
    expect(out[1].paymentIntentId).toBe("pi_dup");
    expect(out[1].underlyingReceiptGl).toBeNull();
    expect(glFindMock).not.toHaveBeenCalled();
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
