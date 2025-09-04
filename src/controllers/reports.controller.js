import GL from "../models/glTransaction.model.js";
import Balance from "../models/balance.model.js";
import CoA from "../models/coa.model.js";
import MatBal from "../models/materializedBalance.model.js";
import { monthRange, yearRange } from "../helpers/period.js";
import ReportSnapshot from "../models/reportSnapshot.model.js";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn } from "../middlewares/logger.mw.js";
import { publishDomainEvent, EVENT_TYPES } from "../infra/rabbit/events.js";

export async function memberStatement(req, res, next) {
  try {
    const { memberId } = req.params;
    const { from, to } = req.query;

    logInfo("Generating member statement", { memberId, from, to });

    const q = { "entries.memberId": memberId };
    if (from || to) q.date = {};
    if (from) q.date.$gte = new Date(from);
    if (to) q.date.$lte = new Date(to);
    const txns = await GL.find(q).sort({ date: 1, createdAt: 1 }).lean();

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
      }
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
    a.accountCode.localeCompare(b.accountCode)
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

  return {
    income,
    contraIncome,
    expenses,
    totals: {
      income: Number(sum(income).toFixed(2)),
      contraIncome: Number(sum(contraIncome).toFixed(2)),
      expenses: Number(sum(expenses).toFixed(2)),
      profit: Number(
        (sum(income) - sum(contraIncome) - sum(expenses)).toFixed(2)
      ),
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
  const byMember = {};
  for (const r of rows) {
    if (!byMember[r.memberId]) byMember[r.memberId] = { ar1400: 0, poa2020: 0 };
    if (r.accountCode === "1400")
      byMember[r.memberId].ar1400 = Number(r.amount.toFixed(2));
    if (r.accountCode === "2020")
      byMember[r.memberId].poa2020 = Number(r.amount.toFixed(2));
  }
  return Object.entries(byMember).map(([memberId, v]) => ({
    memberId,
    ar1400: v.ar1400,
    poa2020: v.poa2020,
    net: Number((v.ar1400 - v.poa2020).toFixed(2)), // positive = owes us; negative = we owe them
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
          notes
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
          notes
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
  notes
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
