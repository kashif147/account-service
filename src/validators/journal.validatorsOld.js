import { body, oneOf } from "express-validator";

export const invoiceRules = [
  body("date").isISO8601().withMessage("date is required"),
  body("docNo").isString().notEmpty(),
  body("memberId").isString().notEmpty(),
  body("amount").isFloat({ gt: 0 }),
  body("incomeCode").isString().notEmpty(),
  body("periodBucket").optional().isIn(["arrears", "current", "advance"])
];

// export const receiptRules = [
//   body("date").isISO8601(),
//   body("docNo").isString().notEmpty(),
//   body("memberId").isString().notEmpty(),
//   body("amount").isFloat({ gt: 0 }),
//   body("clearingCode").isIn(["1210", "1220", "1230", "1240", "1250"]),
//   body("bucket").optional().isIn(["arrears", "current", "advance"])
// ];

export const receiptRules = [
  body("date").isISO8601().withMessage("date must be ISO date"),
  body("docNo").isString().notEmpty().withMessage("docNo is required"),
  oneOf(
    [
      body("memberId").isString().notEmpty(),
      body("applicationId").isString().notEmpty()
    ],
    "either memberId or applicationId is required"
  ),
  body("amount").isFloat({ gt: 0 }).withMessage("amount must be > 0"),
  body("clearingCode")
    .isIn(["1210", "1220", "1230", "1240", "1250"])
    .withMessage("clearingCode must be one of 1210,1220,1230,1240,1250"),
  body("bucket").optional().isIn(["arrears", "current", "advance"])
];