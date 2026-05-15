import { body, param, query } from "express-validator";

const isBucket = ["arrears", "current", "advance"];
const isStatus = ["Draft", "Approved", "Cancelled"];

export const createCreditNoteRules = [
  body("date").isISO8601().withMessage("date must be ISO (YYYY-MM-DD)"),
  body("docNo").isString().notEmpty(),
  body("memberId").isString().notEmpty(),
  body("invoiceDocNo").isString().notEmpty(),
  body("amount").isFloat({ gt: 0 }),
  body("periodBucket").optional().isIn(isBucket),
  body("reason").optional().isString(),
  body("notes").optional().isString(),
];

export const creditNoteDocNoParam = [
  param("docNo").isString().notEmpty(),
];

export const listCreditNotesRules = [
  query("memberId").optional().isString(),
  query("status").optional().isIn(isStatus),
  query("limit").optional().isInt({ min: 1, max: 500 }),
  query("skip").optional().isInt({ min: 0 }),
];
