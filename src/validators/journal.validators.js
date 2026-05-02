import { body, query, oneOf } from "express-validator";

const isBucket = ["arrears", "current", "advance"];
const isClearing = ["1210", "1220", "1230", "1240", "1250"];
const isAdjSubType = ["prorata", "fee-increase-credit", "downgrade", "discount", "credit-note", "writeoff"];
const isProvider = ["stripe"]; // extend if you add others
const isSettlementStatus = ["PENDING", "SETTLED", "ALL"];

export const invoiceRules = [
  body("date").isISO8601().withMessage("date must be ISO (YYYY-MM-DD)"),
  body("docNo").isString().notEmpty(),
  oneOf(
    [
      body("memberId").isString().notEmpty(),
      body("applicationId").isString().notEmpty(),
    ],
    "either memberId or applicationId is required"
  ),
  body("annualFee").isFloat({ gt: 0 }).withMessage("annualFee must be > 0"),
  body("incomeCode").isString().notEmpty().withMessage("incomeCode required"),
  body("categoryName").isString().notEmpty().withMessage("categoryName required"),
  body("periodBucket").optional().isIn(isBucket),
  body("joinDate").optional().isISO8601().withMessage("joinDate must be ISO if provided")
];

export const receiptRules = [
  body("date").isISO8601().withMessage("date must be ISO (YYYY-MM-DD)"),
  body("docNo").isString().notEmpty(),
  oneOf(
    [
      body("memberId").isString().notEmpty(),
      body("applicationId").isString().notEmpty()
    ],
    "either memberId or applicationId is required"
  ),
  body("amount").isFloat({ gt: 0 }),
  body("clearingCode").isIn(isClearing).withMessage(`clearingCode must be one of ${isClearing.join(", ")}`),
  body("bucket").optional().isIn(isBucket),
  body("provider").optional().isIn(isProvider)
];

export const creditNoteRules = [
  body("date").isISO8601().withMessage("date must be ISO (YYYY-MM-DD)"),
  body("docNo").isString().notEmpty(),
  body("memberId").isString().notEmpty(),
  body("amount").isFloat({ gt: 0 }),
  body("periodBucket").optional().isIn(isBucket),
  body("adjSubType").optional().isIn(isAdjSubType),
  body("categoryName").optional().isString()
];

export const writeOffRules = [
  body("date").isISO8601().withMessage("date must be ISO (YYYY-MM-DD)"),
  body("docNo")
    .trim()
    .isString()
    .notEmpty()
    .withMessage("docNo is required"),
  body("memberId").isString().notEmpty(),
  body("amount").isFloat({ gt: 0 }),
  body("periodBucket").optional().isIn(isBucket),
  body("memo").optional({ values: "null" }).isString()
];

export const changeCategoryRules = [
  body("date").isISO8601().withMessage("date must be ISO (YYYY-MM-DD)"),
  body("docNoBase").isString().notEmpty(),

  body("memberId").isString().notEmpty(),
  body("periodBucket").optional().isIn(isBucket),

  body("oldIncomeCode").isString().notEmpty(),
  body("oldCategoryName").isString().notEmpty(),
  body("oldAnnualFee").isFloat({ gt: 0 }),

  body("newIncomeCode").isString().notEmpty(),
  body("newCategoryName").isString().notEmpty(),
  body("newAnnualFee").isFloat({ gt: 0 }),

  body("changeDate").isISO8601().withMessage("changeDate must be ISO (YYYY-MM-DD)"),

  body("previousStartDate")
    .notEmpty()
    .withMessage(
      "previousStartDate is required — subscription startDate before category change (same as PUT /subscriptions/:id snapshot)"
    )
    .isISO8601()
    .withMessage("previousStartDate must be ISO (YYYY-MM-DD)")
];

export const listJournalsRules = [
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("docType").optional().isString(),
  query("memberId").optional().isString(),
  query("limit").optional().isInt({ min: 1, max: 500 }),
  query("skip").optional().isInt({ min: 0 })
];

export const listStripePaymentsRules = [
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("status").optional().isIn(isSettlementStatus),
  query("limit").optional().isInt({ min: 1, max: 500 }),
  query("skip").optional().isInt({ min: 0 })
];

export const processDeductionBatchRules = [
  body("paymentDate")
    .isISO8601()
    .withMessage("paymentDate must be a valid ISO8601 date"),
  body("batchPayments")
    .isArray({ min: 1 })
    .withMessage("batchPayments must be a non-empty array"),
];

export const claimApplicationCreditRules = [
  body("date")
    .isISO8601()
    .withMessage("date must be a valid ISO8601 date"),
  body("docNo")
    .isString()
    .notEmpty()
    .withMessage("docNo is required"),
  body("applicationId")
    .isString()
    .notEmpty()
    .withMessage("applicationId is required"),
  body("memberId")
    .isString()
    .withMessage("memberId must be a string")
    .bail()
    .notEmpty()
    .withMessage("memberId is required"),
  // body("amount")
  //   .isFloat({ gt: 0 })
  //   .withMessage("amount must be a positive number"),
  body("bucket")
    .optional()
    .isIn(["current", "arrears", "advance"])
    .withMessage("bucket must be one of current, arrears, or advance")
];
