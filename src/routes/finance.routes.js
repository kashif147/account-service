import express from "express";
import {
  ensureAuthenticated,
  ensureAuthenticatedWithTenantContext,
} from "../middlewares/auth.js";
import {
  requireFinanceRead,
  requireFinanceWrite,
} from "../middlewares/financePermission.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";
import validate from "../middlewares/validate.js";
import {
  createJournalAdjustmentRules,
  journalAdjustmentDocNoParam,
  listJournalAdjustmentRules,
  reconciliationSeedRules,
  reconciliationImportRules,
  reconciliationAutoMatchRules,
  reconciliationMatchRules,
  reconciliationSuspenseRules,
} from "../validators/journalAdjustment.validators.js";
import {
  createJournalAdjustment,
  approveJournalAdjustmentHandler,
  listJournalAdjustmentsHandler,
} from "../controllers/journalAdjustment.controller.js";
import {
  listReconciliationHandler,
  reconciliationDashboardHandler,
  seedReconciliationHandler,
  importBankReconciliationHandler,
  autoMatchReconciliationHandler,
  manualMatchHandler,
  suspenseHandler,
  settleReconciliationHandler,
} from "../controllers/reconciliation.controller.js";
import { profileMergeReassignHandler } from "../controllers/profileMerge.controller.js";

const router = express.Router();

router.post(
  "/journal-adjustments",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  idempotency(),
  createJournalAdjustmentRules,
  validate,
  createJournalAdjustment,
);

router.post(
  "/journal-adjustments/:docNo/approve",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  idempotency(),
  journalAdjustmentDocNoParam,
  validate,
  approveJournalAdjustmentHandler,
);

router.get(
  "/journal-adjustments",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceRead,
  listJournalAdjustmentRules,
  validate,
  listJournalAdjustmentsHandler,
);

router.get(
  "/reconciliation/dashboard",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceRead,
  reconciliationDashboardHandler,
);

router.get(
  "/reconciliation",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceRead,
  listReconciliationHandler,
);

router.post(
  "/reconciliation/seed",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  idempotency(),
  reconciliationSeedRules,
  validate,
  seedReconciliationHandler,
);

router.post(
  "/reconciliation/import",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  idempotency(),
  reconciliationImportRules,
  validate,
  importBankReconciliationHandler,
);

router.post(
  "/reconciliation/auto-match",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  idempotency(),
  reconciliationAutoMatchRules,
  validate,
  autoMatchReconciliationHandler,
);

router.post(
  "/reconciliation/match",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  reconciliationMatchRules,
  validate,
  manualMatchHandler,
);

router.post(
  "/reconciliation/suspense",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  reconciliationSuspenseRules,
  validate,
  suspenseHandler,
);

router.post(
  "/reconciliation/:recordId/settle",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  settleReconciliationHandler,
);

router.post(
  "/internal/profile-merge",
  ensureAuthenticated,
  requireFinanceWrite,
  profileMergeReassignHandler,
);

export default router;
