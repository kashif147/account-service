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
import RefundOperation from "../models/refundOperation.model.js";
import MemberRefundReservation from "../models/memberRefundReservation.model.js";
import {
  executeOperation,
  finalizeOperation,
  freePaymentAmount,
  postReversalOfJournal,
  registerRefundOperationSource,
  startOperation,
} from "./refundOperations.service.js";

const EVENTS_CLEARING_CODE_STRIPE = "1220";
const EVENTS_CLEARING_CODE_MANUAL = "1210";
const DEFAULT_EVENTS_INCOME_CODE = "4500";
const EVENT_INCOME_CODE_BY_CATEGORY = { CPD: "4510", EVENT: "4520" };

// Real dependencies for production use - tests inject fakes for these via
// processEventCancellationRefunds's second argument instead of ESM module
// mocking (jest.unstable_mockModule isn't available on the jest version
// installed here - see eventCancellationRefund.service.test.js).
// RefundOperation / MemberRefundReservation: the shared P5 refund operation + reservation
// mechanism (services/refundOperations.service.js) - the same payment counters as CRM refunds.
const defaultDeps = { Payment, Refund, RefundOperation, MemberRefundReservation, getStripe, postBalancedJournal, logger };

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
      await deps.Refund.updateOne({ _id: refundDoc._id, tenantId }, { $set: { glDocNo: journal.docNo, glStatus: "posted" } });
      return { glPosted: true, glDocNo: journal.docNo };
    }
    await deps.Refund.updateOne({ _id: refundDoc._id, tenantId }, { $set: { glStatus: "gl_failed" } });
    return { glPosted: false, glDocNo: null };
  } catch (err) {
    deps.logger.error({ err, docNo, refundId: String(refundDoc._id) }, "postEventCancellationRefundJournal failed");
    await deps.Refund.updateOne({ _id: refundDoc._id, tenantId }, { $set: { glStatus: "gl_failed" } }).catch(() => {});
    return { glPosted: false, glDocNo: null };
  }
}

/** One refund candidate from events.event.cancelled.v1's payload - see
 * event.lifecycle.publisher.js on the events-service side for the shape. */
function metadataValue(metadata, key) {
  if (!metadata) return undefined;
  if (typeof metadata.get === "function") return metadata.get(key);
  return metadata[key];
}

const EVENT_PURPOSES = new Set(["eventRegistration", "courseRegistration"]);

/** Sum of every refund already recorded against this payment (any reason). */
async function sumAlreadyRefunded({ tenantId, paymentId, deps }) {
  const agg = await deps.Refund.aggregate([
    { $match: { tenantId, paymentId, reversedAt: { $exists: false } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return Number(agg?.[0]?.total) || 0;
}

/**
 * The message body is not trusted: the candidate's paymentId must resolve to a Payment in
 * the envelope tenant that belongs to THIS cancelled event's registration (Payment
 * registrationId — and metadata eventId / stripe PaymentIntent when recorded — must match).
 * Returns a skip reason, or null when the payment is a valid refund target.
 */
function paymentMismatchReason({ payment, candidate, eventId }) {
  const registrationId = candidate.registrationId != null ? String(candidate.registrationId) : "";
  if (!EVENT_PURPOSES.has(payment.purpose) && payment.ledgerDomain !== "events") {
    return "payment_not_event_registration";
  }
  if (!registrationId || !payment.registrationId || String(payment.registrationId) !== registrationId) {
    return "registration_mismatch";
  }
  const paidEventId = metadataValue(payment.metadata, "eventId");
  if (paidEventId != null && String(paidEventId) !== String(eventId)) {
    return "event_mismatch";
  }
  const candidatePi = candidate.stripePaymentIntentId;
  if (candidatePi && payment.stripe?.paymentIntentId && String(candidatePi) !== String(payment.stripe.paymentIntentId)) {
    return "payment_intent_mismatch";
  }
  return null;
}

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

  const mismatch = paymentMismatchReason({ payment, candidate, eventId });
  if (mismatch) {
    deps.logger.warn(
      { tenantId, eventId, registrationId, paymentId, reason: mismatch },
      "Event cancellation refund: payment does not belong to this event registration - skipping",
    );
    return { registrationId, skipped: true, reason: mismatch };
  }

  // Cap at what was actually captured and not yet refunded. The payload's candidate.amount
  // is never used as the refund amount.
  const alreadyRefunded = await sumAlreadyRefunded({ tenantId, paymentId: payment._id, deps });
  const amount = Math.max(0, (Number(payment.amount) || 0) - alreadyRefunded);
  if (amount <= 0) {
    deps.logger.warn(
      { tenantId, eventId, registrationId, paymentId, alreadyRefunded },
      "Event cancellation refund: nothing left to refund on this payment - skipping",
    );
    return { registrationId, skipped: true, reason: "nothing_to_refund" };
  }
  if (candidate.amount != null && Number(candidate.amount) !== amount) {
    deps.logger.warn(
      { tenantId, eventId, registrationId, paymentId, candidateAmount: candidate.amount, refundAmount: amount },
      "Event cancellation refund: payload amount differs from refundable captured amount - using captured amount",
    );
  }
  const isStripe = payment.mode === "stripe";
  if (isStripe && !payment.stripe?.paymentIntentId) {
    deps.logger.warn(
      { tenantId, eventId, registrationId, paymentId },
      "Stripe payment missing paymentIntentId - skipping refund",
    );
    return { registrationId, skipped: true, reason: "missing_payment_intent" };
  }

  // Same payment counters as CRM refunds: only the amount not committed or reserved by another
  // in-flight refund is refundable here, and the reservation below makes that atomic.
  const free = await freePaymentAmount(deps, payment);
  const refundAmount = Math.min(amount, free);
  if (refundAmount <= 0) {
    deps.logger.warn(
      { tenantId, eventId, registrationId, paymentId, alreadyRefunded },
      "Event cancellation refund: remaining amount is held by another refund in progress - skipping",
    );
    return { registrationId, skipped: true, reason: "refund_in_progress" };
  }

  const started = await startOperation(deps, {
    tenantId,
    source: "event_cancellation",
    flow: "E",
    mode: isStripe ? "stripe" : "external",
    payment,
    amount: refundAmount,
    currency: payment.currency,
    // One automatic cancellation refund per payment (durable dedupe across redeliveries).
    clientKey: `event-cancel:${payment._id}`,
    stripeParams: isStripe ? { payment_intent: payment.stripe.paymentIntentId, metadata: { eventId: String(eventId), registrationId: String(registrationId) } } : null,
    refundTemplate: {
      ...(payment.memberId ? { memberId: payment.memberId } : {}),
      refundDate: new Date(),
      memo: "Event cancelled - automatic refund",
      ...(isStripe ? {} : { payoutMethod: "bank_transfer" }),
      metadata: { reason: "event_cancellation", eventId: String(eventId), registrationId: String(registrationId) },
    },
    createdBy: "system",
  });
  if (started.existing) {
    if (started.existing.state === "succeeded") {
      await finalizeOperation(deps, started.existing._id, tenantId);
      return { registrationId, skipped: true, reason: "already_refunded" };
    }
    return { registrationId, skipped: true, reason: started.existing.state === "failed" ? "previous_attempt_failed" : "refund_in_progress" };
  }
  const result = await executeOperation(deps, started.op, started.token);
  return { registrationId, refundId: result.refundDocId, glPosted: result.glPosted, glDocNo: result.glDocNo };
}

registerRefundOperationSource("event_cancellation", {
  async postReversalGl(op, refundDoc, refund, deps) {
    const d = deps?.postBalancedJournal ? deps : defaultDeps;
    const GL = (await import("../models/glTransaction.model.js")).default;
    return postReversalOfJournal({
      tenantId: op.tenantId,
      originalDocNo: refundDoc.glDocNo,
      reversalDocNo: `${refundDoc.glDocNo}-REV`,
      memo: `Reversal of ${refundDoc.glDocNo}: provider refund ${refund.id} ${refund.status}`,
      postBalancedJournal: d.postBalancedJournal,
      GL,
    });
  },
  buildRefundDoc(op) {
    const t = op.refundTemplate || {};
    return {
      ...t,
      tenantId: op.tenantId,
      paymentId: op.paymentId,
      refundOperationId: op._id,
      mode: op.mode,
      amount: op.amount,
      currency: op.currency,
      metadata: new Map(Object.entries(t.metadata || {})),
      ...(op.mode === "stripe"
        ? { stripe: { refundId: op.stripeRefundId, ...(op.stripeChargeId ? { chargeId: op.stripeChargeId } : {}), paymentIntentId: op.stripeParams?.payment_intent } }
        : {}),
    };
  },
  async postGl(op, refundDoc, deps) {
    const d = deps?.postBalancedJournal ? deps : defaultDeps;
    const payment = await d.Payment.findOne({ _id: op.paymentId, tenantId: op.tenantId });
    return postEventCancellationRefundJournal({ refundDoc, payment: payment || {}, tenantId: op.tenantId, deps: d });
  },
  result(op, refundDoc, gl) {
    return { refundDocId: String(refundDoc._id), glPosted: Boolean(gl.glPosted), glDocNo: gl.glDocNo || null, operationId: String(op._id) };
  },
});

/** Entry point for the events.event.cancelled.v1 RabbitMQ handler - refunds
 * every candidate independently so one bad candidate doesn't block the rest
 * (mirrors events-service's own per-registration try/catch loop in
 * cancelEvent). `deps` defaults to the real Payment/Refund/Stripe/journal
 * modules - only ever overridden in tests. */
export async function processEventCancellationRefunds(payload, deps = defaultDeps) {
  const data = payload?.data || {};
  const { eventId, refundCandidates } = data;
  // Envelope tenant (set by rabbitmq-middleware from the producer's options.tenantId) is
  // required and authoritative; a data.tenantId that disagrees means the message is not
  // trustworthy, so nothing is refunded.
  const envelopeTenantId =
    payload?.data && payload?.tenantId != null && String(payload.tenantId).trim() !== ""
      ? String(payload.tenantId).trim()
      : null;
  const dataTenantId = data.tenantId != null ? String(data.tenantId).trim() : null;
  if (!envelopeTenantId || !eventId || !Array.isArray(refundCandidates)) {
    deps.logger.warn(
      { eventId, hasEnvelopeTenant: !!envelopeTenantId, eventMessageId: payload?.eventId },
      "events.event.cancelled.v1: malformed payload or missing envelope tenant - skipping",
    );
    return { processed: 0, results: [] };
  }
  if (dataTenantId && dataTenantId !== envelopeTenantId) {
    deps.logger.error(
      { eventId, envelopeTenantId, dataTenantId, eventMessageId: payload?.eventId },
      "events.event.cancelled.v1: data.tenantId does not match envelope tenant - refusing all refunds",
    );
    return { processed: 0, results: [], rejected: "tenant_mismatch" };
  }
  const tenantId = envelopeTenantId;

  const results = [];
  for (const candidate of refundCandidates) {
    try {
      results.push(await refundOneCandidate({ tenantId, eventId, candidate, deps }));
    } catch (err) {
      deps.logger.error(
        { err, tenantId, eventId, registrationId: candidate?.registrationId },
        "Failed to process event cancellation refund candidate",
      );
      results.push({ registrationId: candidate?.registrationId, error: "refund_failed" });
    }
  }

  return { processed: results.length, results };
}

/**
 * GL for an events-domain Stripe refund made outside the API (observed by the webhook): the same
 * reversal shape as an automatic cancellation refund (DR income / CR clearing), so the event
 * payment's recognised revenue is not overstated.
 */
export async function postEventRefundJournalForObserved(refundDoc, payment) {
  return postEventCancellationRefundJournal({ refundDoc, payment, tenantId: refundDoc.tenantId, deps: defaultDeps });
}
