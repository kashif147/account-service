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
import { ensureAuthenticatedWithTenantContext } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import {
  requireCrmUser,
  requireCrmOrOwnMember,
  trustedInternalOnly,
} from "../middlewares/callerScope.middleware.js";

const router = express.Router();

// P5: accounts.reports:read is also held by the portal MEMBER role, so the PDP alone does
// not keep members out of tenant-wide or other members' finance data. Every report is CRM
// staff only (requireCrmUser, then the PDP), except a member's own statement / net balance,
// which the portal reads for the signed-in member (requireCrmOrOwnMember resolves the
// caller's own membership number from the verified principal).
router.get(
  "/refunds",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  refundsListRules,
  validate,
  refundsList
);

router.get(
  "/general-ledger",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  generalLedgerRules,
  validate,
  generalLedgerTransactions
);

router.get(
  "/member/:memberId/statement",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmOrOwnMember,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberStatement
);

router.get(
  "/member/:memberId/net-balance",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmOrOwnMember,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberNetBalanceRules,
  validate,
  memberNetBalance
);

router.get(
  "/member/:memberId/summary",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberNetBalanceRules,
  validate,
  memberSummary
);

router.post(
  "/members/summary-batch",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberSummaryBatch
);

// Creditors list. Two registrations, tried in order:
//  1. a genuine internal S2S call - x-internal-request: true, NO user identity header, and an
//     explicit 24-hex x-tenant-id (400 if missing/malformed) - for reporting-service
//     scripts/sync-member-creditors.js (member_creditor warehouse refresh). Tenant = that header only;
//  2. anything else falls through (next("route")) to the unchanged CRM chain (CRM staff with
//     accounts.reports:read). A user token / gateway headers / forwarded x-user-* + a spoofed
//     x-internal-request is judged here as that user.
router.post(
  "/creditors-list",
  trustedInternalOnly,
  creditorsList
);

router.post(
  "/creditors-list",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  creditorsList
);

router.post(
  "/gl-journal-replication",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  glJournalReplicationFeed
);

router.get(
  "/member/:memberId/ledger",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberLedgerRules,
  validate,
  memberLedger
);

router.get(
  "/member/:memberId/credit-notes",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberCreditNotesRules,
  validate,
  memberCreditNotes
);

router.get(
  "/member/:memberId/ledger-actions",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  memberLedgerActions,
);

// Balances snapshot - consolidated single route
router.get(
  "/balances/snapshot",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  balancesSnapshot
);

// Balances as-of - moved to distinct path to avoid duplicate
router.get(
  "/balances/as-of",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "read"),
  balancesAsOfRules,
  validate,
  balancesAsOf
);

// Period-based reports (computed from GL by date; no freeze) - require Editor role
router.get(
  "/month-end",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "write"),
  monthEndRules,
  validate,
  monthEnd
);
router.get(
  "/year-end",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.reports", "write"),
  yearEndRules,
  validate,
  yearEnd
);

export default router;
