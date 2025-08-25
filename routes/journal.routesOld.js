import express from "express";
import { invoice, creditNote, receipt, listJournals, claimApplicationCredit } from "../controllers/journal.controller.js";
import validate from "../middlewares/validate.js";
import { invoiceRules, receiptRules } from "../validators/journal.validatorsOld.js";
import { limiterSensitive } from "../config/rateLimiters.js";
import verifyJWT from "../middlewares/verifyJWT.js";

/**
 * @openapi
 * /journal/invoice:
 *   post:
 *     summary: Create invoice
 */
const router = express.Router();

router.get("/", listJournals);   
router.post("/invoice", verifyJWT, limiterSensitive, invoiceRules, validate, invoice);
router.post("/receipt", verifyJWT, limiterSensitive, receiptRules, validate, receipt);
router.post("/credit-note", verifyJWT, limiterSensitive, invoiceRules, validate, creditNote);
router.post("/writeoff", verifyJWT, writeOffRules, validate, writeOff);
router.post("/change-category", verifyJWT, changeCategoryRules, validate, changeCategory);
router.post("/claim-credit", verifyJWT, validate, claimApplicationCredit);

export default router;
