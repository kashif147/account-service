import express from "express";
import { ensureAuthenticated } from "../middlewares/auth.js";
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

const router = express.Router();

router.post(
  "/journal-adjustments",
  ensureAuthenticated,
  requireFinanceWrite,
  idempotency(),
  createJournalAdjustmentRules,
  validate,
  createJournalAdjustment,
);

router.post(
  "/journal-adjustments/:docNo/approve",
  ensureAuthenticated,
  requireFinanceWrite,
  idempotency(),
  journalAdjustmentDocNoParam,
  validate,
  approveJournalAdjustmentHandler,
);

router.get(
  "/journal-adjustments",
  ensureAuthenticated,
  requireFinanceRead,
  listJournalAdjustmentRules,
  validate,
  listJournalAdjustmentsHandler,
);

router.get(
  "/reconciliation/dashboard",
  ensureAuthenticated,
  requireFinanceRead,
  reconciliationDashboardHandler,
);

router.get(
  "/reconciliation",
  ensureAuthenticated,
  requireFinanceRead,
  listReconciliationHandler,
);

router.post(
  "/reconciliation/seed",
  ensureAuthenticated,
  requireFinanceWrite,
  idempotency(),
  reconciliationSeedRules,
  validate,
  seedReconciliationHandler,
);

router.post(
  "/reconciliation/import",
  ensureAuthenticated,
  requireFinanceWrite,
  idempotency(),
  reconciliationImportRules,
  validate,
  importBankReconciliationHandler,
);

router.post(
  "/reconciliation/auto-match",
  ensureAuthenticated,
  requireFinanceWrite,
  idempotency(),
  reconciliationAutoMatchRules,
  validate,
  autoMatchReconciliationHandler,
);

router.post(
  "/reconciliation/match",
  ensureAuthenticated,
  requireFinanceWrite,
  reconciliationMatchRules,
  validate,
  manualMatchHandler,
);

router.post(
  "/reconciliation/suspense",
  ensureAuthenticated,
  requireFinanceWrite,
  reconciliationSuspenseRules,
  validate,
  suspenseHandler,
);

router.post(
  "/reconciliation/:recordId/settle",
  ensureAuthenticated,
  requireFinanceWrite,
  settleReconciliationHandler,
);

export default router;
