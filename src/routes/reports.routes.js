import express from "express";
// import { ,  } from "../controllers/reports.controller.js";
import { monthEnd, memberStatement, balancesSnapshot, yearEnd, balancesAsOf } from "../controllers/reports.controller.js";
import { monthEndRules, yearEndRules, balancesAsOfRules } from "../validators/reports.validators.js";
import validate from "../middlewares/validate.js";
import verifyJWT from "../middlewares/verifyJWT.js";

// import { requireScopes } from "../middlewares/auth.js";

const router = express.Router();
router.get("/member/:memberId/statement", verifyJWT, memberStatement);
router.get("/balances", verifyJWT, balancesSnapshot);
// Debtor/Creditor quick view from materialized balances (already in your app)
router.get("/balances", balancesAsOfRules, verifyJWT, validate, balancesAsOf);

// Period-based reports (computed from GL by date; no freeze)
router.get("/month-end", monthEndRules, verifyJWT, validate, monthEnd);
router.get("/year-end", yearEndRules, verifyJWT, validate, yearEnd);

export default router;
