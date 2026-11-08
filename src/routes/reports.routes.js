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
} from "../middlewares/callerScope.middleware.js";
import { createRequireMemberAccountRead } from "../middlewares/memberAccountRead.middleware.js";

const router = express.Router();

// P5: accounts.reports:read is also held by the portal MEMBER role, so the PDP alone does
// not keep members out of tenant-wide or other members' finance data. Every report is CRM
// staff only (requireCrmUser, then the PDP), except a member's own statement / net balance,
// which the portal reads for the signed-in member (requireCrmOrOwnMember resolves the
// caller's own membership number from the verified principal).
//
// PDP rollout P5 (blockers 1 and 2): accounts.reports:read is retired on these 13 read routes -
// it becomes a CRM-audience code at P5 (portal statement would break) and is held by MO / IRO
// outside their P8 targets (tenant-wide finance would open to them). Each route now asks for the
// code that names what it returns:
//   tenant-wide finance  (refunds, general-ledger, creditors-list, gl-journal-replication,
//                         balances/snapshot, balances/as-of)            -> reporting.finance:read (CRM)
//   one member's account, CRM (member summary, ledger, credit-notes, ledger-actions,
//                         members/summary-batch)                        -> accounts.member:read (BOTH)
//   one member's account, CRM or the member themselves (statement, net-balance)
//                                       -> requireCrmOrOwnMember, then requireMemberAccountRead:
//                                          CRM -> PDP accounts.member:read; PORTAL -> own record +
//                                          the existing claim, checked locally (no PDP; option b).
// Under the legacy evaluator every code here is denied to non-ASU CRM staff by the category rule,
// exactly as accounts.reports:read is today, so ASU keeps every route and nobody loses access now.
const requireTenantFinanceReportRead = defaultPolicyMiddleware.requirePermission("reporting.finance", "read");
const requireMemberAccountReadCrm = defaultPolicyMiddleware.requirePermission("accounts.member", "read");
const requireMemberAccountRead = createRequireMemberAccountRead({ crmCheck: requireMemberAccountReadCrm });

router.get(
  "/refunds",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireTenantFinanceReportRead,
  refundsListRules,
  validate,
  refundsList
);

router.get(
  "/general-ledger",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireTenantFinanceReportRead,
  generalLedgerRules,
  validate,
  generalLedgerTransactions
);

router.get(
  "/member/:memberId/statement",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmOrOwnMember,
  requireMemberAccountRead,
  memberStatement
);

router.get(
  "/member/:memberId/net-balance",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmOrOwnMember,
  requireMemberAccountRead,
  memberNetBalanceRules,
  validate,
  memberNetBalance
);

router.get(
  "/member/:memberId/summary",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireMemberAccountReadCrm,
  memberNetBalanceRules,
  validate,
  memberSummary
);

router.post(
  "/members/summary-batch",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireMemberAccountReadCrm,
  memberSummaryBatch
);

router.post(
  "/creditors-list",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireTenantFinanceReportRead,
  creditorsList
);

router.post(
  "/gl-journal-replication",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireTenantFinanceReportRead,
  glJournalReplicationFeed
);

router.get(
  "/member/:memberId/ledger",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireMemberAccountReadCrm,
  memberLedgerRules,
  validate,
  memberLedger
);

router.get(
  "/member/:memberId/credit-notes",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireMemberAccountReadCrm,
  memberCreditNotesRules,
  validate,
  memberCreditNotes
);

router.get(
  "/member/:memberId/ledger-actions",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireMemberAccountReadCrm,
  memberLedgerActions,
);

// Balances snapshot - consolidated single route
router.get(
  "/balances/snapshot",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireTenantFinanceReportRead,
  balancesSnapshot
);

// Balances as-of - moved to distinct path to avoid duplicate
router.get(
  "/balances/as-of",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  requireTenantFinanceReportRead,
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
