import express from "express";
import { ensureAuthenticated } from "../middlewares/auth.js";
import {
  requireFinanceRead,
  requireFinanceWrite,
} from "../middlewares/financePermission.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";
import validate from "../middlewares/validate.js";
import {
  approveRunRules,
  cancelRunRules,
  createDirectDebitRunRules,
  importPain002Rules,
  listItemsRules,
  listRunsRules,
  markSubmittedRules,
  runIdParam,
} from "../validators/directDebitRun.validators.js";
import {
  approveRun,
  cancelRun,
  createRun,
  deleteRun,
  downloadPain008,
  generatePain008,
  getRun,
  importPain002,
  listItems,
  listRuns,
  markSubmitted,
  prepareRun,
  validateRun,
} from "../controllers/directDebitRun.controller.js";

const router = express.Router();

router.use(ensureAuthenticated);

router.post(
  "/",
  requireFinanceWrite,
  idempotency(),
  createDirectDebitRunRules,
  validate,
  createRun,
);

router.get("/", requireFinanceRead, listRunsRules, validate, listRuns);

router.get("/:id", requireFinanceRead, runIdParam, validate, getRun);

router.get("/:id/items", requireFinanceRead, listItemsRules, validate, listItems);

router.get("/:id/download-pain008", requireFinanceRead, runIdParam, validate, downloadPain008);

router.post(
  "/:id/prepare",
  requireFinanceWrite,
  idempotency(),
  runIdParam,
  validate,
  prepareRun,
);

router.post(
  "/:id/validate",
  requireFinanceWrite,
  idempotency(),
  runIdParam,
  validate,
  validateRun,
);

router.post(
  "/:id/approve",
  requireFinanceWrite,
  idempotency(),
  approveRunRules,
  validate,
  approveRun,
);

router.post(
  "/:id/generate-pain008",
  requireFinanceWrite,
  idempotency(),
  runIdParam,
  validate,
  generatePain008,
);

router.post(
  "/:id/mark-submitted",
  requireFinanceWrite,
  idempotency(),
  markSubmittedRules,
  validate,
  markSubmitted,
);

router.post(
  "/:id/cancel",
  requireFinanceWrite,
  idempotency(),
  cancelRunRules,
  validate,
  cancelRun,
);

router.delete(
  "/:id",
  requireFinanceWrite,
  idempotency(),
  runIdParam,
  validate,
  deleteRun,
);

router.post(
  "/:id/import-pain002",
  requireFinanceWrite,
  idempotency(),
  importPain002Rules,
  validate,
  importPain002,
);

export default router;
