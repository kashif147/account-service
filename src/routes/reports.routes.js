import express from "express";
// import { ,  } from "../controllers/reports.controller.js";
import {
  monthEnd,
  memberStatement,
  balancesSnapshot,
  yearEnd,
  balancesAsOf,
} from "../controllers/reports.controller.js";
import {
  monthEndRules,
  yearEndRules,
  balancesAsOfRules,
} from "../validators/reports.validators.js";
import validate from "../middlewares/validate.js";
import { ensureAuthenticated, authorizeMin } from "../middlewares/auth.js";

const router = express.Router();

// Reports require authentication and minimum User role
router.get(
  "/member/:memberId/statement",
  ensureAuthenticated,
  authorizeMin("User"),
  memberStatement
);
router.get(
  "/balances",
  ensureAuthenticated,
  authorizeMin("User"),
  balancesSnapshot
);

// Debtor/Creditor quick view from materialized balances (already in your app)
router.get(
  "/balances",
  ensureAuthenticated,
  authorizeMin("User"),
  balancesAsOfRules,
  validate,
  balancesAsOf
);

// Period-based reports (computed from GL by date; no freeze) - require Editor role
router.get(
  "/month-end",
  ensureAuthenticated,
  authorizeMin("Editor"),
  monthEndRules,
  validate,
  monthEnd
);
router.get(
  "/year-end",
  ensureAuthenticated,
  authorizeMin("Editor"),
  yearEndRules,
  validate,
  yearEnd
);

export default router;
