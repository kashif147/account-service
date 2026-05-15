import express from "express";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";
import validate from "../middlewares/validate.js";
import {
  createJournalAdjustmentRules,
  journalAdjustmentDocNoParam,
  listJournalAdjustmentRules,
  reconciliationSeedRules,
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
  seedReconciliationHandler,
  manualMatchHandler,
  suspenseHandler,
  settleReconciliationHandler,
} from "../controllers/reconciliation.controller.js";

const router = express.Router();

const financeWrite = defaultPolicyMiddleware.requirePermission(
  "accounts.admin",
  "write",
);
const financeRead = defaultPolicyMiddleware.requirePermission(
  "accounts.admin",
  "read",
);

router.post(
  "/journal-adjustments",
  ensureAuthenticated,
  financeWrite,
  idempotency(),
  createJournalAdjustmentRules,
  validate,
  createJournalAdjustment,
);

router.post(
  "/journal-adjustments/:docNo/approve",
  ensureAuthenticated,
  financeWrite,
  idempotency(),
  journalAdjustmentDocNoParam,
  validate,
  approveJournalAdjustmentHandler,
);

router.get(
  "/journal-adjustments",
  ensureAuthenticated,
  financeRead,
  listJournalAdjustmentRules,
  validate,
  listJournalAdjustmentsHandler,
);

router.get(
  "/reconciliation",
  ensureAuthenticated,
  financeRead,
  listReconciliationHandler,
);

router.post(
  "/reconciliation/seed",
  ensureAuthenticated,
  financeWrite,
  idempotency(),
  reconciliationSeedRules,
  validate,
  seedReconciliationHandler,
);

router.post(
  "/reconciliation/match",
  ensureAuthenticated,
  financeWrite,
  reconciliationMatchRules,
  validate,
  manualMatchHandler,
);

router.post(
  "/reconciliation/suspense",
  ensureAuthenticated,
  financeWrite,
  reconciliationSuspenseRules,
  validate,
  suspenseHandler,
);

router.post(
  "/reconciliation/:recordId/settle",
  ensureAuthenticated,
  financeWrite,
  settleReconciliationHandler,
);

export default router;
