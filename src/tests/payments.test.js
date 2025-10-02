import request from "supertest";
import { jest } from "@jest/globals";

// Ensure API key check passes
process.env.ACCOUNTS_API_KEY = process.env.ACCOUNTS_API_KEY || "test-key";

// Mock Stripe client before importing app/services
await jest.unstable_mockModule("../lib/stripe.js", () => ({
  getStripe: () => ({
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
  }),
}));

const { default: app } = await import("../app.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");

const headers = {
  "x-tenant-id": "demo-tenant",
  "x-api-key": process.env.ACCOUNTS_API_KEY,
  "x-idempotency-key": "demo-tenant:member-123:1690000000000",
};

describe("Payments API", () => {
  beforeAll(() => {
    // Stub Mongoose model methods to avoid real DB
    jest.spyOn(Payment, "create").mockResolvedValue({
      _id: { toString: () => "pay_1" },
      amount: 500,
      currency: "eur",
      purpose: "subscriptionFee",
    });
    jest
      .spyOn(Payment, "findOneAndUpdate")
      .mockResolvedValue({
        _id: { toString: () => "pay_1" },
        amount: 500,
        currency: "eur",
        purpose: "subscriptionFee",
      });
    jest
      .spyOn(Payment, "findOne")
      .mockResolvedValue({
        _id: { toString: () => "pay_1" },
        amount: 500,
        currency: "eur",
        purpose: "subscriptionFee",
      });
    jest
      .spyOn(Payment, "updateOne")
      .mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    jest
      .spyOn(Refund, "create")
      .mockResolvedValue({ _id: { toString: () => "ref_1" } });
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

  test("POST /api/payments/refunds external", async () => {
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({ mode: "external", amount: 100, reason: "manual" });
    expect(res.status).toBe(200);
  });

  test("POST /api/payments/refunds stripe", async () => {
    const res = await request(app)
      .post("/api/payments/refunds")
      .set(headers)
      .send({ mode: "stripe", paymentIntentId: "pi_fake", amount: 100 });
    expect(res.status).toBe(200);
  });
});
