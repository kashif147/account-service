import express from "express";
import {
  monthEnd,
  memberStatement,
  balancesSnapshot,
  yearEnd,
  balancesAsOf,
  memberNetBalance,
  memberSummary,
  memberSummaryBatch,
  memberLedger,
  memberCreditNotes,
  refundsList,
  generalLedgerTransactions,
  creditorsList,
} from "../controllers/reports.controller.js";
import { glJournalReplicationFeed } from "../services/glJournalReplication.service.js";
import { memberLedgerActions } from "../controllers/ledgerActions.controller.js";
import {
  monthEndRules,
  yearEndRules,
  balancesAsOfRules,
  memberNetBalanceRules,
  memberLedgerRules,
  memberCreditNotesRules,
  refundsListRules,
  generalLedgerRules,
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
  "/general-ledger",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  generalLedgerRules,
  validate,
  generalLedgerTransactions
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

router.post(
  "/members/summary-batch",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberSummaryBatch
);

router.post(
  "/creditors-list",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  creditorsList
);

router.post(
  "/gl-journal-replication",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  glJournalReplicationFeed
);

router.get(
  "/member/:memberId/ledger",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberLedgerRules,
  validate,
  memberLedger
);

router.get(
  "/member/:memberId/credit-notes",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberCreditNotesRules,
  validate,
  memberCreditNotes
);

router.get(
  "/member/:memberId/ledger-actions",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberLedgerActions,
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
