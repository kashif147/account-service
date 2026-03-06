import GL from "../models/glTransaction.model.js";
import Balance from "../models/balance.model.js";
import CoA from "../models/coa.model.js";
import MatBal from "../models/materializedBalance.model.js";
import { monthRange, yearRange } from "../helpers/period.js";
import ReportSnapshot from "../models/reportSnapshot.model.js";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn, logError } from "../middlewares/logger.mw.js";
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";

export async function memberStatement(req, res, next) {
  try {
    const { memberId } = req.params;
    const { from, to } = req.query;

    logInfo("Generating member statement", { memberId, from, to });

    const q = { "entries.memberId": memberId };
    if (from || to) q.date = {};
    if (from) q.date.$gte = new Date(from);
    if (to) q.date.$lte = new Date(to);
    const allTxns = await GL.find(q).sort({ date: 1, createdAt: 1 }).lean();

    // Consolidate category changes and filter for member-facing view
    const txns = consolidateCategoryChanges(allTxns);

    // Publish report generated event
    await publishDomainEvent(
      EVENT_TYPES.REPORT_GENERATED,
      {
        reportType: "member_statement",
        memberId,
        from,
        to,
        transactionCount: txns.length,
        generatedAt: new Date().toISOString(),
      },
      {
        source: "reports.controller",
        operation: "memberStatement",
      },
    );

    res.success({ memberId, txns });
    logInfo("Member statement generated", {
      memberId,
      transactionCount: txns.length,
    });
  } catch (e) {
    logError("Failed to generate member statement", {
      memberId: req.params.memberId,
      error: e.message,
    });
    next(e);
  }
}

export async function balancesSnapshot(req, res, next) {
  try {
    const agg = await Balance.aggregate([
      {
        $group: {
          _id: { code: "$accountCode", bucket: "$periodBucket" },
          total: { $sum: "$balance" },
        },
      },
      {
        $project: {
          _id: 0,
          accountCode: "$_id.code",
          bucket: "$_id.bucket",
          total: 1,
        },
      },
    ]);
    res.success({ agg });
  } catch (e) {
    next(e);
  }
}

// Join CoA names into grouped results
function mapNames(byCode, rows) {
  return rows.map((r) => ({
    accountCode: r._id,
    accountName: byCode[r._id]?.name || "(unknown)",
    type: byCode[r._id]?.type || "",
    debit: r.debit || 0,
    credit: r.credit || 0,
    net: (r.debit || 0) - (r.credit || 0),
  }));
}

// Generic Trial Balance over a date range
async function trialBalance(startISO, endISO) {
  const [rows, coa] = await Promise.all([
    GL.aggregate([
      {
        $match: { date: { $gte: new Date(startISO), $lte: new Date(endISO) } },
      },
      { $unwind: "$entries" },
      {
        $group: {
          _id: "$entries.accountCode",
          debit: {
            $sum: {
              $cond: [{ $eq: ["$entries.dc", "D"] }, "$entries.amount", 0],
            },
          },
          credit: {
            $sum: {
              $cond: [{ $eq: ["$entries.dc", "C"] }, "$entries.amount", 0],
            },
          },
        },
      },
    ]),
    CoA.find({}).lean(),
  ]);
  const byCode = Object.fromEntries(coa.map((a) => [a.code, a]));
  return mapNames(byCode, rows).sort((a, b) =>
    a.accountCode.localeCompare(b.accountCode),
  );
}

// Income Statement over a date range
async function incomeStatement(startISO, endISO) {
  const tb = await trialBalance(startISO, endISO);
  const income = tb.filter((x) => x.type === "Income");
  const contraIncome = tb.filter((x) => x.type === "ContraIncome");
  const expenses = tb.filter((x) => x.type === "Expense");

  const sum = (arr) =>
    arr.reduce((s, x) => s + (x.type === "Income" ? -x.net : x.net), 0);
  // For Income accounts: credit positive → net is negative; flip sign when summing P&L

  // Return amounts in cents (no conversion - frontend will handle display formatting)
  return {
    income,
    contraIncome,
    expenses,
    totals: {
      income: sum(income),
      contraIncome: sum(contraIncome),
      expenses: sum(expenses),
      profit: sum(income) - sum(contraIncome) - sum(expenses),
    },
  };
}

// Debtors / Creditors as of a date (recalc from GL by date)
async function membersBalancesAsOf(endISO) {
  const endDate = new Date(endISO);
  const rows = await GL.aggregate([
    { $match: { date: { $lte: endDate } } },
    { $unwind: "$entries" },
    {
      $match: {
        "entries.accountCode": { $in: ["1400", "2020"] },
        "entries.memberId": { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: {
          memberId: "$entries.memberId",
          accountCode: "$entries.accountCode",
        },
        debit: {
          $sum: {
            $cond: [{ $eq: ["$entries.dc", "D"] }, "$entries.amount", 0],
          },
        },
        credit: {
          $sum: {
            $cond: [{ $eq: ["$entries.dc", "C"] }, "$entries.amount", 0],
          },
        },
      },
    },
    {
      $project: {
        memberId: "$_id.memberId",
        accountCode: "$_id.accountCode",
        amount: { $subtract: ["$debit", "$credit"] },
      },
    },
  ]);

  // Combine 1400 and 2020 into a single member net if you like, or return separately:
  // Return amounts in cents (no conversion - frontend will handle display formatting)
  const byMember = {};
  for (const r of rows) {
    if (!byMember[r.memberId]) byMember[r.memberId] = { ar1400: 0, poa2020: 0 };
    if (r.accountCode === "1400") byMember[r.memberId].ar1400 = r.amount;
    if (r.accountCode === "2020") byMember[r.memberId].poa2020 = r.amount;
  }
  return Object.entries(byMember).map(([memberId, v]) => ({
    memberId,
    ar1400: v.ar1400, // Return in cents
    poa2020: v.poa2020, // Return in cents
    net: v.ar1400 - v.poa2020, // Return in cents
  }));
}

// Clearing accounts reconciliation for a month (1210–1250)
async function clearingReconciliation(startISO, endISO) {
  const codes = ["1210", "1220", "1230", "1240", "1250"];
  const rows = await GL.aggregate([
    { $match: { date: { $gte: new Date(startISO), $lte: new Date(endISO) } } },
    { $unwind: "$entries" },
    { $match: { "entries.accountCode": { $in: codes } } },
    {
      $group: {
        _id: "$entries.accountCode",
        debit: {
          $sum: {
            $cond: [{ $eq: ["$entries.dc", "D"] }, "$entries.amount", 0],
          },
        },
        credit: {
          $sum: {
            $cond: [{ $eq: ["$entries.dc", "C"] }, "$entries.amount", 0],
          },
        },
      },
    },
    {
      $project: {
        accountCode: "$_id",
        debit: 1,
        credit: 1,
        net: { $subtract: ["$debit", "$credit"] },
      },
    },
  ]);
  return rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

// PUBLIC CONTROLLERS

export async function balancesAsOf(req, res, next) {
  try {
    const asOf = req.query.asOf;
    // Fast path from materialized balances if you prefer:
    // const y = new Date(asOf).getFullYear();
    // const docs = await MatBal.find({ year: y }).lean();

    // On-demand recompute from GL (authoritative at a date)
    const mem = await membersBalancesAsOf(asOf);
    res.success({ asOf, members: mem });
  } catch (e) {
    next(e);
  }
}

export async function memberNetBalance(req, res, next) {
  try {
    const { memberId } = req.params;
    const { year } = req.query;
    const query = { memberId };
    const y = year ? parseInt(year, 10) : new Date().getFullYear();
    if (Number.isNaN(y)) throw AppError.badRequest("year must be YYYY");
    query.year = y;

    const rows = await MatBal.find(query).lean();
    let net = 0;
    const byAccount = {};
    const byBucket = {};

    for (const r of rows) {
      net += r.amount;
      byAccount[r.accountCode] = (byAccount[r.accountCode] || 0) + r.amount;
      const key = `${r.accountCode}:${r.bucket}`;
      byBucket[key] = (byBucket[key] || 0) + r.amount;
    }

    // Return amounts in cents (no conversion - frontend will handle display formatting)
    res.success({
      memberId,
      year: y,
      net: net, // Return in cents
      accounts: Object.entries(byAccount).map(([accountCode, amount]) => ({
        accountCode,
        amount: amount, // Return in cents
      })),
      buckets: Object.entries(byBucket).map(([key, amount]) => {
        const [accountCode, bucket] = key.split(":");
        return { accountCode, bucket, amount: amount }; // Return in cents
      }),
    });
  } catch (e) {
    next(e);
  }
}

/**
 * Member summary: net balance + most recent payment (Receipt or Claim).
 * Uses two parallel indexed queries for performance.
 */
export async function memberSummary(req, res, next) {
  try {
    const { memberId } = req.params;
    const { year } = req.query;
    const query = { memberId };
    const y = year ? parseInt(year, 10) : new Date().getFullYear();
    if (Number.isNaN(y)) throw AppError.badRequest("year must be YYYY");
    query.year = y;

    const [matBalRows, lastPaymentTxn] = await Promise.all([
      MatBal.find(query).lean(),
      GL.findOne({
        "entries.memberId": memberId,
        docType: { $in: ["Receipt", "Claim"] },
      })
        .sort({ date: -1, createdAt: -1 })
        .lean(),
    ]);

    let net = 0;
    const byAccount = {};
    const byBucket = {};
    for (const r of matBalRows) {
      net += r.amount;
      byAccount[r.accountCode] = (byAccount[r.accountCode] || 0) + r.amount;
      const key = `${r.accountCode}:${r.bucket}`;
      byBucket[key] = (byBucket[key] || 0) + r.amount;
    }

    let lastPayment = null;
    if (lastPaymentTxn) {
      const memberEntry = lastPaymentTxn.entries.find(
        (e) => e.memberId === memberId && e.accountCode === "2020",
      );
      const amount = memberEntry ? memberEntry.amount : 0;
      lastPayment = {
        docNo: lastPaymentTxn.docNo,
        docType: lastPaymentTxn.docType,
        date: lastPaymentTxn.date,
        amount,
        displayLabel:
          lastPaymentTxn.docType === "Claim"
            ? "Payment received"
            : lastPaymentTxn.memo || "Payment",
      };
    }

    res.success({
      memberId,
      year: y,
      net,
      accounts: Object.entries(byAccount).map(([accountCode, amount]) => ({
        accountCode,
        amount,
      })),
      buckets: Object.entries(byBucket).map(([key, amount]) => {
        const [accountCode, bucket] = key.split(":");
        return { accountCode, bucket, amount };
      }),
      lastPayment,
    });
  } catch (e) {
    next(e);
  }
}

/**
 * Consolidates category change entries into a single net entry
 * Groups entries with docNo pattern: {base}-INVNEW, {base}-COLD, {base}-CNEW
 */
function consolidateCategoryChanges(transactions) {
  const consolidated = [];
  const categoryChangeGroups = new Map(); // docNoBase -> entries
  const processedDocNos = new Set();

  // First pass: identify category change groups
  for (const txn of transactions) {
    // Check if this is part of a category change (has -INVNEW, -COLD, or -CNEW suffix)
    const match = txn.docNo.match(/^(.+?)-(INVNEW|COLD|CNEW)$/);
    if (match) {
      const [, docNoBase] = match;
      if (!categoryChangeGroups.has(docNoBase)) {
        categoryChangeGroups.set(docNoBase, {
          invoice: null,
          oldCategoryAdjustment: null,
          newCategoryAdjustment: null,
          docNoBase,
        });
      }
      const group = categoryChangeGroups.get(docNoBase);

      if (txn.docNo.endsWith("-INVNEW")) {
        group.invoice = txn;
      } else if (txn.docNo.endsWith("-COLD")) {
        group.oldCategoryAdjustment = txn;
      } else if (txn.docNo.endsWith("-CNEW")) {
        group.newCategoryAdjustment = txn;
      }
    }
  }

  // Second pass: process transactions
  for (const txn of transactions) {
    const match = txn.docNo.match(/^(.+?)-(INVNEW|COLD|CNEW)$/);

    if (match) {
      const [, docNoBase] = match;
      const group = categoryChangeGroups.get(docNoBase);

      // Only process when we encounter the invoice (INVNEW)
      // This ensures we create the consolidated entry once
      if (txn.docNo.endsWith("-INVNEW") && !processedDocNos.has(docNoBase)) {
        processedDocNos.add(docNoBase);

        // Calculate net effect on account 1400 (Accounts Receivable)
        let netAmount = 0;
        const invoiceEntry = txn.entries.find(
          (e) => e.accountCode === "1400" && e.dc === "D",
        );
        if (invoiceEntry) {
          netAmount += invoiceEntry.amount;
        }

        // Subtract adjustments (they credit 1400, so reduce the net)
        if (group.oldCategoryAdjustment) {
          const adjEntry = group.oldCategoryAdjustment.entries.find(
            (e) => e.accountCode === "1400" && e.dc === "C",
          );
          if (adjEntry) {
            netAmount -= adjEntry.amount;
          }
        }

        if (group.newCategoryAdjustment) {
          const adjEntry = group.newCategoryAdjustment.entries.find(
            (e) => e.accountCode === "1400" && e.dc === "C",
          );
          if (adjEntry) {
            netAmount -= adjEntry.amount;
          }
        }

        // Extract category names from entries or memos
        // Invoice memo format: "Subscription {year} – {categoryName}"
        const newCategoryName =
          invoiceEntry?.categoryName ||
          txn.memo?.match(/Subscription\s+\d{4}\s*–\s*(.+)$/)?.[1] ||
          txn.memo?.match(/–\s*(.+)$/)?.[1] ||
          "Unknown";

        // Old category adjustment memo format: "Adjustment – Unused period credit ({categoryName}) {date} → {date}"
        const oldCategoryName =
          group.oldCategoryAdjustment?.entries?.find((e) => e.categoryName)
            ?.categoryName ||
          group.oldCategoryAdjustment?.memo?.match(/\(([^)]+)\)/)?.[1] ||
          "Unknown";

        // Determine if upgrade or downgrade based on adjSubType
        const isUpgrade =
          group.oldCategoryAdjustment?.entries?.find(
            (e) => e.adjSubType === "category-upgrade-unused-credit",
          ) !== undefined;

        // Create consolidated entry
        const consolidatedEntry = {
          _id: txn._id, // Use invoice ID for reference
          date: txn.date,
          docType: "CategoryChange",
          docNo: docNoBase, // Use base docNo without suffixes
          memo: `Category Change: ${oldCategoryName} → ${newCategoryName} (${
            isUpgrade ? "Upgrade" : "Downgrade"
          })`,
          // netAmount is already in cents (from calculations), keep as integer
          netAmount: netAmount,
          effect:
            netAmount > 0
              ? "increase"
              : netAmount < 0
                ? "decrease"
                : "no-change",
          originalEntries: {
            invoice: txn.docNo,
            oldCategoryAdjustment: group.oldCategoryAdjustment?.docNo,
            newCategoryAdjustment: group.newCategoryAdjustment?.docNo,
          },
          // Include original entries for reference if needed
          _original: {
            invoice: txn,
            oldCategoryAdjustment: group.oldCategoryAdjustment,
            newCategoryAdjustment: group.newCategoryAdjustment,
          },
        };

        consolidated.push(consolidatedEntry);
      }
      // Skip individual adjustment entries - they're now part of consolidated entry
      continue;
    }

    // For non-category-change entries, check if they should be shown
    // Filter out internal adjustments that are part of category changes
    if (txn.docType === "Adjustment") {
      const adjSubType = txn.entries.find((e) => e.adjSubType)?.adjSubType;

      // Check if this adjustment is part of a category change group (by docNo pattern)
      const isPartOfCategoryChange = txn.docNo.match(/^(.+?)-(COLD|CNEW)$/);

      // Skip category change adjustments (they're consolidated)
      if (isPartOfCategoryChange) {
        continue;
      }

      // Also skip by adjSubType as a safety check
      const isCategoryChangeAdjustment =
        adjSubType === "category-upgrade-unused-credit" ||
        adjSubType === "category-downgrade-unused-credit" ||
        adjSubType === "category-change-prorata-credit";

      if (isCategoryChangeAdjustment) {
        continue;
      }

      // Skip pro-rata adjustments (they're auto-calculated, shown in invoice net)
      if (adjSubType === "prorata-fee-adjustment") {
        continue;
      }
    }

    // Skip internal entries (Settlement only – Claim is member-facing as payment received)
    if (txn.docType === "Settlement") {
      continue;
    }

    // Claims: include and label as payment received for member statement/ledger
    const entry =
      txn.docType === "Claim"
        ? {
            ...txn,
            displayLabel: "Payment received",
            displayType: "payment_received",
          }
        : txn;
    consolidated.push(entry);
  }

  return consolidated;
}

export async function memberLedger(req, res, next) {
  try {
    const { memberId } = req.params;
    const { accountCode } = req.query;

    const q = { "entries.memberId": memberId };
    if (accountCode) q["entries.accountCode"] = accountCode;

    const allItems = await GL.find(q).sort({ date: -1, createdAt: -1 }).lean();

    // Consolidate category changes and filter for member-facing view
    const consolidatedItems = consolidateCategoryChanges(allItems);

    res.success({ memberId, items: consolidatedItems });
  } catch (e) {
    next(e);
  }
}

export async function monthEnd(req, res, next) {
  try {
    const { period, lock, notes } = req.query; // YYYY-MM
    const { startISO, endISO, label } = monthRange(period);

    const compute = async () => {
      const [tb, is, clearing, debtors] = await Promise.all([
        trialBalance(startISO, endISO),
        incomeStatement(startISO, endISO),
        clearingReconciliation(startISO, endISO),
        membersBalancesAsOf(endISO),
      ]);

      return {
        period: label,
        range: { startISO, endISO },
        trialBalance: tb,
        incomeStatement: is,
        clearingReconciliation: clearing,
        members: {
          debtors: debtors.filter((x) => x.net > 0),
          creditors: debtors.filter((x) => x.net < 0),
        },
      };
    };

    const report = lock
      ? await snapshotOrCompute(
          "month-end",
          label,
          { startISO, endISO },
          compute,
          req.user?.id,
          notes,
        )
      : await compute();

    res.success(report);
  } catch (e) {
    next(e);
  }
}

export async function yearEnd(req, res, next) {
  try {
    const { year, lock, notes } = req.query;
    const { startISO, endISO, label } = yearRange(year);

    const compute = async () => {
      const [tb, is, asOfBalances] = await Promise.all([
        trialBalance(startISO, endISO),
        incomeStatement(startISO, endISO),
        membersBalancesAsOf(endISO),
      ]);

      return {
        year: label,
        range: { startISO, endISO },
        trialBalance: tb,
        incomeStatement: is,
        members: {
          debtors: asOfBalances.filter((x) => x.net > 0),
          creditors: asOfBalances.filter((x) => x.net < 0),
        },
      };
    };

    const report = lock
      ? await snapshotOrCompute(
          "year-end",
          label,
          { startISO, endISO },
          compute,
          req.user?.id,
          notes,
        )
      : await compute();

    res.success(report);
  } catch (e) {
    next(e);
  }
}

// utility to either reuse existing snapshot or create new one
async function snapshotOrCompute(
  type,
  label,
  range,
  computeFn,
  lockedBy,
  notes,
) {
  // Check if already exists
  let snap = await ReportSnapshot.findOne({ type, label }).lean();
  if (snap) return snap;

  // Compute fresh
  const data = await computeFn();

  // Persist
  snap = await ReportSnapshot.create({
    type,
    label,
    range,
    data,
    lockedBy,
    notes,
  });

  return snap.toObject();
}
