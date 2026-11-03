// Segregated GL posting for events/courses registrations - kept separate from
// application.approval.listener.js (membership) so the mature membership
// posting functions there are never touched. Reuses the SAME account codes as
// membership for assets/clearing/liabilities (1210/1220 clearing, 1400 AR,
// 2020 Payment on Account, 4900 contra-income) - only a new Income code is
// introduced (4500, since 4000-4090 is reserved for membership categories).
// Segregation for reporting comes from the ledgerDomain field on Payment and
// on every GLTransaction entry, not from separate account codes.
import { postBalancedJournal } from "../controllers/journal.controller.js";
import { stripeFeeBreakdown } from "../helpers/fees.js";
import { publisher } from "../rabbitMQ/index.js";
import logger from "../config/logger.js";
import { requireTenantId } from "../helpers/tenantScope.js";

const DEFAULT_EVENTS_INCOME_CODE = "4500";
const EVENTS_CLEARING_CODE_STRIPE = "1220";
const EVENTS_CLEARING_CODE_MANUAL = "1210";
const EVENTS_AR_CODE = "1400";
const EVENTS_POA_CODE = "2020";
const EVENTS_CONTRA_INCOME_CODE = "4900";

// user-service Lookup "Event Category" codes (LookupType EVTCAT) -> GL income
// account. Replaces the old Product.incomeAccountCode lookup entirely -
// account-service no longer needs the RabbitMQ-synced Product record to post
// events/courses revenue to the correct account.
const EVENT_INCOME_CODE_BY_CATEGORY = { CPD: "4510", EVENT: "4520" };

function resolveEventIncomeCode(eventCategoryCode) {
  return EVENT_INCOME_CODE_BY_CATEGORY[eventCategoryCode] || DEFAULT_EVENTS_INCOME_CODE;
}

export async function publishPaymentStatusUpdated({ tenantId, paymentId, registrationId, status }) {
  const result = await publisher.publish(
    "payments.events.status.updated.v1",
    { tenantId, paymentId, registrationId, status, ledgerDomain: "events" },
    {
      tenantId,
      exchange: "accounts.events",
      routingKey: "payments.events.status.updated.v1",
      metadata: { service: "account-service", version: "1.0" },
    },
  );
  if (!result.success) {
    logger.error(
      { paymentId, registrationId, status },
      "Failed to publish payments.events.status.updated.v1",
    );
  }
}

function baseEntryFields(payment) {
  return {
    registrationId: payment.registrationId,
    profileId: payment.profileId || undefined,
    memberId: payment.memberId || undefined,
    periodBucket: "current",
    ledgerDomain: "events",
  };
}

/**
 * Called from payments.service.js's postJournalForPayment() whenever a Stripe
 * payment with ledgerDomain="events" succeeds. There is no separate approval
 * step for events/courses (unlike membership applications), so receipt,
 * invoice and settlement all happen in this one call.
 */
export async function postJournalForEventPayment(payment, ctx) {
  if (!payment.registrationId) {
    logger.warn({ paymentId: payment._id }, "Events payment missing registrationId - skipping GL posting");
    return null;
  }

  // The payment row's tenant is authoritative; a differing caller tenant is refused.
  const tenantId = requireTenantId(payment.tenantId || ctx?.tenantId);
  if (ctx?.tenantId && String(ctx.tenantId) !== tenantId) {
    throw new Error("Event payment tenant does not match the posting context");
  }
  const amount = payment.amount;
  const clearingCode = payment.mode === "stripe" ? EVENTS_CLEARING_CODE_STRIPE : EVENTS_CLEARING_CODE_MANUAL;
  const incomeCode = resolveEventIncomeCode(payment.eventCategoryCode);
  const base = baseEntryFields(payment);
  const date = new Date().toISOString().split("T")[0];

  let settlement = null;
  const receiptLines = [
    { accountCode: clearingCode, dc: "D", amount, ...base },
    { accountCode: EVENTS_POA_CODE, dc: "C", amount, ...base },
  ];
  if (payment.mode === "stripe") {
    const { feeNoVat } = stripeFeeBreakdown(amount);
    receiptLines.push({ accountCode: "5100", dc: "D", amount: feeNoVat, ...base });
    receiptLines.push({ accountCode: clearingCode, dc: "C", amount: feeNoVat, ...base });
    settlement = { provider: "Stripe", status: "PENDING" };
  }

  await postBalancedJournal({
    date,
    tenantId,
    profileId: payment.profileId,
    docType: "Receipt",
    docNo: `RCP-EVT-${payment._id}`,
    memo: `Receipt (registration ${payment.registrationId})`,
    lines: receiptLines,
    settlement,
    operation: "events_receipt_posted",
  });

  await postBalancedJournal({
    date,
    tenantId,
    profileId: payment.profileId,
    docType: "Invoice",
    docNo: `INV-EVT-${payment.registrationId}`,
    memo: `Registration fee (registration ${payment.registrationId})`,
    lines: [
      { accountCode: EVENTS_AR_CODE, dc: "D", amount, ...base },
      { accountCode: incomeCode, dc: "C", amount, ...base },
    ],
    operation: "events_invoice_posted",
  });

  await postBalancedJournal({
    date,
    tenantId,
    profileId: payment.profileId,
    docType: "Claim",
    docNo: `CLAIM-EVT-${payment.registrationId}`,
    memo: `Settle registration fee from POA (registration ${payment.registrationId})`,
    lines: [
      { accountCode: EVENTS_POA_CODE, dc: "D", amount, ...base },
      { accountCode: EVENTS_AR_CODE, dc: "C", amount, ...base },
    ],
    operation: "events_settlement_posted",
  });

  await publishPaymentStatusUpdated({
    tenantId,
    paymentId: String(payment._id),
    registrationId: payment.registrationId,
    status: "succeeded",
  });

  return { ok: true };
}

/** Shared per-method GL posting, used by both the (legacy) immediate-post path
 * and the deferred post-at-approval path below - `payment` must already have
 * its final profileId/memberId set. */
async function postManualEventJournalEntries(payment, { tenantId, registrationId, method, amount, eventCategoryCode, profileId, memberId }) {
  const incomeCode = resolveEventIncomeCode(eventCategoryCode);
  const base = {
    registrationId,
    profileId: profileId || undefined,
    memberId: memberId || undefined,
    periodBucket: "current",
    ledgerDomain: "events",
  };
  const date = new Date().toISOString().split("T")[0];

  if (method === "manual") {
    // Money already received outside Stripe (cash/cheque/bank transfer) -
    // recognize revenue immediately, no outstanding AR.
    await postBalancedJournal({
      date,
      tenantId,
      profileId,
      docType: "Receipt",
      docNo: `RCP-EVT-MANUAL-${payment._id}`,
      memo: `Manual payment received (registration ${registrationId})`,
      lines: [
        { accountCode: EVENTS_CLEARING_CODE_MANUAL, dc: "D", amount, ...base },
        { accountCode: incomeCode, dc: "C", amount, ...base },
      ],
      operation: "events_manual_receipt_posted",
    });
  } else if (method === "invoice") {
    // Billed, not yet collected - outstanding receivable.
    await postBalancedJournal({
      date,
      tenantId,
      profileId,
      docType: "Invoice",
      docNo: `INV-EVT-${registrationId}`,
      memo: `Registration fee invoiced (registration ${registrationId})`,
      lines: [
        { accountCode: EVENTS_AR_CODE, dc: "D", amount, ...base },
        { accountCode: incomeCode, dc: "C", amount, ...base },
      ],
      operation: "events_invoice_posted",
    });
  } else if (method === "comp") {
    // Complimentary: recognize the full-price revenue, then write it off -
    // net-zero revenue with a full audit trail (mirrors membership's
    // adjustment/write-off pattern, reusing the same contra-income code).
    await postBalancedJournal({
      date,
      tenantId,
      profileId,
      docType: "Invoice",
      docNo: `INV-EVT-${registrationId}`,
      memo: `Registration fee (comp) (registration ${registrationId})`,
      lines: [
        { accountCode: EVENTS_AR_CODE, dc: "D", amount, ...base },
        { accountCode: incomeCode, dc: "C", amount, ...base },
      ],
      operation: "events_invoice_posted",
    });
    await postBalancedJournal({
      date,
      tenantId,
      profileId,
      docType: "WriteOff",
      docNo: `WOFF-EVT-${registrationId}`,
      memo: `Complimentary registration write-off (registration ${registrationId})`,
      lines: [
        { accountCode: EVENTS_CONTRA_INCOME_CODE, dc: "D", amount, ...base, adjSubType: "event-comp-writeoff" },
        { accountCode: EVENTS_AR_CODE, dc: "C", amount, ...base, adjSubType: "event-comp-writeoff" },
      ],
      operation: "events_comp_writeoff_posted",
    });
  }
}

const MANUAL_RECORD_KEY = (registrationId) => `acct:manual_record:${registrationId}`;

function recordedMethod(payment) {
  const m = /^manual-(manual|comp|invoice)-/.exec(String(payment?.external?.externalRef || ""));
  return m ? m[1] : null;
}

async function appError(status, code, message) {
  const { AppError } = await import("../errors/AppError.js");
  return new AppError(message, status, code);
}

async function pushBoundAudit(Payment, payment, bound, status) {
  if (!bound) return;
  const { boundAuditEntry } = await import("../services/paymentBoundCommand.service.js");
  await Payment.updateOne(
    { _id: payment._id, tenantId: payment.tenantId },
    {
      $push: { auditHistory: boundAuditEntry(bound.cmd, status) },
      $set: { "audit.updatedBy": `internal:${bound.cmd.actorUserId}` },
    },
  );
}

/**
 * Records a manual (comp/manual/invoice) events/courses payment. Called from
 * the /api/journal/events/manual-payment endpoint (events-service). Posting is
 * always deferred to CRM approval (postManualEventPaymentPost): this only creates the Payment
 * doc - no GL entry, no profileId required yet. (The old immediate-post branch had no caller and
 * is removed - P5.)
 *
 * P5: one active recorded payment per registration. The row carries a deterministic
 * idempotencyKey (unique per tenant), so a concurrent or repeated record of the same registration
 * cannot create a second row: an identical repeat (same amount / currency / method) returns the
 * existing payment, anything else is 409 ALREADY_RECORDED. Voiding frees the key.
 */
export async function postManualEventPayment({
  tenantId,
  registrationId,
  profileId,
  memberId,
  productCode,
  eventCategoryCode,
  amount,
  currency,
  method,
  userId,
  purpose = "eventRegistration",
  bound = null,
}) {
  const Payment = (await import("../models/payment.model.js")).default;
  const cur = String(currency || "eur").toLowerCase();

  const sameRecord = (p) =>
    p.mode === "external" && p.status === "manual_review" && Number(p.amount) === Number(amount) &&
    String(p.currency || "").toLowerCase() === cur && recordedMethod(p) === method;
  const existing = await Payment.find({
    tenantId,
    registrationId,
    isActiveAttempt: { $ne: false },
    status: { $in: ["manual_review", "processing", "requires_capture", "requires_action", "created", "payment_required", "succeeded"] },
  }).limit(2).lean();
  if (existing.length === 1 && sameRecord(existing[0])) {
    return { paymentId: existing[0]._id.toString(), alreadyRecorded: true };
  }
  if (existing.length) {
    throw await appError(409, "ALREADY_RECORDED", "A payment is already recorded for this registration");
  }

  let payment;
  try {
    payment = await Payment.create({
      tenantId,
      purpose,
      ledgerDomain: "events",
      registrationId,
      ...(profileId ? { profileId } : {}),
      ...(memberId ? { memberId } : {}),
      productCode,
      eventCategoryCode,
      amount,
      currency: cur,
      // "manual_review": nothing has been recognized in the GL yet, regardless of method
      // (Payment.status has no plain "pending" value) - awaiting the CRM approval step.
      status: "manual_review",
      mode: "external",
      source: "events-service",
      idempotencyKey: MANUAL_RECORD_KEY(registrationId),
      external: { externalRef: `manual-${method}-${registrationId}` },
      audit: {
        createdBy: bound ? `internal:${bound.cmd.actorUserId}` : userId || "system",
        updatedBy: bound ? `internal:${bound.cmd.actorUserId}` : userId || "system",
      },
    });
  } catch (e) {
    if (e?.code !== 11000) throw e;
    // Lost a concurrent record of the same registration: answer from the winner.
    const winner = await Payment.findOne({ tenantId, idempotencyKey: MANUAL_RECORD_KEY(registrationId) }).lean();
    if (winner && sameRecord(winner)) return { paymentId: winner._id.toString(), alreadyRecorded: true };
    throw await appError(409, "ALREADY_RECORDED", "A payment is already recorded for this registration");
  }
  await pushBoundAudit(Payment, payment, bound, "manual_review");
  return { paymentId: payment._id.toString() };
}

/**
 * Posts a previously-recorded manual events/courses payment to the GL, at CRM approval time,
 * once profileId is resolved.
 *
 * P5 transitions: manual_review -> processing (atomic claim, so two concurrent posts cannot both
 * post) -> succeeded | payment_required. Already posted -> 200 alreadyPosted (no-op). Voided ->
 * 409 ALREADY_VOIDED. The method must equal the recorded one. profileId / memberId are set once.
 * A GL failure releases the claim back to manual_review.
 */
export async function postManualEventPaymentPost({ tenantId, paymentId, method, profileId, memberId, userId, bound = null }) {
  const Payment = (await import("../models/payment.model.js")).default;

  const payment = await Payment.findOne({ _id: paymentId, tenantId });
  if (!payment) throw await appError(404, "PAYMENT_NOT_FOUND", "Payment not found");
  if (payment.mode !== "external") {
    throw await appError(409, "TRANSITION_NOT_ALLOWED", "This payment is not a manual payment");
  }
  const recorded = recordedMethod(payment);
  const postMethod = method || recorded;
  if (!postMethod || (recorded && postMethod !== recorded)) {
    throw await appError(409, "METHOD_MISMATCH", "method does not match the recorded payment");
  }
  if (payment.status === "succeeded" || payment.status === "payment_required") {
    return { paymentId: payment._id.toString(), alreadyPosted: true };
  }
  if (payment.status === "canceled") {
    throw await appError(409, "ALREADY_VOIDED", "This payment was voided and cannot be posted");
  }
  if (payment.status !== "manual_review") {
    throw await appError(409, "TRANSITION_NOT_ALLOWED", "This payment cannot be posted now");
  }

  // P5: profileId / memberId are set once - never overwritten from the request body
  // (409 PROFILE_ALREADY_BOUND, nothing posted).
  const { setPaymentLinkOnce } = await import("../services/payments.service.js");
  await setPaymentLinkOnce(payment, { profileId, memberId });
  if (!payment.profileId) throw await appError(400, "PROFILE_REQUIRED", "profileId is required to post");

  const actor = bound ? `internal:${bound.cmd.actorUserId}` : userId || "system";
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, tenantId, status: "manual_review" },
    { $set: { status: "processing", "audit.updatedBy": actor } },
    { new: true },
  );
  if (!claimed) {
    const now = await Payment.findOne({ _id: payment._id, tenantId }).lean();
    if (now && (now.status === "succeeded" || now.status === "payment_required")) {
      return { paymentId: payment._id.toString(), alreadyPosted: true };
    }
    throw await appError(409, "TRANSITION_NOT_ALLOWED", "This payment is being changed by another request");
  }

  try {
    if (claimed.amount > 0) {
      await postManualEventJournalEntries(claimed, {
        tenantId,
        registrationId: claimed.registrationId,
        method: postMethod,
        amount: claimed.amount,
        eventCategoryCode: claimed.eventCategoryCode,
        profileId: claimed.profileId,
        memberId: claimed.memberId,
      });
    }
  } catch (e) {
    await Payment.updateOne({ _id: claimed._id, tenantId, status: "processing" }, { $set: { status: "manual_review" } });
    throw e;
  }

  const finalStatus = postMethod === "invoice" ? "payment_required" : "succeeded";
  await Payment.updateOne({ _id: claimed._id, tenantId, status: "processing" }, { $set: { status: finalStatus } });
  await pushBoundAudit(Payment, claimed, bound, finalStatus);
  return { paymentId: payment._id.toString() };
}

/**
 * Voids a recorded-but-not-yet-posted manual/comp/invoice event payment. Nothing was posted to
 * the GL for a "manual_review" Payment, so this is a conditional status flip.
 * P5: voided again -> 200 alreadyVoided; posted -> 409 ALREADY_POSTED (a posted GL needs a
 * reversal, never a void); being posted -> 409. Frees the registration's record key.
 */
export async function voidManualEventPayment({ tenantId, paymentId, userId, bound = null }) {
  const Payment = (await import("../models/payment.model.js")).default;

  const payment = await Payment.findOne({ _id: paymentId, tenantId }).lean();
  if (!payment) throw await appError(404, "PAYMENT_NOT_FOUND", "Payment not found");
  if (payment.mode !== "external") {
    throw await appError(409, "TRANSITION_NOT_ALLOWED", "This payment is not a manual payment");
  }
  const actor = bound ? `internal:${bound.cmd.actorUserId}` : userId || "system";
  const voided = await Payment.findOneAndUpdate(
    { _id: payment._id, tenantId, status: "manual_review" },
    { $set: { status: "canceled", "audit.updatedBy": actor }, $unset: { idempotencyKey: "" } },
    { new: true },
  );
  if (voided) {
    await pushBoundAudit(Payment, voided, bound, "canceled");
    return { paymentId: payment._id.toString(), voided: true };
  }
  const now = await Payment.findOne({ _id: payment._id, tenantId }).lean();
  if (now?.status === "canceled") return { paymentId: payment._id.toString(), voided: false, alreadyVoided: true };
  if (now?.status === "succeeded" || now?.status === "payment_required") {
    throw await appError(409, "ALREADY_POSTED", "This payment was already posted; it needs a reversal, not a void");
  }
  throw await appError(409, "TRANSITION_NOT_ALLOWED", "This payment cannot be voided now");
}
