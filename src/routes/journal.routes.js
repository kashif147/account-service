// src/routes/journal.routes.js
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
import router from "./reports.routes.js";
import validate from "../middlewares/validate.js";
import {
  ensureAuthenticated,
  authorizeMin,
  authorizeAny,
} from "../middlewares/auth.js";
import { idempotency } from "../middlewares/idempotency.js";

// All journal operations require authentication and minimum User role
router.get(
  "/",
  ensureAuthenticated,
  authorizeMin("User"),
  listJournalsRules,
  listJournals
);

// POST operations with idempotency for data consistency
router.post(
  "/invoice",
  ensureAuthenticated,
  authorizeMin("User"),
  idempotency(),
  invoiceRules,
  validate,
  invoice
);

router.post(
  "/receipt",
  ensureAuthenticated,
  authorizeMin("User"),
  idempotency(),
  receiptRules,
  validate,
  receipt
);

router.post(
  "/credit-note",
  ensureAuthenticated,
  authorizeMin("User"),
  idempotency(),
  creditNoteRules,
  validate,
  creditNote
);

router.post(
  "/writeoff",
  ensureAuthenticated,
  authorizeMin("Editor"),
  idempotency(),
  writeOffRules,
  validate,
  writeOff
);

router.post(
  "/change-category",
  ensureAuthenticated,
  authorizeMin("Editor"),
  idempotency(),
  changeCategoryRules,
  validate,
  changeCategory
);

router.post(
  "/claim-credit",
  ensureAuthenticated,
  authorizeMin("User"),
  idempotency(),
  claimApplicationCreditRules,
  validate,
  claimApplicationCredit
);

export default router;
