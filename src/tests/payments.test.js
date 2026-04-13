import request from "supertest";
import { jest } from "@jest/globals";

// Ensure API key check passes
process.env.ACCOUNTS_API_KEY = process.env.ACCOUNTS_API_KEY || "test-key";

// Mock Stripe client before importing app/services
await jest.unstable_mockModule("../lib/stripe.js", () => {
  const stripeMock = {
    paymentIntents: {
      create: async () => ({
        id: "pi_mock_1",
        status: "requires_action",
        client_secret: "secret",
      }),
    },
    checkout: {
      sessions: {
        create: async () => ({ id: "cs_mock_1", url: "https://checkout" }),
      },
    },
    refunds: {
      create: async () => ({ id: "re_mock_1", charge: "ch_mock_1" }),
    },
  };
  return {
    default: stripeMock,
    getStripe: () => stripeMock,
  };
});

await jest.unstable_mockModule("../rabbitMQ/events.js", () => ({
  APPLICATION_EVENTS: {},
  EVENT_TYPES: {},
  publishDomainEvent: jest.fn().mockResolvedValue(true),
  initEventSystem: jest.fn().mockResolvedValue(undefined),
  setupConsumers: jest.fn().mockResolvedValue(undefined),
  shutdownEventSystem: jest.fn().mockResolvedValue(undefined),
  init: jest.fn(),
  publisher: {},
  consumer: {},
  shutdown: jest.fn(),
}));

const { default: app } = await import("../app.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: MaterializedBalance } = await import(
  "../models/materializedBalance.model.js"
);
const { default: GLTransaction } = await import(
  "../models/glTransaction.model.js"
);
const { default: CoA } = await import("../models/coa.model.js");

const headers = {
  "x-tenant-id": "demo-tenant",
  "x-api-key": process.env.ACCOUNTS_API_KEY,
};

const OID = "507f1f77bcf86cd799439011";
/** ObjectId used for Payment.findOne → mode stripe (not external OID). */
const STRIPE_PAY_OID = "507f1f77bcf86cd799439099";

describe("Payments API", () => {
  beforeAll(() => {
    jest.spyOn(MaterializedBalance, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ amount: -100000 }]),
    });
    jest.spyOn(MaterializedBalance, "bulkWrite").mockResolvedValue({});
    jest.spyOn(GLTransaction, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    jest.spyOn(GLTransaction, "create").mockImplementation((doc) => {
      const d = { ...doc, _id: "gl_new" };
      return Promise.resolve({
        ...d,
        toObject() {
          return {
            ...d,
            entries: (d.entries || []).map((e) => ({
              ...e,
              accountLabel: `${e.accountCode} (x)`,
            })),
          };
        },
      });
    });
    jest.spyOn(CoA, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { code: "2020", description: "Member credits" },
        { code: "1200", description: "Bank" },
        { code: "1220", description: "Card Gateway Clearing" },
        { code: "1210", description: "Undeposited Cheques" },
      ]),
    });

    jest.spyOn(Payment, "create").mockResolvedValue({
      _id: { toString: () => "pay_1" },
      amount: 500,
      currency: "eur",
      purpose: "subscriptionFee",
    });
    jest.spyOn(Payment, "findOneAndUpdate").mockResolvedValue({
      _id: { toString: () => "pay_1" },
      amount: 500,
      currency: "eur",
      purpose: "subscriptionFee",
    });
    const chainFindOne = (leanDoc) => ({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(leanDoc),
    });
    jest.spyOn(Payment, "findOne").mockImplementation((filter) => {
      const base = {
        _id: { toString: () => "pay_1" },
        amount: 500,
        currency: "eur",
        memberId: "m1",
        status: "succeeded",
        metadata: new Map(),
        stripe: { paymentIntentId: "pi_fake" },
      };
      if (filter["stripe.paymentIntentId"] === "pi_fake") {
        return chainFindOne({ ...base, mode: "stripe" });
      }
      if (filter["stripe.paymentIntentId"] === "pi_test_123") {
        return chainFindOne({
          ...base,
          _id: { toString: () => "pay_pi_test" },
          mode: "stripe",
          stripe: { paymentIntentId: "pi_test_123" },
        });
      }
      if (filter._id) {
        const idStr = String(filter._id);
        const isExternalOid = idStr === OID;
        return chainFindOne({
          ...base,
          _id: filter._id,
          mode: isExternalOid ? "external" : "stripe",
          stripe: isExternalOid
            ? {}
            : { paymentIntentId: "pi_from_payment_doc" },
        });
      }
      return chainFindOne(null);
    });
    jest
      .spyOn(Payment, "updateOne")
      .mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    jest.spyOn(Payment, "find").mockReturnValue({
      distinct: jest.fn().mockResolvedValue([OID]),
    });
    let refundIdSeq = 0;
    jest.spyOn(Refund, "create").mockImplementation((doc) => {
      refundIdSeq += 1;
      const idStr = `ref_${refundIdSeq}`;
      return Promise.resolve({
        ...doc,
        _id: { toString: () => idStr },
        amount: doc.amount,
      });
    });
    jest
      .spyOn(Refund, "updateOne")
      .mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    jest.spyOn(Refund, "aggregate").mockResolvedValue([{ total: 0 }]);
    jest.spyOn(Refund, "find").mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            populate: () => ({
              lean: jest
                .fn()
                .mockResolvedValue([
                  {
                    _id: "r1",
                    tenantId: "demo-tenant",
                    amount: 100,
                    mode: "stripe",
                    glDocNo: "RFD-ref_1",
                    paymentId: null,
                  },
                ]),
            }),
          }),
        }),
      }),
    });
    jest.spyOn(Refund, "countDocuments").mockResolvedValue(1);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test("POST /api/payments/intents without checkout", async () => {
    const res = await request(app)
      .post("/api/payments/intents")
      .set(headers)
      .send({ purpose: "subscriptionFee", amount: 500, currency: "eur" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
  });

  test("POST /api/payments/intents with checkout", async () => {
    const res = await request(app)
      .post("/api/payments/intents")
      .set(headers)
      .send({
        purpose: "subscriptionFee",
        amount: 500,
        currency: "eur",
        useCheckout: true,
      });
    expect(res.status).toBe(200);
  });

  test("POST /api/payments/reconcile upsert", async () => {
    const res = await request(app)
      .post("/api/payments/reconcile")
      .set(headers)
      .send({
        eventId: "evt_1",
        type: "payment_intent.succeeded",
        payment: {
          paymentIntentId: "pi_test_123",
          amount: 500,
          currency: "eur",
          status: "succeeded",
        },
      });
    expect(res.status).toBe(200);
  });

  test("POST /api/payments/record-external in", async () => {
    const res = await request(app)
      .post("/api/payments/record-external")
      .set(headers)
      .send({
        direction: "in",
        amount: 500,
        currency: "eur",
        reason: "cash payment",
      });
    expect(res.status).toBe(200);
  });

  test("POST /api/payments/record-external out", async () => {
    const res = await request(app)
      .post("/api/payments/record-external")
      .set(headers)
      .send({
        direction: "out",
        amount: 300,
        currency: "eur",
        reason: "refund",
      });
    expect(res.status).toBe(200);
  });

  test("POST /api/payments/refunds external with paymentId", async () => {
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({
        mode: "external",
        paymentId: OID,
        amount: 100,
        payoutMethod: "bank_transfer",
        reason: "manual",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.glPosted).toBe(true);
    expect(res.body.data.glDocNo).toMatch(/^RFD-ref_/);
  });

  test("POST /api/payments/refunds external standalone (no paymentId / PI)", async () => {
    Payment.updateOne.mockClear();
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({
        mode: "external",
        memberId: "m1",
        amount: 100,
        payoutMethod: "cheque",
        currency: "eur",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.standaloneExternal).toBe(true);
    expect(res.body.data.glPosted).toBe(true);
    expect(Payment.updateOne).not.toHaveBeenCalled();
  });

  test("POST /api/payments/refunds stripe", async () => {
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({ mode: "stripe", paymentIntentId: "pi_fake", amount: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.refundId).toBe("re_mock_1");
    expect(res.body.data.glPosted).toBe(true);
    expect(res.body.data.glDocNo).toMatch(/^RFD-ref_/);
    expect(res.body.data.stripeApiSkipped).toBeUndefined();
  });

  test("POST /api/payments/refunds stripe GL-only without paymentIntentId", async () => {
    const { getStripe } = await import("../lib/stripe.js");
    const createSpy = jest.spyOn(getStripe().refunds, "create");
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({
        mode: "stripe",
        paymentId: STRIPE_PAY_OID,
        amount: 100,
        payoutMethod: "bank_transfer",
      });
    expect(res.status).toBe(200);
    expect(createSpy).not.toHaveBeenCalled();
    expect(res.body.data.refundId).toBeUndefined();
    expect(res.body.data.stripeApiSkipped).toBe(true);
    expect(res.body.data.glPosted).toBe(true);
    createSpy.mockRestore();
  });

  test("POST /api/payments/refunds external standalone rejects without member or application", async () => {
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({
        mode: "external",
        amount: 100,
        payoutMethod: "bank_transfer",
      });
    expect(res.status).toBe(400);
  });

  test("POST /api/payments/refunds rejects when credit insufficient", async () => {
    MaterializedBalance.find.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue([{ amount: 0 }]),
    });
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({ mode: "stripe", paymentIntentId: "pi_fake", amount: 100 });
    expect(res.status).toBe(400);
  });

  test("GET /api/payments/refunds", async () => {
    const res = await request(app).get("/api/payments/refunds").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.total).toBe(1);
  });

  test("postJournalForRefund idempotent when GL doc exists", async () => {
    GLTransaction.create.mockClear();
    const { postJournalForRefund } = await import(
      "../services/payments.service.js"
    );
    GLTransaction.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue({
        docNo: "RFD-existing",
        _id: "existing",
      }),
    });
    const pay = {
      mode: "stripe",
      memberId: "m1",
      metadata: new Map(),
    };
    const refundDoc = { _id: "ref_x", amount: 100 };
    const j = await postJournalForRefund(refundDoc, pay, {
      tenantId: "demo-tenant",
    });
    expect(j.docNo).toBe("RFD-existing");
    expect(GLTransaction.create).not.toHaveBeenCalled();
  });
});
