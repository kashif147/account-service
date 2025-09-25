// src/routes/journal.routes.js
import express from "express";
import {
  invoiceRules,
  receiptRules,
  creditNoteRules,
  writeOffRules,
  changeCategoryRules,
  listJournalsRules,
  claimApplicationCreditRules,
} from "../validators/journal.validators.js";
import {
  invoice,
  creditNote,
  receipt,
  listJournals,
  claimApplicationCredit,
  writeOff,
  changeCategory,
} from "../controllers/journal.controller.js";
import validate from "../middlewares/validate.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";

const router = express.Router();

// Journals - list; single consolidated route with minimum AI role
router.get(
  "/",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listJournalsRules,
  listJournals
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

// Credit note creation - requires minimum Accounts Assistant level
router.post(
  "/credit-note",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  idempotency(),
  creditNoteRules,
  validate,
  creditNote
);

// Write-off operations - requires minimum Accounts Manager level (sensitive operation)
router.post(
  "/writeoff",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "write"),
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
