import CreditNote from "../models/creditNote.model.js";
import { computeMemberFinanceSummary } from "./memberFinanceSummary.service.js";

/**
 * Contextual ledger actions for member finance UI (permissions are resource names).
 * @param {{
 *   docType: string,
 *   docNo?: string,
 *   status?: string,
 *   memberId: string,
 *   permissions?: string[],
 *   year?: number,
 * }} ctx
 */
export async function getLedgerActionsForDocument(ctx) {
  const {
    docType,
    docNo,
    status,
    memberId,
    permissions = [],
    year = new Date().getFullYear(),
  } = ctx;

  const can = (resource, action) =>
    permissions.includes(`${resource}:${action}`) ||
    permissions.includes("admin") ||
    permissions.includes("*");

  const summary = await computeMemberFinanceSummary(memberId, year);
  const actions = [];

  const add = (id, label, permission) => {
    if (!permission || can(permission.resource, permission.action)) {
      actions.push({ id, label });
    }
  };

  const dt = String(docType || "").toLowerCase();

  if (dt === "invoice") {
    add("create-credit-note", "Create Credit Note", {
      resource: "accounts.journals",
      action: "create",
    });
    add("write-off-balance", "Write-Off Balance", {
      resource: "accounts.journals",
      action: "write",
    });
    if (summary.availableCredit > 0) {
      add("apply-member-credit", "Apply Member Credit", {
        resource: "accounts.journals",
        action: "create",
      });
    }
    add("print", "Print", null);
    add("send", "Send", null);
  }

  if (dt === "receipt") {
    if (summary.refundableBalance > 0) {
      add("refund", "Refund", {
        resource: "accounts.journals",
        action: "create",
      });
    }
    if (summary.availableCredit > 0) {
      add("apply-credit", "Apply Credit", {
        resource: "accounts.journals",
        action: "create",
      });
    }
    add("reverse-receipt", "Reverse Receipt", {
      resource: "accounts.journals",
      action: "write",
    });
    add("view-source-batch", "View Source Batch", {
      resource: "accounts.journals",
      action: "read",
    });
  }

  if (dt === "creditnote" || dt === "credit_note") {
    const cnStatus = status || "Draft";
    if (docNo) {
      const cn = await CreditNote.findOne({
        $or: [{ docNo }, { glDocNo: docNo }],
      }).lean();
      const st = cn?.status || cnStatus;
      if (st === "Draft") {
        add("approve", "Approve", {
          resource: "accounts.journals",
          action: "write",
        });
        add("cancel", "Cancel", {
          resource: "accounts.journals",
          action: "write",
        });
      }
      if (st === "Approved" && summary.refundableBalance > 0) {
        add("refund-credit", "Refund Credit", {
          resource: "accounts.journals",
          action: "create",
        });
        add("retain-credit", "Retain as Credit", null);
      }
    }
  }

  if (dt === "writeoff") {
    const st = status || "Approved";
    if (st === "Draft" || st === "PENDING") {
      add("approve", "Approve", {
        resource: "accounts.journals",
        action: "write",
      });
    }
    add("reverse", "Reverse", {
      resource: "accounts.journals",
      action: "write",
    });
    add("recovery-note", "Add Recovery Note", {
      resource: "accounts.journals",
      action: "write",
    });
  }

  return {
    actions,
    balances: {
      availableCredit: summary.availableCredit,
      refundableBalance: summary.refundableBalance,
      outstandingBalance: summary.outstandingBalance,
    },
    badges: buildLedgerBadges(summary, status, docType),
  };
}

function buildLedgerBadges(summary, status, docType) {
  const badges = [];
  if (summary.availableCredit > 0) badges.push("CREDIT AVAILABLE");
  if (summary.refundableBalance > 0) badges.push("REFUNDABLE");
  if (String(docType).toLowerCase() === "writeoff") badges.push("WRITTEN OFF");
  if (status === "Settled" || status === "Reconciled" || status === "SETTLED") {
    badges.push("RECONCILED");
  }
  if (status === "Unsettled") badges.push("UNSETTLED");
  if (status === "Draft" || status === "PENDING APPROVAL") {
    badges.push("PENDING APPROVAL");
  }
  if (status === "Refunded") badges.push("REFUNDED");
  return badges;
}
