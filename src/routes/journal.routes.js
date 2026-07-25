// src/routes/journal.routes.js
import express from "express";
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
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { requireFinanceWrite } from "../middlewares/financePermission.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";
import { forwardedInternalContext } from "../middlewares/context.js";
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

// Journals - list; single consolidated route with minimum AI role
router.get(
  "/",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listJournalsRules,
  listJournals
);

// Stripe receipts - list by settlement status
router.get(
  "/stripe-payments",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listStripePaymentsRules,
  listStripePayments
);

// POST operations with idempotency for data consistency
// Invoice creation - requires minimum Accounts Assistant level
router.post(
  "/invoice",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  invoiceRules,
  validate,
  invoice
);

// Receipt processing - requires minimum Accounts Assistant level
router.post(
  "/receipt",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  receiptRules,
  validate,
  receipt
);

// Credit notes — Draft on create; GL posts on approve
router.post(
  "/credit-notes",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  requireFinanceWrite,
  idempotency(),
  createCreditNoteRules,
  validate,
  createCreditNote,
);

router.get(
  "/credit-notes",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listCreditNotesRules,
  validate,
  listCreditNotesHandler,
);

router.get(
  "/credit-notes/:docNo",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  creditNoteDocNoParam,
  validate,
  getCreditNoteHandler,
);

router.post(
  "/credit-notes/:docNo/approve",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  creditNoteDocNoParam,
  validate,
  approveCreditNoteHandler,
);

router.post(
  "/credit-notes/:docNo/cancel",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  creditNoteDocNoParam,
  validate,
  cancelCreditNoteHandler,
);

/** @deprecated Use POST /credit-notes (draft) + POST /credit-notes/:docNo/approve */
router.post(
  "/credit-note",
  ensureAuthenticated,
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
  ensureAuthenticated,
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
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  idempotency(),
  changeCategoryRules,
  validate,
  changeCategory
);

// Process batch - called by profile-service with body { paymentDate, batchPayments }; creates GL Receipts for each row
router.post(
  "/process-batch",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  processDeductionBatchRules,
  validate,
  processDeductionBatch
);

router.post(
  "/apply-member-credit",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  requireFinanceWrite,
  idempotency(),
  applyMemberCreditRules,
  validate,
  applyMemberCreditHandler,
);

router.post(
  "/reverse-receipt",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  reverseReceiptRules,
  validate,
  reverseReceiptHandler,
);

router.post(
  "/reverse-writeoff",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  requireFinanceWrite,
  idempotency(),
  reverseWriteOffRules,
  validate,
  reverseWriteOffHandler,
);

router.post(
  "/reassign-payments",
  ensureAuthenticated,
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
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
  idempotency(),
  claimApplicationCreditRules,
  validate,
  claimApplicationCredit
);

// Events/courses manual (comp/manual/invoice) payment posting - called by
// events-service, forwarding the original caller's gateway headers (same
// pattern as internal.routes.js and profile-service's account.service.client.js)
router.post(
  "/events/manual-payment",
  internalOrAuthenticated,
  idempotency(),
  postManualEventPaymentHandler,
);

// Posts a previously-recorded (deferPosting:true) manual event payment to the
// GL at CRM approval time, once profileId is resolved - see
// events-service's /registrations/:id/approve.
router.post(
  "/events/manual-payment/post",
  internalOrAuthenticated,
  idempotency(),
  postManualEventPaymentPostHandler,
);

// Voids a recorded-but-unposted manual event payment on CRM rejection - see
// events-service's /registrations/:id/reject.
router.post(
  "/events/manual-payment/void",
  internalOrAuthenticated,
  idempotency(),
  voidManualEventPaymentHandler,
);

// Online payment processing - allows MEMBER role for portal users
router.post(
  "/online-payment",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  receiptRules, // Using receipt rules for payment processing
  validate,
  receipt // Using receipt controller for payment processing
);

export default router;
