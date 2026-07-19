// Segregated GL posting for events/courses registrations - kept separate from
// application.approval.listener.js (membership) so the mature membership
// posting functions there are never touched. Reuses the SAME account codes as
// membership for assets/clearing/liabilities (1210/1220 clearing, 1400 AR,
// 2020 Payment on Account, 4900 contra-income) - only a new Income code is
// introduced (4500, since 4000-4090 is reserved for membership categories).
// Segregation for reporting comes from the ledgerDomain field on Payment and
// on every GLTransaction entry, not from separate account codes.
import Product from "../models/product.model.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";
import { stripeFeeBreakdown } from "../helpers/fees.js";
import { publisher } from "../rabbitMQ/index.js";
import logger from "../config/logger.js";

const DEFAULT_EVENTS_INCOME_CODE = "4500";
const EVENTS_CLEARING_CODE_STRIPE = "1220";
const EVENTS_CLEARING_CODE_MANUAL = "1210";
const EVENTS_AR_CODE = "1400";
const EVENTS_POA_CODE = "2020";
const EVENTS_CONTRA_INCOME_CODE = "4900";

async function getIncomeCodeForEventProduct(productCode, tenantId) {
  if (productCode) {
    const product = await Product.findOne({
      tenantId,
      code: String(productCode).toUpperCase(),
      isDeleted: { $ne: true },
    }).lean();
    if (product?.incomeAccountCode) return product.incomeAccountCode;
  }
  return DEFAULT_EVENTS_INCOME_CODE;
}

async function publishPaymentStatusUpdated({ tenantId, paymentId, registrationId, status }) {
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

  const amount = payment.amount;
  const clearingCode = payment.mode === "stripe" ? EVENTS_CLEARING_CODE_STRIPE : EVENTS_CLEARING_CODE_MANUAL;
  const incomeCode = await getIncomeCodeForEventProduct(payment.productCode, payment.tenantId);
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
    tenantId: ctx?.tenantId || payment.tenantId,
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
    tenantId: ctx?.tenantId || payment.tenantId,
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
    tenantId: ctx?.tenantId || payment.tenantId,
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
    tenantId: ctx?.tenantId || payment.tenantId,
    paymentId: String(payment._id),
    registrationId: payment.registrationId,
    status: "succeeded",
  });

  return { ok: true };
}

/**
 * Posts a manual (comp/manual/invoice) events/courses payment directly to the
 * GL, without a Stripe charge. Called from the /api/journal/events/manual-payment
 * endpoint (registration.controller.js in events-service).
 */
export async function postManualEventPayment({
  tenantId,
  registrationId,
  profileId,
  memberId,
  productCode,
  amount,
  currency,
  method,
  userId,
}) {
  const Payment = (await import("../models/payment.model.js")).default;

  const purpose = "eventRegistration";
  const payment = await Payment.create({
    tenantId,
    purpose,
    ledgerDomain: "events",
    registrationId,
    profileId,
    ...(memberId ? { memberId } : {}),
    productCode,
    amount,
    currency: currency || "eur",
    status: method === "invoice" ? "payment_required" : "succeeded",
    mode: "external",
    source: "events-service",
    external: { externalRef: `manual-${method}-${registrationId}` },
    audit: { createdBy: userId || "system", updatedBy: userId || "system" },
  });

  if (amount <= 0) {
    // Nothing to post - events-service already confirms manual/comp/invoice
    // registrations synchronously, without waiting for a payment-status event.
    return { paymentId: payment._id.toString() };
  }

  const incomeCode = await getIncomeCodeForEventProduct(productCode, tenantId);
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

  // No payments.events.status.updated.v1 publish here - events-service already
  // confirms manual/comp/invoice registrations synchronously when it makes this
  // call; that event is only needed for the async Stripe webhook path above.
  return { paymentId: payment._id.toString() };
}
