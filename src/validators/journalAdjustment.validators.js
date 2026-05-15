import { body, param, query } from "express-validator";

export const createJournalAdjustmentRules = [
  body("date").isISO8601(),
  body("docNo").isString().notEmpty(),
  body("debitAccount").isString().notEmpty(),
  body("creditAccount").isString().notEmpty(),
  body("amount").isFloat({ gt: 0 }),
  body("memberId").optional().isString(),
  body("reason").isString().notEmpty(),
  body("notes").optional().isString(),
  body("financialPeriod").isString().notEmpty(),
];

export const journalAdjustmentDocNoParam = [
  param("docNo").isString().notEmpty(),
];

export const listJournalAdjustmentRules = [
  query("limit").optional().isInt({ min: 1, max: 500 }),
  query("skip").optional().isInt({ min: 0 }),
];

export const reconciliationSeedRules = [
  body("clearingAccountCode")
    .isIn(["1210", "1220", "1230", "1240", "1250"]),
];

export const reconciliationMatchRules = [
  body("recordId").isString().notEmpty(),
  body("matchedGlDocNo").isString().notEmpty(),
];

export const reconciliationSuspenseRules = [
  body("recordId").isString().notEmpty(),
  body("suspenseReason").isString().notEmpty(),
];
