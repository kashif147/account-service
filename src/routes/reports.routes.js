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
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";

const router = express.Router();

// Reports require authentication and minimum User role
router.get(
  "/member/:memberId/statement",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberStatement
);

// Balances snapshot - consolidated single route
router.get(
  "/balances/snapshot",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  balancesSnapshot
);

// Balances as-of - moved to distinct path to avoid duplicate
router.get(
  "/balances/as-of",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  balancesAsOfRules,
  validate,
  balancesAsOf
);

// Period-based reports (computed from GL by date; no freeze) - require Editor role
router.get(
  "/month-end",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "write"),
  monthEndRules,
  validate,
  monthEnd
);
router.get(
  "/year-end",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "write"),
  yearEndRules,
  validate,
  yearEnd
);

export default router;
