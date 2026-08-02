import MaterializedBalance from "../models/materializedBalance.model.js";
import GL from "../models/glTransaction.model.js";
import {
  getAvailableCredit2020ForKey,
  getMemberStoredCreditCents,
  getRefundableBalanceForMember,
} from "./refundCredit.service.js";
import { memberOwed1400ByBucket } from "../helpers/paymentReceiptAllocation.js";
import {
  resolveMemberBalanceKeys,
  buildMemberFacingGlQuery,
} from "../helpers/memberIdentityResolver.js";

const CLEARING_CODES = ["1210", "1220", "1230", "1240", "1250"];
const DEFERRED_CODE = "2030";

/** Same missing-field-means-membership convention memberLedger uses (reports.controller.js). */
function ledgerDomainGlFilter(ledgerDomain) {
  if (ledgerDomain === "events") return { "entries.ledgerDomain": "events" };
  return {
    $or: [
      { "entries.ledgerDomain": "membership" },
      { "entries.ledgerDomain": { $exists: false } },
    ],
  };
}

/** Raw (unprefixed) profile ids this identity resolves to, for matching entry.profileId directly. */
function rawProfileIdsFromBalanceKeys(mid, balanceKeys) {
  const ids = new Set([mid]);
  for (const k of balanceKeys) {
    if (k.startsWith("profile:")) ids.add(k.slice(8));
  }
  return ids;
}

/** Does this GL entry belong to the resolved identity (membershipNumber or profileId)? */
function entryBelongsToIdentity(entry, mid, rawProfileIds) {
  if (entry?.memberId === mid) return true;
  if (entry?.profileId && rawProfileIds.has(String(entry.profileId))) return true;
  return false;
}

/**
 * First-class member finance summary (cents). Internal matbal remains source; this is the operational view.
 * @param {string} memberId
 * @param {number} [year] calendar year; defaults to current year
 * @param {{ req?: object, ledgerDomain?: "membership"|"events" }} [options] - `req` enables
 *   resolving a member's linked profile-service id for events/courses activity posted under a
 *   different id; `ledgerDomain` (default "membership") keeps membership and events/courses
 *   money from being blended into one figure now that both post to shared account codes.
 */
export async function computeMemberFinanceSummary(memberId, year, options = {}) {
  const { req, ledgerDomain = "membership" } = options;
  const mid = String(memberId || "").trim();
  if (!mid) {
    throw new Error("memberId required");
  }
  const effectiveYear =
    Number.isFinite(year) && year > 0 ? year : new Date().getFullYear();

  const balanceKeys = await resolveMemberBalanceKeys(mid, req);

  const matRows = await MaterializedBalance.find({
    memberId: { $in: balanceKeys },
    year: effectiveYear,
    ledgerDomain,
  }).lean();

  const { arrears, current } = await memberOwed1400ByBucket(
    mid,
    effectiveYear,
    { req, ledgerDomain },
  );
  const outstandingBalance = Math.max(0, arrears) + Math.max(0, current);

  let availableCredit = 0;
  for (const key of balanceKeys) {
    const available2020 = await getAvailableCredit2020ForKey(key, effectiveYear, ledgerDomain);
    const storedCredit = await getMemberStoredCreditCents(key, effectiveYear, ledgerDomain);
    availableCredit = Math.max(availableCredit, available2020, storedCredit);
  }

  let refundableBalance = 0;
  for (const key of balanceKeys) {
    refundableBalance = Math.max(
      refundableBalance,
      await getRefundableBalanceForMember(key, effectiveYear, ledgerDomain),
    );
  }

  let deferredIncomeBalance = 0;
  for (const r of matRows) {
    if (r.accountCode === DEFERRED_CODE && r.amount < 0) {
      deferredIncomeBalance += -r.amount;
    }
  }

  const glMemberQuery = await buildMemberFacingGlQuery({ memberId: mid, req });
  const domainFilter = ledgerDomainGlFilter(ledgerDomain);
  const rawProfileIds = rawProfileIdsFromBalanceKeys(mid, balanceKeys);

  let writtenOffBalance = 0;
  const writeOffTxns = await GL.find({
    $and: [glMemberQuery, domainFilter],
    docType: "WriteOff",
    date: {
      $gte: new Date(`${effectiveYear}-01-01`),
      $lte: new Date(`${effectiveYear}-12-31T23:59:59.999Z`),
    },
  }).lean();
  for (const txn of writeOffTxns) {
    for (const e of txn.entries || []) {
      if (
        entryBelongsToIdentity(e, mid, rawProfileIds) &&
        e.accountCode === "1400" &&
        e.dc === "C"
      ) {
        writtenOffBalance += Number(e.amount) || 0;
      }
    }
  }

  let unreconciledClearingBalance = 0;
  const clearingTxns = await GL.find({
    $and: [glMemberQuery, domainFilter],
    docType: { $in: ["Receipt", "Refund"] },
    "settlement.status": "PENDING",
    date: {
      $gte: new Date(`${effectiveYear}-01-01`),
      $lte: new Date(`${effectiveYear}-12-31T23:59:59.999Z`),
    },
  }).lean();
  for (const txn of clearingTxns) {
    for (const e of txn.entries || []) {
      if (
        entryBelongsToIdentity(e, mid, rawProfileIds) &&
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

