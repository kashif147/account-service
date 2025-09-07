import express from "express";
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

// Balances snapshot - consolidated single route
router.get(
  "/balances/snapshot",
  ensureAuthenticated,
  authorizeMin("User"),
  balancesSnapshot
);

// Balances as-of - moved to distinct path to avoid duplicate
router.get(
  "/balances/as-of",
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
