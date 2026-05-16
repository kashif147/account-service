import { query } from "express-validator";

export const monthEndRules = [
  query("period").matches(/^\d{4}-\d{2}$/).withMessage("period must be YYYY-MM")
];

export const yearEndRules = [
  query("year").isInt({ min: 2000, max: 2100 }).withMessage("year must be YYYY")
];

export const balancesAsOfRules = [
  query("asOf").isISO8601().withMessage("asOf must be YYYY-MM-DD")
];

export const memberNetBalanceRules = [
  query("year")
    .optional()
    .isInt({ min: 2000, max: 2100 })
    .withMessage("year must be YYYY"),
  query("scope")
    .optional()
    .isIn(["all", "current"])
    .withMessage("scope must be all or current"),
];

export const memberLedgerRules = [
  query("accountCode").optional().isString().notEmpty(),
  query("view")
    .optional()
    .isIn(["simple", "full"])
    .withMessage("view must be simple or full"),
];

export const memberCreditNotesRules = [
  query("status")
    .optional()
    .isIn(["Draft", "Approved", "Cancelled"])
    .withMessage("status must be Draft, Approved, or Cancelled"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage("limit must be between 1 and 200"),
  query("skip")
    .optional()
    .isInt({ min: 0 })
    .withMessage("skip must be a non-negative integer"),
];

export const generalLedgerRules = [
  query("limit")
    .optional()
    .isInt({ min: 1, max: 500 })
    .withMessage("limit must be between 1 and 500"),
  query("skip")
    .optional()
    .isInt({ min: 0 })
    .withMessage("skip must be a non-negative integer"),
  query("memberId").optional().isString().notEmpty(),
  query("docType").optional().isString().notEmpty(),
  query("from")
    .optional()
    .isISO8601()
    .withMessage("from must be a valid ISO date"),
  query("to")
    .optional()
    .isISO8601()
    .withMessage("to must be a valid ISO date"),
];

export const refundsListRules = [
  query("limit")
    .optional()
    .isInt({ min: 1, max: 1000 })
    .withMessage("limit must be between 1 and 1000"),
  query("skip")
    .optional()
    .isInt({ min: 0 })
    .withMessage("skip must be greater than or equal to 0"),
  query("mode")
    .optional()
    .isIn(["stripe", "external"])
    .withMessage("mode must be stripe or external"),
  query("memberId").optional().isString().notEmpty(),
  query("from")
    .optional()
    .isISO8601()
    .withMessage("from must be a valid ISO date"),
  query("to")
    .optional()
    .isISO8601()
    .withMessage("to must be a valid ISO date"),
];
