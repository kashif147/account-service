import express from "express";
import { ensureAuthenticated, tenantContextWarn } from "../middlewares/auth.js";
import {
  requireCrmStaff,
  requireFinanceRead,
  requireFinanceWrite,
} from "../middlewares/financePermission.middleware.js";
import { requireBankDataRead } from "../helpers/bankDataAccess.js";
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
  getPrepareStatus,
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

// PDP P3: CRM staff only on every DD-run route (reads already required it via requireFinanceRead; the write
// routes now too). Bank data is a separate READ grant (payments.bank:read, helpers/bankDataAccess.js): it never
// substitutes for requireFinanceWrite; generate-pain008 / prepare need finance write AND the bank grant.
router.use(ensureAuthenticated, tenantContextWarn);
router.use(requireCrmStaff);

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

router.get(
  "/:id/prepare-status",
  requireFinanceRead,
  runIdParam,
  validate,
  getPrepareStatus,
);

// PDP P3 (Q2): the PAIN.008 file carries every debtor IBAN and has no masked form, so it needs the
// bank-data permission (payments.bank:read) on top of finance read; without it 403
// BANK_DATA_PERMISSION_REQUIRED. The other read routes stay on finance read and mask bank fields in the
// controller (helpers/bankDataAccess.js).
router.get(
  "/:id/download-pain008",
  requireFinanceRead,
  requireBankDataRead,
  runIdParam,
  validate,
  downloadPain008,
);

// PDP P3 (Q2): prepare pulls every member's plaintext mandate from profile-service
// (mandates-for-prepare, which requires payments.bank:read) with this caller's forwarded token; refuse
// up front instead of queueing a job that can only fail.
router.post(
  "/:id/prepare",
  requireFinanceWrite,
  requireBankDataRead,
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

// PDP P3 (Q2): generating the PAIN.008 file builds (and can echo) every debtor IBAN: finance write
// plus the bank-data permission.
router.post(
  "/:id/generate-pain008",
  requireFinanceWrite,
  requireBankDataRead,
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
