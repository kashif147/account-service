import { body, param, query } from "express-validator";

export const createDirectDebitRunRules = [
  body("runType")
    .isIn(["MONTHLY", "BI_WEEKLY", "ANNUAL", "AD_HOC"])
    .withMessage("Invalid runType"),
  body("periodStartDate").isISO8601().withMessage("periodStartDate required"),
  body("periodEndDate").isISO8601().withMessage("periodEndDate required"),
  body("collectionDate").isISO8601().withMessage("collectionDate required"),
  body("submissionDueDate").optional().isISO8601(),
  body("creditorSnapshot").optional().isObject(),
  body("creditorSnapshot.oin").optional().isString(),
  body("creditorSnapshot.iban").optional().isString(),
  body("creditorSnapshot.name").optional().isString(),
];

export const runIdParam = [
  param("id").isMongoId().withMessage("Invalid run id"),
];

export const listRunsRules = [
  query("status").optional().isString(),
  query("limit").optional().isInt({ min: 1, max: 500 }),
  query("skip").optional().isInt({ min: 0 }),
];

export const listItemsRules = [
  param("id").isMongoId(),
  query("status").optional().isString(),
  query("limit").optional().isInt({ min: 1, max: 5000 }),
  query("skip").optional().isInt({ min: 0 }),
];

export const approveRunRules = [
  param("id").isMongoId(),
  body("notes").optional().isString().isLength({ max: 2000 }),
];

export const markSubmittedRules = [
  param("id").isMongoId(),
  body("reference").optional().isString(),
  body("notes").optional().isString(),
];

export const cancelRunRules = [
  param("id").isMongoId(),
  body("reason").optional().isString().isLength({ max: 2000 }),
];

export const importPain002Rules = [
  param("id").isMongoId(),
  body("xml").isString().notEmpty().withMessage("PAIN.002 XML required"),
  body("fileName").optional().isString(),
  body("receivedDate").optional().isISO8601(),
];
