// src/controllers/journal.controller.js
import CoA from "../models/coa.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import MaterializedBalance from "../models/materializedBalance.model.js";
import dayjs from "dayjs";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn, logError } from "../middlewares/logger.mw.js";
// import { calculateProRataFee } from "../helpers/prorata.js";
import {
  prorataFromJoinToYearEnd,
  yearBoundsFrom,
  prorataForPeriod,
} from "../helpers/prorata.js";
import { stripeFeeBreakdown } from "../helpers/fees.js";
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";

function sumArray(arr, sel) {
  return Number(arr.reduce((s, x) => s + sel(x), 0).toFixed(2));
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

function rollupMemberBalances({ date, entries }) {
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

export async function postBalancedJournal({
  date,
  docType,
  docNo,
  memo,
  lines,
  settlement,
}) {
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
  // - prevent posting to 1200 (Bank) except via settlements
  if (
    docType !== "Settlement" &&
    enriched.some((e) => e.accountCode === "1200")
  ) {
    throw AppError.badRequest(
      "Only Settlement documents may post to 1200 (Bank)",
      { accountCode: "1200", docType }
    );
  }
  // - require memberId OR applicationId and periodBucket on member-tracked accounts (1400, 2020)
  for (const e of enriched) {
    if (e.accountCode === "1400" || e.accountCode === "2020") {
      if (!e.periodBucket) {
        throw AppError.badRequest(`periodBucket required on ${e.accountCode}`, {
          accountCode: e.accountCode,
          periodBucket: e.periodBucket,
        });
      }
      if (!e.memberId && !e.applicationId) {
        throw AppError.badRequest(
          `memberId or applicationId required on ${e.accountCode}`,
          {
            accountCode: e.accountCode,
            memberId: e.memberId,
            applicationId: e.applicationId,
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
    docType,
    docNo,
    memo,
    entries,
    ...(settlement && { settlement }),
  });

  const { year, totals } = rollupMemberBalances({ date, entries });
  if (totals.size) {
    const ops = [];
    for (const [key, amount] of totals.entries()) {
      const [memberId, accountCode, bucket] = key.split("|");
      ops.push({
        updateOne: {
          filter: { memberId, accountCode, bucket, year },
          update: {
            $inc: { amount },
            $set: { updatedAt: new Date() },
          },
          upsert: true,
        },
      });
    }
    await MaterializedBalance.bulkWrite(ops, { ordered: false });
  }

  // Publish journal created event
  await publishDomainEvent(
    EVENT_TYPES.JOURNAL_CREATED,
    {
      journalId: txn._id,
      docNo: txn.docNo,
      docType: txn.docType,
      date: txn.date,
      memo: txn.memo,
      entries: txn.entries,
      totalDebit: deb,
      totalCredit: cre,
    },
    {
      source: "journal.controller",
      operation: "postBalancedJournal",
    }
  );

  // add a friendly label in the response
  const obj = txn.toObject();
  obj.entries = obj.entries.map((e) => ({
    ...e,
    accountLabel: `${e.accountCode} (${e.accountName})`,
  }));
  return obj;
}

// Invoice → 1400 (Accounts receivable - Members) debit, income credit
export async function invoice(req, res, next) {
  try {
    const {
      date, // ISO
      docNo,
      memberId,
      annualFee,
      incomeCode, // e.g. "4000"
      categoryName, // e.g. "General All Grades"
      periodBucket = "current",
      joinDate, // optional ISO for mid-year join
    } = req.body;

    logInfo("Creating invoice", { docNo, memberId, annualFee, categoryName });

    const year = new Date(date).getFullYear();
    const memoBase = `Subscription ${year} – ${categoryName}`;

    // 1) Full-year invoice
    const inv = await postBalancedJournal({
      date,
      docType: "Invoice",
      docNo,
      memo: memoBase,
      lines: [
        {
          accountCode: "1400",
          dc: "D",
          amount: annualFee,
          memberId,
          periodBucket,
        },
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
    if (joinDate) {
      const due = prorataFromJoinToYearEnd(annualFee, joinDate); // uses daysInYear() inside
      const reduction =
        Math.round((annualFee - due + Number.EPSILON) * 100) / 100;

      if (reduction > 0) {
        const { endISO } = yearBoundsFrom(joinDate);
        const cn = await postBalancedJournal({
          date,
          docType: "Adjustment",
          docNo: `${docNo}-PRORATA`,
          memo: `Adjustment – Pro-rata fee (${categoryName}) ${joinDate} → ${endISO}`,
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
              memberId,
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
      invoiceCount: out.length,
    });
  } catch (e) {
    logError("Invoice creation failed", { docNo, memberId, error: e.message });
    next(e);
  }
}

export async function changeCategory(req, res, next) {
  try {
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
      changeDate, // ISO (within target year)
      periodBucket = "current",
    } = req.body;

    const { startISO, endISO, year } = yearBoundsFrom(changeDate);
    // pre-change ends the day before change
    const changeMinusISO = new Date(
      new Date(changeDate).getTime() - 24 * 3600 * 1000
    )
      .toISOString()
      .slice(0, 10);

    const isUpgrade = Number(newAnnualFee) > Number(oldAnnualFee);

    const results = [];

    // 1) New category full-year invoice
    results.push(
      await postBalancedJournal({
        date,
        docType: "Invoice",
        docNo: `${docNoBase}-INVNEW`,
        memo: `Subscription ${year} – ${newCategoryName}`,
        lines: [
          {
            accountCode: "1400",
            dc: "D",
            amount: newAnnualFee,
            memberId,
            periodBucket,
          },
          {
            accountCode: newIncomeCode,
            dc: "C",
            amount: newAnnualFee,
            revenueSubType: "fee",
            categoryName: newCategoryName,
          },
        ],
      })
    );

    // 2) Credit unused portion of OLD category: changeDate → year end (explicit daysInYear)
    // For upgrade: credits unused portion of OLD (lower) category
    // For downgrade: credits unused portion of OLD (higher) category
    const creditOldUnused = prorataForPeriod(oldAnnualFee, changeDate, endISO);
    if (creditOldUnused > 0) {
      results.push(
        await postBalancedJournal({
          date,
          docType: "Adjustment",
          docNo: `${docNoBase}-COLD`,
          memo: `Adjustment – Unused period credit (${oldCategoryName}) ${changeDate} → ${endISO}`,
          lines: [
            {
              accountCode: "4900",
              dc: "D",
              amount: creditOldUnused,
              adjSubType: isUpgrade
                ? "category-upgrade-unused-credit"
                : "category-downgrade-unused-credit",
              categoryName: oldCategoryName,
            },
            {
              accountCode: "1400",
              dc: "C",
              amount: creditOldUnused,
              memberId,
              periodBucket,
            },
          ],
        })
      );
    }

    // 3) Credit pre-change portion of NEW category: year start → (changeDate − 1)
    const creditNewPre = prorataForPeriod(
      newAnnualFee,
      startISO,
      changeMinusISO
    );
    if (creditNewPre > 0) {
      results.push(
        await postBalancedJournal({
          date,
          docType: "Adjustment",
          docNo: `${docNoBase}-CNEW`,
          memo: `Adjustment – Pre-change portion credit (${newCategoryName}) ${startISO} → ${changeMinusISO}`,
          lines: [
            {
              accountCode: "4900",
              dc: "D",
              amount: creditNewPre,
              adjSubType: "category-change-prorata-credit",
              categoryName: newCategoryName,
            },
            {
              accountCode: "1400",
              dc: "C",
              amount: creditNewPre,
              memberId,
              periodBucket,
            },
          ],
        })
      );
    }

    res.created(results);
  } catch (e) {
    next(e);
  }
}

export async function creditNote(req, res, next) {
  try {
    const {
      date,
      docNo,
      memberId,
      amount,
      periodBucket = "current",
      adjSubType = "manual-discount",
      categoryName,
    } = req.body;
    const out = await postBalancedJournal({
      date,
      docType: "Adjustment",
      docNo,
      memo: `Adjustment – ${categoryName || adjSubType}`,
      lines: [
        { accountCode: "4900", dc: "D", amount, adjSubType, categoryName },
        { accountCode: "1400", dc: "C", amount, memberId, periodBucket },
      ],
    });
    res.status(201).json(out);
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
    if (!memberId && !applicationId)
      throw AppError.badRequest("memberId or applicationId is required", {
        memberId,
        applicationId,
      });

    // Build entry for account 2020 - use memberId if present, otherwise applicationId
    const entry2020 = {
      accountCode: "2020",
      dc: "C",
      amount,
      periodBucket: bucket,
    };

    if (memberId) {
      entry2020.memberId = memberId;
    } else if (applicationId) {
      entry2020.applicationId = applicationId;
    }

    const lines = [
      { accountCode: clearingCode, dc: "D", amount }, // 1210..1250
      entry2020, // Payment on Account - Member credits (2020)
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
      docType: "Receipt",
      docNo,
      memo,
      lines,
      settlement,
    });
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
}

// “claim credit” endpoint (transfer 2020 Payment on Account - Member credits from app → member)
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
      date,
      docType: "Claim",
      docNo,
      memo: `Claim app credit ${applicationId} → ${memberId}`,
      lines,
    });

    res.created(out);
  } catch (e) {
    next(e);
  }
}

export async function writeOff(req, res, next) {
  try {
    const {
      date,
      docNo,
      memberId,
      amount,
      periodBucket = "current",
    } = req.body;
    const out = await postBalancedJournal({
      date,
      docType: "WriteOff",
      docNo,
      memo: "Bad debt write-off",
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
 *  - docType: e.g. Invoice, Adjustment, Receipt, Settlement
 *  - memberId: exact match on entries.memberId
 *  - skip, limit: pagination (defaults: 0, 50; max limit 200)
 */
export async function listJournals(req, res, next) {
  try {
    const { from, to, docType, memberId, limit = 50, skip = 0 } = req.query;

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

    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
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

// List Stripe receipts with settlement status filtering
/**
 * GET /api/journal/stripe-payments
 * Query params:
 *  - from, to: ISO dates
 *  - status: PENDING | SETTLED | ALL (default: PENDING)
 *  - skip, limit: pagination (defaults: 0, 50; max limit 200)
 */
export async function listStripePayments(req, res, next) {
  try {
    const { from, to, status = "PENDING", limit = 50, skip = 0 } = req.query;

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

    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(skip, 10) || 0, 0);

    const [items, total] = await Promise.all([
      GLTransaction.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(pageSize)
        .lean(),
      GLTransaction.countDocuments(query),
    ]);

    logInfo("Stripe payments query results", {
      total,
      itemsCount: items.length,
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
