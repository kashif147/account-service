import express from "express";
import { invoice, creditNote, receipt, listJournals, claimApplicationCredit } from "../controllers/journal.controller.js";
import validate from "../middlewares/validate.js";
import { invoiceRules, receiptRules } from "../validators/journal.validatorsOld.js";
import { limiterSensitive } from "../config/rateLimiters.js";

/**
 * @openapi
 * /journal/invoice:
 *   post:
 *     summary: Create invoice
 */
const router = express.Router();

router.get("/", listJournals);   
router.post("/invoice", limiterSensitive, invoiceRules, validate, invoice);
router.post("/receipt", limiterSensitive, receiptRules, validate, receipt);
router.post("/credit-note", limiterSensitive, invoiceRules, validate, creditNote);
router.post("/writeoff", writeOffRules, validate, writeOff);
router.post("/change-category", changeCategoryRules, validate, changeCategory);
router.post("/claim-credit", validate, claimApplicationCredit);

export default router;
