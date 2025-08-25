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
