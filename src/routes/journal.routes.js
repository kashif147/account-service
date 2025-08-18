// src/routes/journal.routes.js
import {
  invoiceRules, receiptRules, creditNoteRules, writeOffRules, changeCategoryRules, listJournalsRules, claimApplicationCreditRules
} from "../validators/journal.validators.js";
import { invoice, creditNote, receipt, listJournals, claimApplicationCredit, writeOff, changeCategory } from "../controllers/journal.controller.js";
import router from "./reports.routes.js";
import validate from "../middlewares/validate.js";

router.get("/", listJournalsRules, listJournals);
router.post("/invoice", invoiceRules, validate, invoice);
router.post("/receipt", receiptRules, validate, receipt);
router.post("/credit-note", creditNoteRules, validate, creditNote);
router.post("/writeoff", writeOffRules, validate, writeOff);
router.post("/change-category", changeCategoryRules, validate, changeCategory);
router.post("/claim-credit", claimApplicationCreditRules, validate, claimApplicationCredit)

export default router