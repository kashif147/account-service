// src/routes/journal.routes.js
import express from "express";
import { createManualPaymentServiceAuth } from "../middlewares/serviceAuth.middleware.js";
import {
  invoiceRules,
  receiptRules,
  writeOffRules,
  changeCategoryRules,
  listJournalsRules,
  listStripePaymentsRules,
  claimApplicationCreditRules,
  processDeductionBatchRules,
  applyMemberCreditRules,
  reverseReceiptRules,
  reverseWriteOffRules,
  reassignPaymentsRules,
} from "../validators/journal.validators.js";
import {
  applyMemberCreditHandler,
  reverseReceiptHandler,
  reverseWriteOffHandler,
} from "../controllers/memberCreditOperations.controller.js";
import { reassignPaymentsHandler } from "../controllers/paymentReassignment.controller.js";
import {
  invoice,
  receipt,
  listJournals,
  listStripePayments,
  claimApplicationCredit,
  processDeductionBatch,
  writeOff,
  changeCategory,
} from "../controllers/journal.controller.js";
import {
  createCreditNoteRules,
  creditNoteDocNoParam,
  listCreditNotesRules,
} from "../validators/creditNote.validators.js";
import {
  createCreditNote,
  approveCreditNoteHandler,
  cancelCreditNoteHandler,
  getCreditNoteHandler,
  listCreditNotesHandler,
} from "../controllers/creditNote.controller.js";
import validate from "../middlewares/validate.js";
import {
  ensureAuthenticated,
  ensureAuthenticatedWithTenantContext,
} from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { requireFinanceWrite } from "../middlewares/financePermission.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";
import { forwardedInternalContext } from "../middlewares/context.js";
import {
  requireCrmUser,
  requireInternalOrCrm,
} from "../middlewares/callerScope.middleware.js";
import { createRequirePaymentMutationAuthority, rejectMixedInternalIdentity } from "../middlewares/paymentMutationAuthority.middleware.js";
import { AppError } from "../errors/AppError.js";
import {
  postManualEventPaymentHandler,
  postManualEventPaymentPostHandler,
  voidManualEventPaymentHandler,
} from "../controllers/eventJournal.controller.js";

const router = express.Router();

// Same pattern as internal.routes.js: forwarded JWT/gateway headers (the
// normal case - events-service forwards the original caller's auth) or, if
// there's no originating user request, x-internal-request + x-tenant-id.
function internalOrAuthenticated(req, res, next) {
  if (req.headers.authorization || req.headers["x-jwt-verified"]) {
    return ensureAuthenticated(req, res, next);
  }
  if (req.header("x-internal-request") === "true") {
    return forwardedInternalContext(req, res, next);
  }
  return res.appError(AppError.unauthorized("Authorization header required"));
}

// P5: journal / credit-note reads are CRM finance screens only (Write-offs summary, Online
// Payments grid, Credit Notes summary, member finance tab). No portal flow reads them - a
// member reads their own account via /reports/member/:memberId/statement | net-balance -
// so requireCrmUser (403 CRM_ONLY) runs before the PDP: a PORTAL token holding
// accounts.journals:read never reaches tenant-wide journal data.

// Journals - list; single consolidated route with minimum AI role
router.get(
  "/",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listJournalsRules,
  listJournals
);

// Stripe receipts - list by settlement status
router.get(
  "/stripe-payments",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listStripePaymentsRules,
  listStripePayments
);

// POST operations with idempotency for data consistency
// Invoice creation - requires minimum Accounts Assistant level
router.post(
  "/invoice",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  invoiceRules,
  validate,
  invoice
);

// Receipt processing - requires minimum Accounts Assistant level
router.post(
  "/receipt",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  receiptRules,
  validate,
  receipt
);

// Credit notes — Draft on create; GL posts on approve
router.post(
  "/credit-notes",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  requireFinanceWrite,
  idempotency(),
  createCreditNoteRules,
  validate,
  createCreditNote,
);

router.get(
  "/credit-notes",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listCreditNotesRules,
  validate,
  listCreditNotesHandler,
);

router.get(
  "/credit-notes/:docNo",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  creditNoteDocNoParam,
  validate,
  getCreditNoteHandler,
);

router.post(
  "/credit-notes/:docNo/approve",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  creditNoteDocNoParam,
  validate,
  approveCreditNoteHandler,
);

router.post(
  "/credit-notes/:docNo/cancel",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  creditNoteDocNoParam,
  validate,
  cancelCreditNoteHandler,
);

/** @deprecated Use POST /credit-notes (draft) + POST /credit-notes/:docNo/approve */
router.post(
  "/credit-note",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  requireFinanceWrite,
  idempotency(),
  createCreditNoteRules,
  validate,
  createCreditNote,
);

// Write-off operations - requires minimum Accounts Manager level (sensitive operation)
router.post(
  "/writeoff",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  writeOffRules,
  validate,
  writeOff
);

// Category changes - requires minimum Accounts Manager level (sensitive operation)
router.post(
  "/change-category",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  idempotency(),
  changeCategoryRules,
  validate,
  changeCategory
);

// Process batch - called by profile-service with body { paymentDate, batchPayments }; creates GL Receipts for each row
router.post(
  "/process-batch",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  processDeductionBatchRules,
  validate,
  processDeductionBatch
);

router.post(
  "/apply-member-credit",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  requireFinanceWrite,
  idempotency(),
  applyMemberCreditRules,
  validate,
  applyMemberCreditHandler,
);

router.post(
  "/reverse-receipt",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  reverseReceiptRules,
  validate,
  reverseReceiptHandler,
);

router.post(
  "/reverse-writeoff",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  reverseWriteOffRules,
  validate,
  reverseWriteOffHandler,
);

router.post(
  "/reassign-payments",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  reassignPaymentsRules,
  validate,
  reassignPaymentsHandler,
);

// Claim application credit - requires minimum Membership Officer level
router.post(
  "/claim-credit",
  ...ensureAuthenticatedWithTenantContext,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  idempotency(),
  claimApplicationCreditRules,
  validate,
  claimApplicationCredit
);

// P5: the three /events/manual-payment routes are internal S2S or CRM staff only. P5 containment:
// CRM callers also need the exact events business permission (events:create to record,
// events:write to post / void) - never payments:write; see paymentMutationAuthority.middleware.js. The
// caller is events-service forwarding the originating user's identity: CRM event staff
// (Add Attendee comp/manual/invoice, approve, reject), already gated there by the events PDP
// permission. A PORTAL member never records, posts or voids a manual event payment.
// A cached manual-record response is replayed only while that payment is still the live record
// (P5 record -> void -> record: after a void inside the cache window the next record is processed
// fresh and creates a new manual_review record instead of replaying the voided id).
const LIVE_RECORD_STATUSES = new Set(["manual_review", "processing", "succeeded", "payment_required"]);
async function manualRecordStillLive(cached, req) {
  const paymentId = cached?.body?.data?.paymentId;
  const tenantId = req.ctx?.tenantId || req.tenantId;
  if (!paymentId || !tenantId) return false;
  const Payment = (await import("../models/payment.model.js")).default;
  const row = await Payment.findOne({ _id: paymentId, tenantId }).select({ status: 1 }).lean();
  return Boolean(row && LIVE_RECORD_STATUSES.has(row.status));
}

// P5 S3: signed service authority on the three manual-payment routes (report/enforce per
// PAYMENT_SERVICE_AUTH_MODE, default off) - registered before each route's own chain, so it runs first.
router.use("/events", createManualPaymentServiceAuth());

// Events/courses manual (comp/manual/invoice) payment posting - called by
// events-service, forwarding the original caller's gateway headers (same
// pattern as internal.routes.js and profile-service's account.service.client.js)
router.post(
  "/events/manual-payment",
  rejectMixedInternalIdentity,
  internalOrAuthenticated,
  requireInternalOrCrm,
  createRequirePaymentMutationAuthority("manual_record"),
  idempotency({ bindBody: true, revalidate: manualRecordStillLive }),
  postManualEventPaymentHandler,
);

// Posts a previously-recorded (deferPosting:true) manual event payment to the
// GL at CRM approval time, once profileId is resolved - see
// events-service's /registrations/:id/approve.
router.post(
  "/events/manual-payment/post",
  rejectMixedInternalIdentity,
  internalOrAuthenticated,
  requireInternalOrCrm,
  createRequirePaymentMutationAuthority("manual_post"),
  idempotency({ bindBody: true }),
  postManualEventPaymentPostHandler,
);

// Voids a recorded-but-unposted manual event payment on CRM rejection - see
// events-service's /registrations/:id/reject.
router.post(
  "/events/manual-payment/void",
  rejectMixedInternalIdentity,
  internalOrAuthenticated,
  requireInternalOrCrm,
  createRequirePaymentMutationAuthority("manual_void"),
  idempotency({ bindBody: true }),
  voidManualEventPaymentHandler,
);

// Manual GL receipt for an online payment (same controller as /receipt). P5: CRM finance
// staff only. Nothing calls this route - no service, CRM screen or portal flow; online card
// receipts are posted by payments.service (online_payment_receipt) on Stripe capture - so a
// PORTAL member (whatever permissions the token carries) and an unknown userType are denied
// by caller class BEFORE the PDP, and a bare x-internal-request is not accepted (401). The
// ledger tenant is the authenticated req.ctx tenant only (requireTenantId), never the body.
router.post(
  "/online-payment",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  receiptRules, // Using receipt rules for payment processing
  validate,
  receipt // Using receipt controller for payment processing
);

export default router;
