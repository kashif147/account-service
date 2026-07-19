// src/controllers/journal.controller.js
import mongoose from "mongoose";
import CoA from "../models/coa.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import MaterializedBalance from "../models/materializedBalance.model.js";
import Refund from "../models/refund.model.js";
import Payment from "../models/payment.model.js";
import dayjs from "dayjs";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn, logError } from "../middlewares/logger.mw.js";
// import { calculateProRataFee } from "../helpers/prorata.js";
import {
  prorataFromJoinToYearEnd,
  yearBoundsFrom,
  prorataForPeriod,
} from "../helpers/prorata.js";
import { buildCategoryChangeJournalPayload } from "../helpers/categoryChangeJournal.js";
import { getMemberTrackedAccountCodes } from "../helpers/coaAccountCodes.helper.js";
import { stripeFeeBreakdown } from "../helpers/fees.js";
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";
import { notifyMemberFinanceUpdated } from "../services/memberFinanceRealtimeNotify.service.js";
import { publishMemberCreditReportingEvent } from "../services/memberCreditReportingPublish.service.js";
import { notifyMemberPaymentReceiptPosted } from "../services/memberReceiptReminderNotify.service.js";
import { globalDBLimiter } from "../config/globalLimiter.js";
import { randomUUID } from "crypto";
import { enrichStripePaymentItems } from "../services/stripe.payment.enrichment.service.js";
import { attachTxTypesToLedgerItems } from "../helpers/glTransactionTxType.js";
import { buildMemberReceiptCreditEntries } from "../helpers/paymentReceiptAllocation.js";
import {
  buildFinanceAuditSnapshot,
  inferPaymentMethodFromLines,
  paymentMethodFromBatchType,
  resolveJournalAuditAction,
} from "../helpers/financeAuditActions.js";

// Amounts are stored as integer cents - sum them as integers
function sumArray(arr, sel) {
  return arr.reduce((s, x) => s + sel(x), 0);
}

function resolveMemberIdForJournalEvent({
  claimMemberId,
  entries = [],
  memo,
  lines = [],
}) {
  if (claimMemberId != null && String(claimMemberId).trim()) {
    return String(claimMemberId).trim();
  }
  const fromEntries = [...entries, ...lines];
  for (const entry of fromEntries) {
    const mid = entry?.memberId;
    if (mid != null && String(mid).trim() && !String(mid).startsWith("app:")) {
      return String(mid).trim();
    }
  }
  const memoStr = String(memo || "");
  const memberMatch = memoStr.match(/\(member\s+([^)]+)\)/i);
  if (memberMatch?.[1]) return memberMatch[1].trim();
  const batchMemberMatch = memoStr.match(/\bMember:\s*([^\s|]+)/i);
  if (batchMemberMatch?.[1]) return batchMemberMatch[1].trim();
  return null;
}

// Load CoA rows for the accounts referenced in the journal,
// and attach 'accountName' by mapping CoA.description → accountName.
// We leave your GL model untouched (it still expects accountName).
async function enrichLines(lines) {
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const coaRows = await CoA.find({ code: { $in: codes } }).lean();

  const byCode = Object.fromEntries(coaRows.map((a) => [a.code, a]));
  return lines.map((l) => {
    const a = byCode[l.accountCode];
    if (!a)
      throw AppError.badRequest(`Unknown account ${l.accountCode}`, {
        accountCode: l.accountCode,
      });
    return {
      ...l,
      accountName: a.description, // <-- map description to the name field GL stores
      _a: a, // keep the CoA row handy for guardrails if needed
    };
  });
}

export function rollupMemberBalances({ date, entries }) {
  const year = new Date(date).getFullYear();
  const totals = new Map();

  for (const e of entries) {
    if (!e.periodBucket) continue;
    // Use memberId if present, otherwise use applicationId (prefixed with "app:")
    const identifier =
      e.memberId || (e.applicationId ? `app:${e.applicationId}` : null);
    if (!identifier) continue;
    const signed = e.dc === "D" ? e.amount : -e.amount;
    const key = `${identifier}|${e.accountCode}|${e.periodBucket}|${year}`;
    totals.set(key, (totals.get(key) || 0) + signed);
  }

  return { year, totals };
}

/** Normalize for comparing application ids stored as string vs ObjectId. */
function canonicalApplicationId(value) {
  if (value == null || value === "") return "";
  const s = String(value).trim();
  if (mongoose.Types.ObjectId.isValid(s) && String(new mongoose.Types.ObjectId(s)) === s) {
    return new mongoose.Types.ObjectId(s).toString();
  }
  return s;
}

function applicationIdsEqual(a, b) {
  const ca = canonicalApplicationId(a);
  const cb = canonicalApplicationId(b);
  return ca !== "" && ca === cb;
}

async function bulkWriteMaterializedRollup(year, totals, sign = 1) {
  if (!totals?.size) return;
  const ops = [];
  for (const [key, amount] of totals.entries()) {
    const delta = sign * amount;
    if (!delta) continue;
    const [memberId, accountCode, bucket] = key.split("|");
    ops.push({
      updateOne: {
        filter: { memberId, accountCode, bucket, year },
        update: {
          $inc: { amount: delta },
          $set: { updatedAt: new Date() },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await MaterializedBalance.bulkWrite(ops, { ordered: false });
}

/**
 * Move Refund journals still keyed by applicationId on 2020 to the approved memberId,
 * and shift MaterializedBalance from app:{applicationId} to memberId (same deltas as at post time).
 */
export async function relinkRefundGlFromApplicationToMember({
  applicationId,
  memberId,
}) {
  if (!applicationId || !memberId) return { updated: 0 };
  const appId = String(applicationId).trim();
  const mid = String(memberId).trim();

  const appIdOrOid = [{ "entries.applicationId": appId }];
  if (mongoose.Types.ObjectId.isValid(appId)) {
    try {
      appIdOrOid.push({
        "entries.applicationId": new mongoose.Types.ObjectId(appId),
      });
    } catch {
      /* ignore */
    }
  }

  const candidates = await GLTransaction.find({
    docType: "Refund",
    "entries.accountCode": "2020",
    $or: appIdOrOid,
  }).lean();

  const txns = candidates.filter((txn) =>
    (txn.entries || []).some(
      (e) =>
        e.accountCode === "2020" && applicationIdsEqual(e.applicationId, appId),
    ),
  );

  let updated = 0;
  for (const txn of txns) {
    const newEntries = (txn.entries || []).map((e) => {
      if (e.accountCode === "2020" && applicationIdsEqual(e.applicationId, appId)) {
        const { applicationId: _drop, ...rest } = e;
        return { ...rest, memberId: mid };
      }
      return e;
    });

    const same =
      JSON.stringify(txn.entries) === JSON.stringify(newEntries);
    if (same) continue;

    const { year, totals: oldTotals } = rollupMemberBalances({
      date: txn.date,
      entries: txn.entries,
    });
    const { totals: newTotals } = rollupMemberBalances({
      date: txn.date,
      entries: newEntries,
    });

    await bulkWriteMaterializedRollup(year, oldTotals, -1);
    await bulkWriteMaterializedRollup(year, newTotals, 1);

    await GLTransaction.updateOne(
      { _id: txn._id },
      { $set: { entries: newEntries } },
    );
    updated += 1;
  }

  return { updated };
}

/**
 * Sync GL Refund rows to Refund.memberId for posted refunds (handles ObjectId/string drift
 * and cases where application-keyed relink did not match).
 */
export async function relinkPostedRefundGlFromRefundDocuments({
  tenantId,
  applicationId,
  memberId,
}) {
  if (!tenantId) return { updated: 0 };
  const q = {
    tenantId,
    glStatus: "posted",
    memberId: { $nin: [null, ""] },
  };
  if (memberId != null && String(memberId).trim() !== "") {
    q.memberId = String(memberId).trim();
  }

  let refunds = await Refund.find(q)
    .select({ _id: 1, glDocNo: 1, memberId: 1, applicationId: 1 })
    .lean();

  if (applicationId != null && String(applicationId).trim() !== "") {
    const aid = String(applicationId).trim();
    refunds = refunds.filter((r) => applicationIdsEqual(r.applicationId, aid));
  }

  let updated = 0;
  for (const refund of refunds) {
    const target = String(refund.memberId || "").trim();
    if (!target) continue;
    const docNo = refund.glDocNo || `RFD-${refund._id}`;
    const txn = await GLTransaction.findOne({ docNo }).lean();
    if (!txn || txn.docType !== "Refund") continue;

    const newEntries = (txn.entries || []).map((e) => {
      if (e.accountCode !== "2020") return e;
      const hasApp =
        e.applicationId != null && String(e.applicationId).trim() !== "";
      const curMem =
        e.memberId != null ? String(e.memberId).trim() : "";
      if (!hasApp && curMem === target) return e;
      const { applicationId: _drop, memberId: _m, ...rest } = e;
      return {
        ...rest,
        memberId: target,
        periodBucket: e.periodBucket || "current",
      };
    });

    if (JSON.stringify(txn.entries) === JSON.stringify(newEntries)) continue;

    const { year, totals: oldTotals } = rollupMemberBalances({
      date: txn.date,
      entries: txn.entries,
    });
    const { totals: newTotals } = rollupMemberBalances({
      date: txn.date,
      entries: newEntries,
    });

    await bulkWriteMaterializedRollup(year, oldTotals, -1);
    await bulkWriteMaterializedRollup(year, newTotals, 1);

    await GLTransaction.updateOne({ _id: txn._id }, { $set: { entries: newEntries } });
    updated += 1;
  }

  return { updated };
}

// Wrapped in global limiter to prevent connection pool exhaustion
// when multiple heavy operations (batch approvals, batch payments) run simultaneously
export async function postBalancedJournal({
  date,
  docType,
  docNo,
  reference,
  memo,
  lines,
  settlement,
  sourceApplicationId,
  claimMemberId,
  userId,
  tenantId,
  profileId,
  operation,
  paymentMethod,
  batchType,
  batchName,
  batchDetailId,
}) {
  // Wrap entire function in global DB limiter
  // This ensures all journal operations share the same resource pool
  return globalDBLimiter(async () => {
    const enriched = await enrichLines(lines);

    // basic balance check
    const deb = sumArray(enriched, (x) => (x.dc === "D" ? x.amount : 0));
    const cre = sumArray(enriched, (x) => (x.dc === "C" ? x.amount : 0));
    if (deb !== cre)
      throw AppError.badRequest(`Unbalanced journal D ${deb} vs C ${cre}`, {
        debit: deb,
        credit: cre,
      });

    // optional: simple guardrails (kept light; extend as you like)
    // - prevent posting to 1200 (Bank) except via settlements or external refunds (bank payout)
    if (
      docType !== "Settlement" &&
      docType !== "Refund" &&
      enriched.some((e) => e.accountCode === "1200")
    ) {
      throw AppError.badRequest(
        "Only Settlement or Refund documents may post to 1200 (Bank)",
        { accountCode: "1200", docType }
      );
    }
    // - require memberId/applicationId/registrationId and periodBucket on
    //   member-tracked accounts - driven by CoA.isMemberTracked (not a
    //   hardcoded "1400"/"2020" list) so newly-seeded codes (e.g. events/
    //   courses AR/POA) get the same guardrail automatically.
    const memberTrackedCodes = new Set(await getMemberTrackedAccountCodes());
    for (const e of enriched) {
      if (memberTrackedCodes.has(e.accountCode)) {
        if (!e.periodBucket) {
          throw AppError.badRequest(
            `periodBucket required on ${e.accountCode}`,
            {
              accountCode: e.accountCode,
              periodBucket: e.periodBucket,
            }
          );
        }
        if (!e.memberId && !e.applicationId && !e.registrationId && !e.profileId) {
          throw AppError.badRequest(
            `memberId, applicationId, registrationId or profileId required on ${e.accountCode}`,
            {
              accountCode: e.accountCode,
              memberId: e.memberId,
              applicationId: e.applicationId,
              registrationId: e.registrationId,
              profileId: e.profileId,
            }
          );
        }
      }
    }

    // idempotency on docNo
    const exists = await GLTransaction.findOne({ docNo }).lean();
    if (exists) return exists;

    // strip helper and persist
    const entries = enriched.map(({ _a, ...rest }) => rest);
    const txn = await GLTransaction.create({
      date,
      ...(userId != null && String(userId).trim() !== ""
        ? { userId: String(userId).trim() }
        : {}),
      docType,
      docNo,
      ...(reference != null && String(reference).trim() !== ""
        ? { reference: String(reference).trim() }
        : {}),
      memo,
      entries,
      ...(settlement && { settlement }),
      ...(sourceApplicationId != null &&
      String(sourceApplicationId).trim() !== ""
        ? { sourceApplicationId: String(sourceApplicationId).trim() }
        : {}),
      ...(claimMemberId != null && String(claimMemberId).trim() !== ""
        ? { claimMemberId: String(claimMemberId).trim() }
        : {}),
    });

    const { year, totals } = rollupMemberBalances({ date, entries });
    await bulkWriteMaterializedRollup(year, totals, 1);

    const memberId = resolveMemberIdForJournalEvent({
      claimMemberId: txn.claimMemberId,
      entries: txn.entries,
      memo: txn.memo,
      lines,
    });

    const resolvedTenantId =
      tenantId != null && String(tenantId).trim()
        ? String(tenantId).trim()
        : undefined;

    const resolvedProfileId =
      profileId != null && String(profileId).trim()
        ? String(profileId).trim()
        : undefined;

    const adjSubType = (lines || []).find((l) => l?.adjSubType)?.adjSubType;
    const resolvedPaymentMethod =
      paymentMethod ||
      (batchType ? paymentMethodFromBatchType(batchType) : null) ||
      inferPaymentMethodFromLines(lines || txn.entries);

    const auditAction = resolveJournalAuditAction({
      docType: txn.docType,
      operation,
      paymentMethod: resolvedPaymentMethod,
      adjSubType,
      settlement: txn.settlement,
    });

    const financeSnapshot = buildFinanceAuditSnapshot({
      docNo: txn.docNo,
      docType: txn.docType,
      date: txn.date,
      reference: txn.reference,
      memo: txn.memo,
      memberId: memberId || undefined,
      profileId: resolvedProfileId,
      paymentMethod: resolvedPaymentMethod,
      operation: operation || "postBalancedJournal",
      totalDebit: deb,
      totalCredit: cre,
      settlement: txn.settlement,
      batchType,
      batchName,
      batchDetailId,
    });

    // Publish journal created event
    await publishDomainEvent(
      EVENT_TYPES.JOURNAL_CREATED,
      {
        journalId: txn._id,
        docNo: txn.docNo,
        docType: txn.docType,
        date: txn.date,
        reference: txn.reference,
        memo: txn.memo,
        sourceApplicationId: txn.sourceApplicationId,
        claimMemberId: txn.claimMemberId,
        memberId: memberId || undefined,
        profileId: resolvedProfileId,
        tenantId: resolvedTenantId,
        createdBy: userId != null ? String(userId) : undefined,
        action: auditAction,
        paymentMethod: resolvedPaymentMethod,
        operation: operation || "postBalancedJournal",
        entries: txn.entries,
        totalDebit: deb,
        totalCredit: cre,
        financeSnapshot,
      },
      {
        source: "journal.controller",
        operation: operation || "postBalancedJournal",
        action: auditAction,
        ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
      }
    );

    const financeDocTypes = new Set(["Receipt", "Claim", "Refund", "WriteOff"]);
    if (resolvedTenantId && memberId && financeDocTypes.has(txn.docType)) {
      notifyMemberFinanceUpdated({
        tenantId: resolvedTenantId,
        memberId,
        docType: txn.docType,
        docNo: txn.docNo,
      }).catch(() => {});
      publishMemberCreditReportingEvent({
        tenantId: resolvedTenantId,
        memberId,
        docType: txn.docType,
        docNo: txn.docNo,
        correlationId: req.headers?.["x-correlation-id"],
      }).catch(() => {});
    }

    if (
      resolvedTenantId &&
      memberId &&
      txn.docType === "Receipt" &&
      txn.entries?.some(
        (e) =>
          e.dc === "C" &&
          e.memberId &&
          (e.accountCode === "1400" || e.accountCode === "2020")
      )
    ) {
      notifyMemberPaymentReceiptPosted({
        tenantId: resolvedTenantId,
        memberId,
        docNo: txn.docNo,
        date: txn.date,
      }).catch(() => {});
    }

    // add a friendly label in the response
    const obj = txn.toObject();
    obj.entries = obj.entries.map((e) => ({
      ...e,
      accountLabel: `${e.accountCode} (${e.accountName})`,
    }));
    return obj;
  });
}

// Invoice → 1400 (Accounts receivable - Members) debit, income credit
export async function invoice(req, res, next) {
  try {
    const {
      date, // ISO
      docNo,
      memberId,
      applicationId,
      annualFee,
      incomeCode, // e.g. "4000"
      categoryName, // e.g. "General All Grades"
      periodBucket = "current",
      joinDate, // optional ISO for mid-year join
    } = req.body;

    // Validate annualFee is integer (cents)
    if (!Number.isInteger(annualFee) || annualFee <= 0) {
      throw AppError.badRequest(
        "annualFee must be a positive integer (minor units, e.g., 32600 for €326.00)"
      );
    }

    if (!memberId && !applicationId) {
      throw AppError.badRequest("memberId or applicationId is required", {
        memberId,
        applicationId,
      });
    }

    const arLine = {
      accountCode: "1400",
      dc: "D",
      amount: annualFee,
      periodBucket,
    };
    if (memberId) arLine.memberId = memberId;
    else arLine.applicationId = applicationId;

    logInfo("Creating invoice", {
      docNo,
      memberId,
      applicationId,
      annualFee,
      annualFeeInEuros: (annualFee / 100).toFixed(2), // For logging clarity
      categoryName,
    });

    const year = new Date(date).getFullYear();
    const memoBase = `Subscription ${year} – ${categoryName}`;

    // 1) Full-year invoice
    const inv = await postBalancedJournal({
      date,
      userId: req.ctx?.userId,
      docType: "Invoice",
      docNo,
      memo: memoBase,
      lines: [
        arLine,
        {
          accountCode: incomeCode,
          dc: "C",
          amount: annualFee,
          revenueSubType: "fee",
          categoryName,
        },
      ],
    });
    const out = [inv];

    // 2) Daily pro-rata credit if joinDate given
    // annualFee is in cents, prorata functions now return cents
    if (joinDate) {
      const due = prorataFromJoinToYearEnd(annualFee, joinDate); // Returns cents
      const reduction = annualFee - due; // Both in cents, result is cents

      if (reduction > 0) {
        const { startISO, endISO } = yearBoundsFrom(joinDate);
        const lastUnusedISO = dayjs(joinDate)
          .subtract(1, "day")
          .format("YYYY-MM-DD");
        const memo = `Adjustment – Pro-rata fee (${categoryName}) credit for unused period ${startISO} → ${lastUnusedISO} (subscription period ${joinDate} → ${endISO})`;
        const cn = await postBalancedJournal({
          date,
          userId: req.ctx?.userId,
          docType: "Adjustment",
          docNo: `${docNo}-PRORATA`,
          memo,
          lines: [
            {
              accountCode: "4900",
              dc: "D",
              amount: reduction,
              adjSubType: "prorata-fee-adjustment",
              categoryName,
            },
            {
              accountCode: "1400",
              dc: "C",
              amount: reduction,
              ...(memberId ? { memberId } : { applicationId }),
              periodBucket,
            },
          ],
        });
        out.push(cn);
      }
    }

    res.created(out);
    logInfo("Invoice created successfully", {
      docNo,
      memberId,
      applicationId,
      invoiceCount: out.length,
    });
  } catch (e) {
    logError("Invoice creation failed", {
      docNo,
      memberId,
      applicationId,
      error: e.message,
    });
    next(e);
  }
}

/**
 * Category change: single balanced adjustment — member pays only prorated amounts for the calendar year.
 *
 * - Recognises **new** tier revenue for **changeDate → year-end** only (not full annual).
 * - Releases **old** tier revenue for the same tail (**unused** portion after switch), matching prior
 *   full-year-old-tier billing convention.
 * - Net AR = new-tier slice − old-tier slice = prorated (newAnnual − oldAnnual) over those days.
 *
 * Fee Increase / Fee Increase lines reflect the **incremental** new-tier credit when upgrading;
 * Fee Decrease when downgrading. Assumes prior membership invoices followed the same annual basis.
 *
 * @param {string} previousSubscriptionStartDate - Subscription **startDate before category update** (YYYY-MM-DD).
 */
export async function postCategoryChangeJournals({
  date,
  docNoBase,
  memberId,
  oldIncomeCode,
  oldCategoryName,
  oldAnnualFee,
  newIncomeCode,
  newCategoryName,
  newAnnualFee,
  changeDate,
  previousSubscriptionStartDate,
  periodBucket = "current",
  userId,
}) {
  const { lines, memo } = buildCategoryChangeJournalPayload({
    memberId,
    oldIncomeCode,
    oldCategoryName,
    oldAnnualFee,
    newIncomeCode,
    newCategoryName,
    newAnnualFee,
    changeDate,
    previousSubscriptionStartDate,
    periodBucket,
  });

  const txn = await postBalancedJournal({
    date,
    userId,
    docType: "Adjustment",
    docNo: `${docNoBase}-CATNET`,
    memo,
    lines,
  });

  return [txn];
}

export async function changeCategory(req, res, next) {
  try {
    // previousStartDate = subscription startDate before category change (same snapshot PUT uses for Rabbit).
    const {
      date,
      docNoBase,
      memberId,
      oldIncomeCode,
      oldCategoryName,
      oldAnnualFee,
      newIncomeCode,
      newCategoryName,
      newAnnualFee,
      changeDate,
      previousStartDate,
      periodBucket = "current",
    } = req.body;

    const results = await postCategoryChangeJournals({
      date,
      docNoBase,
      memberId,
      oldIncomeCode,
      oldCategoryName,
      oldAnnualFee,
      newIncomeCode,
      newCategoryName,
      newAnnualFee,
      changeDate,
      previousSubscriptionStartDate: previousStartDate,
      periodBucket,
      userId: req.ctx?.userId,
    });

    res.created(results);
  } catch (e) {
    next(e);
  }
}

/** @deprecated Use creditNote.controller create + approve flow */
export async function creditNote(req, res, next) {
  try {
    const { createCreditNoteDraft } = await import(
      "../services/creditNote.service.js"
    );
    const {
      date,
      docNo,
      memberId,
      invoiceDocNo,
      amount,
      periodBucket = "current",
      reason,
      notes,
    } = req.body;

    if (!invoiceDocNo) {
      throw AppError.badRequest(
        "invoiceDocNo is required; credit notes reverse a specific invoice",
      );
    }

    const cents = Math.round(Number(amount));
    if (!Number.isInteger(cents) || cents <= 0) {
      throw AppError.badRequest(
        "amount must be a positive integer (minor units)",
      );
    }

    const { creditNote: cn } = await createCreditNoteDraft({
      docNo,
      memberId,
      invoiceDocNo,
      amount: cents,
      periodBucket,
      reason: reason || "Legacy credit-note endpoint",
      notes,
      effectiveDate: date,
      createdBy: req.ctx?.userId,
    });
    res.status(201).json({
      ...cn,
      message: "Credit note saved as Draft; POST /credit-notes/:docNo/approve to post GL",
    });
  } catch (e) {
    next(e);
  }
}

// Receipt (unlinked money-in) → 12xx clearing debit, 2020 (Payment on Account - Member credits) credit

export async function receipt(req, res, next) {
  try {
    const {
      date,
      docNo,
      memberId,
      applicationId,
      amount,
      clearingCode,
      bucket = "current",
      provider,
    } = req.body;

    // Validate amount is integer (cents)
    if (!Number.isInteger(amount) || amount <= 0) {
      throw AppError.badRequest(
        "amount must be a positive integer (minor units, e.g., 32600 for €326.00)"
      );
    }

    if (!memberId && !applicationId)
      throw AppError.badRequest("memberId or applicationId is required", {
        memberId,
        applicationId,
      });

    let creditLines;
    if (memberId && bucket === "current") {
      creditLines = await buildMemberReceiptCreditEntries(memberId, amount, date);
    } else {
      const entry2020 = {
        accountCode: "2020",
        dc: "C",
        amount,
        periodBucket: bucket,
      };
      if (memberId) entry2020.memberId = memberId;
      else entry2020.applicationId = applicationId;
      creditLines = [entry2020];
    }

    const lines = [
      { accountCode: clearingCode, dc: "D", amount },
      ...creditLines,
    ];

    // Stripe fee applied against the clearing account
    let settlement = null;
    if (provider === "stripe" || provider === "Stripe") {
      const { feeNoVat } = stripeFeeBreakdown(amount);
      lines.push({ accountCode: "5100", dc: "D", amount: feeNoVat }); // Payment processing fees
      lines.push({ accountCode: clearingCode, dc: "C", amount: feeNoVat }); // Credit clearing for fees
      // Set settlement info for Stripe payments
      settlement = {
        provider: "Stripe",
        status: "PENDING",
      };
    }

    // Create receipt memo - prioritize memberId if present, otherwise use applicationId
    const memo = memberId
      ? `Receipt (member ${memberId})`
      : applicationId
      ? `Receipt (app ${applicationId})`
      : "Receipt";

    const out = await postBalancedJournal({
      date,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId ?? req.tenantId,
      docType: "Receipt",
      docNo,
      memo,
      lines,
      settlement,
      paymentMethod: inferPaymentMethodFromLines(lines),
    });
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
}

/**
 * Process batch payments (deduction batch): shared by HTTP handler and RabbitMQ worker.
 * @param {string|Date} paymentDate
 * @param {Array} batchPayments
 * @returns {Promise<{ processed: number, failed: number, results: array, errors?: array }>}
 */
export async function runProcessDeductionBatchPayments(
  paymentDate,
  batchPayments,
  options = {}
) {
  const userId =
    options?.userId != null && String(options.userId).trim() !== ""
      ? String(options.userId).trim()
      : undefined;
  if (!batchPayments || !Array.isArray(batchPayments) || batchPayments.length === 0) {
    throw AppError.badRequest("batchPayments array is required and must not be empty", {
      batchPayments: batchPayments ?? "missing",
    });
  }

  const date =
    paymentDate instanceof Date ? paymentDate : new Date(paymentDate);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest("paymentDate must be a valid date", { paymentDate });
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < batchPayments.length; i++) {
    const row = batchPayments[i];
    const membershipNumber = row?.membershipNumber ?? row?.fileRow?.membershipNumber;
    const amount = row?.fileRow?.valueForPeriodSelected ?? row?.valueForPeriodSelected;

    if (!membershipNumber) {
      errors.push({ index: i, reason: "membershipNumber missing" });
      continue;
    }
    if (amount == null || Number(amount) <= 0) {
      errors.push({
        index: i,
        membershipNumber,
        reason: "valueForPeriodSelected missing or not positive",
      });
      continue;
    }

    const amountNum = Number(amount);

    const creditLines = await buildMemberReceiptCreditEntries(
      String(membershipNumber),
      amountNum,
      date,
    );
    const lines = [
      { accountCode: "1230", dc: "D", amount: amountNum },
      ...creditLines,
    ];

    const settlement = {
      provider: "test",
      status: "PENDING",
    };

    try {
      const txn = await postBalancedJournal({
        date,
        userId,
        profileId: row?.profileId ? String(row.profileId) : undefined,
        docType: "Receipt",
        docNo: `test-${randomUUID()}`,
        memo: "test",
        lines,
        operation: "batch_payment",
        paymentMethod: "salary_deduction",
        batchType: "deduction",
        settlement,
      });
      results.push({
        index: i,
        membershipNumber,
        amount: amountNum,
        docNo: txn.docNo,
        id: txn._id,
      });
    } catch (err) {
      errors.push({
        index: i,
        membershipNumber,
        reason: err.message || "postBalancedJournal failed",
      });
    }
  }

  return {
    processed: results.length,
    failed: errors.length,
    results,
    errors: errors.length ? errors : undefined,
  };
}

function resolveBatchClearingCode(batchType) {
  const normalized = String(batchType || "")
    .trim()
    .toLowerCase();
  if (normalized === "deduction") return "1230";
  if (normalized === "standing order" || normalized === "standing-order") {
    return "1240";
  }
  return "1230";
}

/**
 * Process batch payments with clearing account mapping by batch type.
 * - deduction => 1230
 * - standing order => 1240
 */
export async function runProcessBatchPayments(
  paymentDate,
  batchPayments,
  batchType,
  options = {}
) {
  const userId =
    options?.userId != null && String(options.userId).trim() !== ""
      ? String(options.userId).trim()
      : undefined;
  const batchName =
    typeof options.batchName === "string" ? options.batchName.trim() : "";
  const referenceNumber =
    typeof options.referenceNumber === "string"
      ? options.referenceNumber.trim()
      : "";
  const tenantId =
    options?.tenantId != null && String(options.tenantId).trim() !== ""
      ? String(options.tenantId).trim()
      : undefined;
  const batchDetailId =
    options?.batchDetailId != null && String(options.batchDetailId).trim() !== ""
      ? String(options.batchDetailId).trim()
      : undefined;

  if (!batchPayments || !Array.isArray(batchPayments) || batchPayments.length === 0) {
    throw AppError.badRequest("batchPayments array is required and must not be empty", {
      batchPayments: batchPayments ?? "missing",
    });
  }

  const date =
    paymentDate instanceof Date ? paymentDate : new Date(paymentDate);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest("paymentDate must be a valid date", { paymentDate });
  }

  const clearingCode = resolveBatchClearingCode(batchType);
  const results = [];
  const errors = [];

  for (let i = 0; i < batchPayments.length; i++) {
    const row = batchPayments[i];
    const membershipNumber = row?.membershipNumber ?? row?.fileRow?.membershipNumber;
    const amount = row?.fileRow?.valueForPeriodSelected ?? row?.valueForPeriodSelected;
    const rowIndex = row?.fileRow?.rowIndex ?? row?.rowIndex ?? i + 1;

    if (!membershipNumber) {
      errors.push({ index: i, reason: "membershipNumber missing" });
      continue;
    }
    if (amount == null || Number(amount) <= 0) {
      errors.push({
        index: i,
        membershipNumber,
        reason: "valueForPeriodSelected missing or not positive",
      });
      continue;
    }

    const amountNum = Number(amount);
    const creditLines = await buildMemberReceiptCreditEntries(
      String(membershipNumber),
      amountNum,
      date,
    );
    const lines = [
      { accountCode: clearingCode, dc: "D", amount: amountNum },
      ...creditLines,
    ];

    try {
      const memoParts = [];
      if (batchName) memoParts.push(`Batch: ${batchName}`);
      if (referenceNumber) memoParts.push(`Ref: ${referenceNumber}`);
      memoParts.push(`Member: ${String(membershipNumber)} Row: ${rowIndex}`);

      const txn = await postBalancedJournal({
        date,
        userId,
        tenantId,
        profileId: row?.profileId ? String(row.profileId) : undefined,
        docType: "Receipt",
        docNo: `batch-${randomUUID()}`,
        memo: memoParts.join(" | "),
        lines,
        operation: "batch_payment",
        paymentMethod: paymentMethodFromBatchType(batchType),
        batchType,
        batchName: batchName || undefined,
        batchDetailId,
        settlement: {
          provider: "batch",
          status: "PENDING",
        },
      });
      results.push({
        index: i,
        rowIndex,
        membershipNumber,
        amount: amountNum,
        clearingCode,
        docNo: txn.docNo,
        id: txn._id,
      });
    } catch (err) {
      errors.push({
        index: i,
        rowIndex,
        membershipNumber,
        reason: err.message || "postBalancedJournal failed",
      });
    }
  }

  return {
    processed: results.length,
    failed: errors.length,
    results,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * Process batch: HTTP entry; body { paymentDate, batchPayments }.
 */
export async function processDeductionBatch(req, res, next) {
  try {
    const out = await runProcessDeductionBatchPayments(
      req.body.paymentDate,
      req.body.batchPayments,
      { userId: req.ctx?.userId }
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
}

/** YYYY-MM-DD for journal header date, or null if invalid. */
function journalIsoDateFromValue(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

/**
 * Claim document date should reflect when application payment was processed:
 * Payment.updatedAt if receipt is RCP-{paymentId}, else source receipt GL date, else tenant latest succeeded payment, else caller body date.
 */
async function resolveClaimJournalDate({
  parentCreditTxn,
  applicationId,
  tenantId,
  bodyDateIso,
}) {
  const docNoStr = parentCreditTxn?.docNo && String(parentCreditTxn.docNo);
  const rcpMatch = docNoStr?.match(/^RCP-([a-fA-F0-9]{24})$/);
  if (rcpMatch && mongoose.Types.ObjectId.isValid(rcpMatch[1])) {
    const payment = await Payment.findById(rcpMatch[1])
      .select({ status: 1, updatedAt: 1 })
      .lean();
    if (payment?.status === "succeeded" && payment.updatedAt) {
      const iso = journalIsoDateFromValue(payment.updatedAt);
      if (iso) return iso;
    }
  }

  const fromReceiptJournal = journalIsoDateFromValue(parentCreditTxn?.date);
  if (fromReceiptJournal) return fromReceiptJournal;

  if (tenantId) {
    const payment = await Payment.findOne({
      tenantId,
      applicationId,
      status: "succeeded",
    })
      .sort({ updatedAt: -1 })
      .select({ updatedAt: 1 })
      .lean();
    if (payment?.updatedAt) {
      const iso = journalIsoDateFromValue(payment.updatedAt);
      if (iso) return iso;
    }
  }

  return (
    journalIsoDateFromValue(bodyDateIso) ||
    new Date().toISOString().split("T")[0]
  );
}

// Claim credit: transfer 2020 Payment on Account from app to member
export async function claimApplicationCredit(req, res, next) {
  try {
    const {
      date,
      docNo,
      applicationId,
      memberId,
      bucket = "current",
    } = req.body;
    if (!applicationId || !memberId) {
      throw AppError.badRequest("applicationId and memberId are required", {
        applicationId,
        memberId,
      });
    }

    const tenantId = req.tenantId ?? req.ctx?.tenantId;

    // Find the credit entry for this application
    // Check both new format (applicationId) and old format (memberId: "app:...")
    const appMember = `app:${applicationId}`;
    const creditEntry = await GLTransaction.aggregate([
      { $unwind: "$entries" },
      {
        $match: {
          $or: [
            { "entries.applicationId": applicationId },
            { "entries.memberId": appMember },
          ],
          "entries.accountCode": "2020",
          "entries.dc": "C",
        },
      },
      { $limit: 1 },
    ]);

    if (!creditEntry.length) {
      throw AppError.notFound(
        `No credit entry found for application ${applicationId}`,
        { applicationId }
      );
    }

    const resolvedClaimDate = await resolveClaimJournalDate({
      parentCreditTxn: creditEntry[0],
      applicationId,
      tenantId,
      bodyDateIso: date,
    });

    const amount = creditEntry[0].entries.amount;
    if (!amount || amount <= 0) {
      throw AppError.badRequest(
        `Invalid credit amount for application ${applicationId}`,
        { applicationId, amount }
      );
    }

    // Build debit entry - use applicationId if the original entry had it, otherwise use memberId
    const originalEntry = creditEntry[0].entries;
    const debitEntry = {
      accountCode: "2020",
      dc: "D",
      amount,
      periodBucket: bucket,
    };

    if (originalEntry.applicationId) {
      debitEntry.applicationId = originalEntry.applicationId;
    } else if (
      originalEntry.memberId &&
      originalEntry.memberId.startsWith("app:")
    ) {
      // Old format - keep using memberId for backward compatibility
      debitEntry.memberId = originalEntry.memberId;
    } else {
      // Fallback to applicationId
      debitEntry.applicationId = applicationId;
    }

    const lines = [
      debitEntry,
      { accountCode: "2020", dc: "C", amount, memberId, periodBucket: bucket },
    ];

    const out = await postBalancedJournal({
      date: resolvedClaimDate,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId ?? req.tenantId,
      docType: "Claim",
      docNo,
      memo: `Claim app credit ${applicationId} → ${memberId}`,
      lines,
      sourceApplicationId: applicationId,
      claimMemberId: memberId,
    });

    res.created(out);
  } catch (e) {
    next(e);
  }
}

function resolveWriteOffDocNo(docNo) {
  const trimmed = docNo != null ? String(docNo).trim() : "";
  if (trimmed) return trimmed;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  return `WO-${suffix}`;
}

export async function writeOff(req, res, next) {
  try {
    const {
      date,
      docNo,
      memberId,
      amount,
      periodBucket = "current",
      memo: bodyMemo,
    } = req.body;
    const resolvedDocNo = resolveWriteOffDocNo(docNo);
    const userMemo =
      bodyMemo != null && String(bodyMemo).trim() !== ""
        ? String(bodyMemo).trim()
        : "";
    const memo = userMemo ? `Write off (${userMemo})` : "Write off";
    const out = await postBalancedJournal({
      date,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId ?? req.tenantId,
      docType: "WriteOff",
      docNo: resolvedDocNo,
      memo,
      lines: [
        { accountCode: "5200", dc: "D", amount, adjSubType: "writeoff" },
        { accountCode: "1400", dc: "C", amount, memberId, periodBucket },
      ],
    });
    res.created(out);
  } catch (e) {
    next(e);
  }
}

// List journals
/**
 * GET /api/journal
 * Query params:
 *  - from, to: ISO dates
 *  - docType: e.g. Invoice, Adjustment, Receipt, Claim, Refund, Settlement
 *  - memberId: exact match on entries.memberId
 *  - skip, limit: pagination (defaults: 0, 500; max limit 1000)
 */
export async function listJournals(req, res, next) {
  try {
    const { from, to, docType, memberId, limit = 500, skip = 0 } = req.query;

    const query = {};
    if (from || to) {
      query.date = {};
      if (from) {
        const fromDate = new Date(from);
        fromDate.setHours(0, 0, 0, 0);
        query.date.$gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.date.$lte = toDate;
      }
    }
    if (docType) {
      // Case-insensitive docType matching
      query.docType = { $regex: new RegExp(`^${docType}$`, "i") };
    }
    if (memberId) query["entries.memberId"] = memberId;

    logInfo("Journal query", {
      query,
      params: { from, to, docType, memberId },
    });

    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
    const offset = Math.max(parseInt(skip, 10) || 0, 0);

    const [items, total] = await Promise.all([
      GLTransaction.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(pageSize)
        .lean(),
      GLTransaction.countDocuments(query),
    ]);

    logInfo("Journal query results", { total, itemsCount: items.length });

    const itemsWithTxType = await attachTxTypesToLedgerItems(items);

    res.success({
      total,
      skip: offset,
      limit: pageSize,
      items: itemsWithTxType,
    });
  } catch (err) {
    next(err);
  }
}

// List Stripe receipts with settlement status filtering
/**
 * GET /api/journal/stripe-payments
 * Query params:
 *  - from, to: ISO dates
 *  - status: PENDING | SETTLED | ALL (default: PENDING)
 *  - skip, limit: pagination (defaults: 0, 500; max limit 1000)
 */
export async function listStripePayments(req, res, next) {
  try {
    const { from, to, status = "PENDING", limit = 500, skip = 0 } = req.query;

    const query = {
      docType: "Receipt",
      "settlement.provider": "Stripe",
    };

    if (from || to) {
      query.date = {};
      if (from) {
        const fromDate = new Date(from);
        fromDate.setHours(0, 0, 0, 0);
        query.date.$gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.date.$lte = toDate;
      }
    }

    if (status && status !== "ALL") {
      query["settlement.status"] = status;
    }

    logInfo("Stripe payments query", {
      query,
      params: { from, to, status },
    });

    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
    const offset = Math.max(parseInt(skip, 10) || 0, 0);

    const [rawItems, total] = await Promise.all([
      GLTransaction.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(pageSize)
        .lean(),
      GLTransaction.countDocuments(query),
    ]);

    const enriched = await enrichStripePaymentItems(rawItems, req);
    const items = await attachTxTypesToLedgerItems(enriched);

    logInfo("Stripe payments query results", {
      total,
      itemsCount: rawItems.length,
      enrichedItemsCount: items.length,
    });

    res.success({
      total,
      skip: offset,
      limit: pageSize,
      items,
    });
  } catch (err) {
    next(err);
  }
}
