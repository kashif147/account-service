// NOTE: this file imports the real eventCancellationRefund.service.js, which
// imports the real Payment/Refund mongoose models - that import graph fails
// to load under this repo's installed jest (25.5.4) + --experimental-vm-modules
// (ENOENT on node:-prefixed core requires from inside mongoose itself; see
// account-service/CLAUDE.md's documented 15/20-suite failure and
// eventCancellationRefund.noCreditCap.test.js, which covers the single most
// important regression - never calling assertRefundWithinCredit - via a
// plain source-text check that doesn't hit this import graph and so DOES run
// today). Until that jest/mongoose ESM incompatibility is fixed platform-wide
// (a bigger, separate change - see CLAUDE.md), this file documents the
// intended behavior and can be run manually once the jest upgrade lands, but
// currently fails to load here the same way ~15 other pre-existing test
// files in this service already do - this is not a regression introduced by
// the event-cancellation-refund feature.
import { describe, expect, test, jest } from "@jest/globals";
import { processEventCancellationRefunds } from "../services/eventCancellationRefund.service.js";

// jest.unstable_mockModule isn't available on the jest version installed
// here (25.5.4 - that API needs Jest 27+), so dependencies are injected via
// processEventCancellationRefunds's second argument (see the service's
// `defaultDeps`) rather than via ESM module mocking.
function makeDeps(overrides = {}) {
  return {
    Payment: { findOne: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) },
    Refund: {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      create: jest.fn().mockResolvedValue({ _id: "refund-1" }),
      updateOne: jest.fn().mockResolvedValue({}),
    },
    getStripe: jest.fn(() => ({ refunds: { create: jest.fn().mockResolvedValue({ id: "re_1", charge: "ch_1" }) } })),
    postBalancedJournal: jest.fn().mockResolvedValue({ docNo: "RFD-EVT-refund-1" }),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

const TENANT_ID = "tenant-refund-test";
const EVENT_ID = "event-1";

function stripePayment(overrides = {}) {
  return {
    _id: "payment-1",
    tenantId: TENANT_ID,
    mode: "stripe",
    status: "succeeded",
    amount: 12000,
    currency: "eur",
    registrationId: "registration-1",
    eventCategoryCode: "CPD",
    stripe: { paymentIntentId: "pi_full_amount" },
    ...overrides,
  };
}

describe("processEventCancellationRefunds", () => {
  test("refunds the full captured amount via Stripe - no credit-balance cap involved", async () => {
    const deps = makeDeps();
    deps.Payment.findOne.mockResolvedValue(stripePayment());

    const result = await processEventCancellationRefunds(
      {
        data: {
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          refundCandidates: [
            { registrationId: "registration-1", paymentId: "payment-1", paymentMethod: "stripe", amount: 12000 },
          ],
        },
      },
      deps,
    );

    const stripeInstance = deps.getStripe.mock.results[0].value;
    expect(stripeInstance.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_full_amount", amount: 12000 }),
      expect.objectContaining({ idempotencyKey: "event-cancel-refund:payment-1" }),
    );
    expect(deps.Refund.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, paymentId: "payment-1", mode: "stripe", amount: 12000 }),
    );
    expect(result.processed).toBe(1);
    expect(result.results[0]).toMatchObject({ registrationId: "registration-1", refundId: "refund-1" });
  });

  test("skips (does not double-refund) a payment already refunded for this event cancellation", async () => {
    const deps = makeDeps({
      Refund: {
        findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: "existing-refund" }) }),
        create: jest.fn(),
        updateOne: jest.fn(),
      },
    });
    deps.Payment.findOne.mockResolvedValue(stripePayment());

    const result = await processEventCancellationRefunds(
      {
        data: {
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          refundCandidates: [{ registrationId: "registration-1", paymentId: "payment-1", paymentMethod: "stripe" }],
        },
      },
      deps,
    );

    expect(deps.Refund.create).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ skipped: true, reason: "already_refunded" });
  });

  test("skips a payment whose status does not allow a refund (e.g. an unpaid invoice)", async () => {
    const deps = makeDeps();
    deps.Payment.findOne.mockResolvedValue(stripePayment({ status: "payment_required" }));

    const result = await processEventCancellationRefunds(
      {
        data: {
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          refundCandidates: [{ registrationId: "registration-1", paymentId: "payment-1", paymentMethod: "stripe" }],
        },
      },
      deps,
    );

    expect(deps.Refund.create).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ skipped: true, reason: "payment_not_refundable" });
  });

  test("processes remaining candidates even if one fails", async () => {
    const deps = makeDeps();
    deps.Payment.findOne
      .mockResolvedValueOnce(null) // first candidate: payment not found
      .mockResolvedValueOnce(stripePayment({ _id: "payment-2" })); // second candidate: succeeds

    const result = await processEventCancellationRefunds(
      {
        data: {
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          refundCandidates: [
            { registrationId: "registration-1", paymentId: "payment-missing", paymentMethod: "stripe" },
            { registrationId: "registration-2", paymentId: "payment-2", paymentMethod: "stripe" },
          ],
        },
      },
      deps,
    );

    expect(result.processed).toBe(2);
    expect(result.results[0]).toMatchObject({ skipped: true, reason: "payment_not_found" });
    expect(deps.Refund.create).toHaveBeenCalledTimes(1);
  });
});
