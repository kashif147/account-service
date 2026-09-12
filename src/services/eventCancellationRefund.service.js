// Automatic refund processing for events-service's events.event.cancelled.v1 -
// deliberately NOT a modification of createRefund()/payments.service.js's
// membership-oriented postJournalForRefund(): an organizer-cancelled event
// refunds the full amount the attendee actually paid, on the organizer's
// decision, with no finance-approval gate - a different concept from
// createRefund's assertRefundWithinCredit(), which caps a refund against a
// MEMBER'S CREDIT BALANCE (irrelevant here - this is reimbursing a real
// captured payment, not drawing down credit). Do not import/call
// assertRefundWithinCredit from this file.
//
// Also deliberately does NOT reuse payments.service.js's postJournalForRefund
// - that function's debit-line logic (member 2020 bucket / applicationId)
// only reverses MEMBERSHIP-domain receipts. Events/courses payments post to a
// segregated set of accounts (see handlers/eventRegistration.approval.listener.js's
// postJournalForEventPayment: clearing -> POA(2020) -> AR(1400) -> income),
// whose net effect is DR clearing / CR income - so the correct reversal here
// mirrors THAT shape (DR income / CR clearing), not the membership one.
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
import { getStripe } from "../lib/stripe.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";
import logger from "../config/logger.js";

const EVENTS_CLEARING_CODE_STRIPE = "1220";
const EVENTS_CLEARING_CODE_MANUAL = "1210";
const DEFAULT_EVENTS_INCOME_CODE = "4500";
const EVENT_INCOME_CODE_BY_CATEGORY = { CPD: "4510", EVENT: "4520" };

// Real dependencies for production use - tests inject fakes for these via
// processEventCancellationRefunds's second argument instead of ESM module
// mocking (jest.unstable_mockModule isn't available on the jest version
// installed here - see eventCancellationRefund.service.test.js).
const defaultDeps = { Payment, Refund, getStripe, postBalancedJournal, logger };

function resolveEventIncomeCode(eventCategoryCode) {
  return EVENT_INCOME_CODE_BY_CATEGORY[eventCategoryCode] || DEFAULT_EVENTS_INCOME_CODE;
}

/** Reverses the recognized revenue for a cancelled event registration - the
 * net effect of postJournalForEventPayment's three-entry posting is DR
 * clearing / CR income, so this is the exact mirror: DR income (reverse the
 * revenue) / CR clearing (cash leaving back to the payer). Doesn't reverse
 * the Stripe processing-fee entry (5100) - Stripe itself doesn't refund its
 * own fee on a charge refund, so neither does this journal. */
async function postEventCancellationRefundJournal({ refundDoc, payment, tenantId, deps }) {
  const amount = refundDoc.amount;
  const clearingCode = payment.mode === "stripe" ? EVENTS_CLEARING_CODE_STRIPE : EVENTS_CLEARING_CODE_MANUAL;
  const incomeCode = resolveEventIncomeCode(payment.eventCategoryCode);
  const base = {
    registrationId: payment.registrationId,
    profileId: payment.profileId || undefined,
    memberId: payment.memberId || undefined,
    periodBucket: "current",
    ledgerDomain: "events",
  };
  const date = new Date().toISOString().split("T")[0];

  const docNo = `RFD-EVT-${refundDoc._id}`;
  try {
    const journal = await deps.postBalancedJournal({
      date,
      tenantId,
      profileId: payment.profileId,
      docType: "Refund",
      docNo,
      memo: `Refund - event cancelled (registration ${payment.registrationId})`,
      lines: [
        { accountCode: incomeCode, dc: "D", amount, ...base },
        { accountCode: clearingCode, dc: "C", amount, ...base },
      ],
      operation: "events_cancellation_refund_posted",
    });
    if (journal?.docNo) {
      await deps.Refund.updateOne({ _id: refundDoc._id }, { $set: { glDocNo: journal.docNo, glStatus: "posted" } });
      return { glPosted: true, glDocNo: journal.docNo };
    }
    await deps.Refund.updateOne({ _id: refundDoc._id }, { $set: { glStatus: "gl_failed" } });
    return { glPosted: false, glDocNo: null };
  } catch (err) {
    deps.logger.error({ err, docNo, refundId: String(refundDoc._id) }, "postEventCancellationRefundJournal failed");
    await deps.Refund.updateOne({ _id: refundDoc._id }, { $set: { glStatus: "gl_failed" } }).catch(() => {});
    return { glPosted: false, glDocNo: null };
  }
}

/** One refund candidate from events.event.cancelled.v1's payload - see
 * event.lifecycle.publisher.js on the events-service side for the shape. */
async function refundOneCandidate({ tenantId, eventId, candidate, deps }) {
  const { registrationId, paymentId } = candidate;

  if (!paymentId) {
    deps.logger.warn({ tenantId, eventId, registrationId }, "Event cancellation refund candidate has no paymentId - skipping");
    return { registrationId, skipped: true, reason: "no_payment_id" };
  }

  // Idempotency: a redelivered events.event.cancelled.v1 (or a crash after
  // Stripe refund but before this returns) must never refund the same
  // payment twice.
  const already = await deps.Refund.findOne({
    tenantId,
    paymentId,
    "metadata.reason": "event_cancellation",
  }).lean();
  if (already) {
    return { registrationId, skipped: true, reason: "already_refunded" };
  }

  const payment = await deps.Payment.findOne({ _id: paymentId, tenantId });
  if (!payment) {
    deps.logger.warn({ tenantId, eventId, registrationId, paymentId }, "Event cancellation refund: Payment not found");
    return { registrationId, skipped: true, reason: "payment_not_found" };
  }
  if (!["succeeded", "partially_refunded"].includes(payment.status)) {
    deps.logger.warn(
      { tenantId, eventId, registrationId, paymentId, status: payment.status },
      "Event cancellation refund: payment status does not allow refund - skipping",
    );
    return { registrationId, skipped: true, reason: "payment_not_refundable" };
  }

  const amount = payment.amount;
  const metadata = new Map([
    ["reason", "event_cancellation"],
    ["eventId", eventId],
    ["registrationId", registrationId],
  ]);

  let refundDoc;
  if (payment.mode === "stripe") {
    if (!payment.stripe?.paymentIntentId) {
      deps.logger.warn(
        { tenantId, eventId, registrationId, paymentId },
        "Stripe payment missing paymentIntentId - skipping refund",
      );
      return { registrationId, skipped: true, reason: "missing_payment_intent" };
    }
    const stripe = deps.getStripe();
    const stripeRefund = await stripe.refunds.create(
      { payment_intent: payment.stripe.paymentIntentId, amount, metadata: { eventId, registrationId } },
      { idempotencyKey: `event-cancel-refund:${paymentId}` },
    );

    refundDoc = await deps.Refund.create({
      tenantId,
      paymentId: payment._id,
      mode: "stripe",
      ...(payment.memberId ? { memberId: payment.memberId } : {}),
      amount,
      currency: payment.currency,
      refundDate: new Date(),
      stripe: {
        refundId: stripeRefund.id,
        chargeId: stripeRefund.charge || undefined,
        paymentIntentId: payment.stripe.paymentIntentId,
      },
      memo: "Event cancelled - automatic refund",
      metadata,
    });

    await deps.Payment.updateOne(
      { _id: payment._id },
      { $set: { status: amount < payment.amount ? "partially_refunded" : "refunded", "audit.updatedBy": "system" } },
    );
  } else {
    // manual/invoice (posted, real GL revenue recognized) - external refund,
    // no Stripe API call. payoutMethod is a best-effort default (bank_transfer)
    // since events registrations don't currently record how a manual payment
    // was physically collected - finance can correct payoutMethod by hand if
    // the actual method differed.
    refundDoc = await deps.Refund.create({
      tenantId,
      paymentId: payment._id,
      mode: "external",
      ...(payment.memberId ? { memberId: payment.memberId } : {}),
      amount,
      currency: payment.currency,
      refundDate: new Date(),
      payoutMethod: "bank_transfer",
      memo: "Event cancelled - automatic refund",
      metadata,
    });

    await deps.Payment.updateOne(
      { _id: payment._id },
      { $set: { status: amount < payment.amount ? "partially_refunded" : "refunded", "audit.updatedBy": "system" } },
    );
  }

  const { glPosted, glDocNo } = await postEventCancellationRefundJournal({ refundDoc, payment, tenantId, deps });

  return { registrationId, refundId: refundDoc._id.toString(), glPosted, glDocNo };
}

/** Entry point for the events.event.cancelled.v1 RabbitMQ handler - refunds
 * every candidate independently so one bad candidate doesn't block the rest
 * (mirrors events-service's own per-registration try/catch loop in
 * cancelEvent). `deps` defaults to the real Payment/Refund/Stripe/journal
 * modules - only ever overridden in tests. */
export async function processEventCancellationRefunds(payload, deps = defaultDeps) {
  const data = payload?.data || payload;
  const { tenantId, eventId, refundCandidates } = data || {};
  if (!tenantId || !eventId || !Array.isArray(refundCandidates)) {
    deps.logger.warn({ payload: data }, "events.event.cancelled.v1: malformed payload - skipping");
    return { processed: 0, results: [] };
  }

  const results = [];
  for (const candidate of refundCandidates) {
    try {
      results.push(await refundOneCandidate({ tenantId, eventId, candidate, deps }));
    } catch (err) {
      deps.logger.error(
        { err, tenantId, eventId, registrationId: candidate?.registrationId },
        "Failed to process event cancellation refund candidate",
      );
      results.push({ registrationId: candidate?.registrationId, error: err.message });
    }
  }

  return { processed: results.length, results };
}
