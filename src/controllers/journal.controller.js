// src/controllers/journal.controller.js
import CoA from "../models/coa.model.js";
import GLTransaction from "../models/glTransaction.model.js";
import dayjs from "dayjs";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn, logError } from "../middlewares/logger.mw.js";
// import { calculateProRataFee } from "../helpers/prorata.js";
import {
  prorataFromJoinToYearEnd,
  yearBoundsFrom,
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

export async function postBalancedJournal({
  date,
  docType,
  docNo,
  memo,
  lines,
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
  // - require memberId/periodBucket on member-tracked accounts (1400, 2020)
  for (const e of enriched) {
    if (
      (e.accountCode === "1400" || e.accountCode === "2020") &&
      (!e.memberId || !e.periodBucket)
    ) {
      throw AppError.badRequest(
        `memberId and periodBucket required on ${e.accountCode}`,
        {
          accountCode: e.accountCode,
          memberId: e.memberId,
          periodBucket: e.periodBucket,
        }
      );
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
  });

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

// Invoice → 1400 (AR) debit, income credit
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
          docType: "CreditNote",
          docNo: `${docNo}-PRORATA`,
          memo: `Credit note – Pro-rata (${categoryName}) ${joinDate} → ${endISO}`,
          lines: [
            {
              accountCode: "4900",
              dc: "D",
              amount: reduction,
              adjSubType: "prorata",
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
    const creditOldUnused = prorataForPeriod(oldAnnualFee, changeDate, endISO);
    if (creditOldUnused > 0) {
      results.push(
        await postBalancedJournal({
          date,
          docType: "CreditNote",
          docNo: `${docNoBase}-COLD`,
          memo: `Credit note – Unused period (${oldCategoryName}) ${changeDate} → ${endISO}`,
          lines: [
            {
              accountCode: "4900",
              dc: "D",
              amount: creditOldUnused,
              adjSubType: isUpgrade ? "fee-increase-credit" : "downgrade",
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
          docType: "CreditNote",
          docNo: `${docNoBase}-CNEW`,
          memo: `Credit note – Pre-change portion (${newCategoryName}) ${startISO} → ${changeMinusISO}`,
          lines: [
            {
              accountCode: "4900",
              dc: "D",
              amount: creditNewPre,
              adjSubType: "prorata",
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
      adjSubType = "discount",
      categoryName,
    } = req.body;
    const out = await postBalancedJournal({
      date,
      docType: "CreditNote",
      docNo,
      memo: `Credit note – ${categoryName || adjSubType}`,
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

// // Receipt (unlinked money-in) → 12xx clearing debit, 2020 credit

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
    const effectiveMemberId =
      memberId || (applicationId ? `app:${applicationId}` : null);
    if (!effectiveMemberId)
      throw AppError.badRequest("memberId or applicationId is required", {
        memberId,
        applicationId,
      });

    const lines = [
      { accountCode: clearingCode, dc: "D", amount }, // 1210..1250
      {
        accountCode: "2020",
        dc: "C",
        amount,
        memberId: effectiveMemberId,
        periodBucket: bucket,
      }, // Payment on Account
    ];

    // Stripe fee and VAT (Ireland), applied against the clearing account
    if (provider === "stripe") {
      const { feeNoVat, feeVat, feeTotal } = stripeFeeBreakdown(amount);
      lines.push({ accountCode: "5100", dc: "D", amount: feeNoVat }); // Processing fee
      lines.push({ accountCode: "1160", dc: "D", amount: feeVat }); // VAT recoverable
      lines.push({ accountCode: clearingCode, dc: "C", amount: feeTotal });
    }

    const out = await postBalancedJournal({
      date,
      docType: "Receipt",
      docNo,
      memo: applicationId ? `Receipt (app ${applicationId})` : "Receipt",
      lines,
    });
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
}

// “claim credit” endpoint (transfer 2020 from app → member)
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

    const appMember = applicationId;

    // Find the credit entry for this application
    const creditEntry = await GLTransaction.aggregate([
      { $unwind: "$entries" },
      {
        $match: {
          "entries.memberId": appMember,
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

    const lines = [
      {
        accountCode: "2020",
        dc: "D",
        amount,
        memberId: appMember,
        periodBucket: bucket,
      },
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
 *  - docType: e.g. Invoice, CreditNote, Receipt, Settlement
 *  - memberId: exact match on entries.memberId
 *  - skip, limit: pagination (defaults: 0, 50; max limit 200)
 */
export async function listJournals(req, res, next) {
  try {
    const { from, to, docType, memberId, limit = 50, skip = 0 } = req.query;

    const query = {};
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) query.date.$lte = new Date(to);
    }
    if (docType) query.docType = docType;
    if (memberId) query["entries.memberId"] = memberId;

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
