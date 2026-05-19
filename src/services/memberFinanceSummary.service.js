import MaterializedBalance from "../models/materializedBalance.model.js";
import GL from "../models/glTransaction.model.js";
import {
  getAvailableCredit2020ForKey,
  getMemberStoredCreditCents,
  getRefundableBalanceForMember,
} from "./refundCredit.service.js";
import { memberOwed1400ByBucket } from "../helpers/paymentReceiptAllocation.js";

const CLEARING_CODES = ["1210", "1220", "1230", "1240", "1250"];
const DEFERRED_CODE = "2030";

/**
 * First-class member finance summary (cents). Internal matbal remains source; this is the operational view.
 * @param {string} memberId
 * @param {number} [year] calendar year; defaults to current year
 */
export async function computeMemberFinanceSummary(memberId, year) {
  const mid = String(memberId || "").trim();
  if (!mid) {
    throw new Error("memberId required");
  }
  const effectiveYear =
    Number.isFinite(year) && year > 0 ? year : new Date().getFullYear();

  const matRows = await MaterializedBalance.find({
    memberId: mid,
    year: effectiveYear,
  }).lean();

  const { arrears, current } = await memberOwed1400ByBucket(mid, effectiveYear);
  const outstandingBalance = Math.max(0, arrears) + Math.max(0, current);

  const available2020 = await getAvailableCredit2020ForKey(mid, effectiveYear);
  const storedCredit = await getMemberStoredCreditCents(mid, effectiveYear);
  const availableCredit = Math.max(available2020, storedCredit);
  const refundableBalance = await getRefundableBalanceForMember(
    mid,
    effectiveYear,
  );

  let deferredIncomeBalance = 0;
  for (const r of matRows) {
    if (r.accountCode === DEFERRED_CODE && r.amount < 0) {
      deferredIncomeBalance += -r.amount;
    }
  }

  let writtenOffBalance = 0;
  const writeOffTxns = await GL.find({
    docType: "WriteOff",
    "entries.memberId": mid,
    date: {
      $gte: new Date(`${effectiveYear}-01-01`),
      $lte: new Date(`${effectiveYear}-12-31T23:59:59.999Z`),
    },
  }).lean();
  for (const txn of writeOffTxns) {
    for (const e of txn.entries || []) {
      if (e.memberId === mid && e.accountCode === "1400" && e.dc === "C") {
        writtenOffBalance += Number(e.amount) || 0;
      }
    }
  }

  let unreconciledClearingBalance = 0;
  const clearingTxns = await GL.find({
    docType: { $in: ["Receipt", "Refund"] },
    "entries.memberId": mid,
    "settlement.status": "PENDING",
    date: {
      $gte: new Date(`${effectiveYear}-01-01`),
      $lte: new Date(`${effectiveYear}-12-31T23:59:59.999Z`),
    },
  }).lean();
  for (const txn of clearingTxns) {
    for (const e of txn.entries || []) {
      if (
        CLEARING_CODES.includes(e.accountCode) &&
        (e.dc === "D" || e.dc === "C")
      ) {
        unreconciledClearingBalance += Number(e.amount) || 0;
      }
    }
  }

  return {
    memberId: mid,
    year: effectiveYear,
    outstandingBalance,
    availableCredit,
    refundableBalance,
    deferredIncomeBalance,
    writtenOffBalance,
    unreconciledClearingBalance,
  };
}

