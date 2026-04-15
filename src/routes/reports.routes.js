import express from "express";
import {
  monthEnd,
  memberStatement,
  balancesSnapshot,
  yearEnd,
  balancesAsOf,
  memberNetBalance,
  memberSummary,
  memberLedger,
  refundsList,
} from "../controllers/reports.controller.js";
import {
  monthEndRules,
  yearEndRules,
  balancesAsOfRules,
  memberNetBalanceRules,
  memberLedgerRules,
  refundsListRules,
} from "../validators/reports.validators.js";
import validate from "../middlewares/validate.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";

const router = express.Router();

// Reports require authentication and minimum User role
router.get(
  "/refunds",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  refundsListRules,
  validate,
  refundsList
);

router.get(
  "/member/:memberId/statement",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberStatement
);

router.get(
  "/member/:memberId/net-balance",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberNetBalanceRules,
  validate,
  memberNetBalance
);

router.get(
  "/member/:memberId/summary",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberNetBalanceRules,
  validate,
  memberSummary
);

router.get(
  "/member/:memberId/ledger",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberLedgerRules,
  validate,
  memberLedger
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
