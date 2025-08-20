// src/routes/journal.routes.js
import {
  invoiceRules, receiptRules, creditNoteRules, writeOffRules, changeCategoryRules, listJournalsRules, claimApplicationCreditRules
} from "../validators/journal.validators.js";
import { invoice, creditNote, receipt, listJournals, claimApplicationCredit, writeOff, changeCategory } from "../controllers/journal.controller.js";
import router from "./reports.routes.js";
import validate from "../middlewares/validate.js";
import verifyJWT from "../middlewares/verifyJWT.js";

router.get("/", verifyJWT, listJournalsRules, listJournals);
router.post("/invoice",verifyJWT, invoiceRules, validate, invoice);
router.post("/receipt",verifyJWT, receiptRules, validate, receipt);
router.post("/credit-note",verifyJWT, creditNoteRules, validate, creditNote);
router.post("/writeoff",verifyJWT, writeOffRules, validate, writeOff);
router.post("/change-category",verifyJWT, changeCategoryRules, validate, changeCategory);
router.post("/claim-credit",verifyJWT, claimApplicationCreditRules, validate, claimApplicationCredit)


export default router