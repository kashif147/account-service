import GL from "../models/glTransaction.model.js";
import Balance from "../models/balance.model.js";
import CoA from "../models/coa.model.js";
import MatBal from "../models/materializedBalance.model.js";
import Refund from "../models/refund.model.js";
import User from "../models/user.model.js";
import { monthRange, yearRange } from "../helpers/period.js";
import {
  simplifyMemberLedgerPresentations,
} from "../helpers/memberLedgerPresentation.js";
import { attachPaymentIntentIdsToLedgerItems } from "../helpers/memberLedgerPaymentIntent.js";
import { attachTxTypesToLedgerItems } from "../helpers/glTransactionTxType.js";
import ReportSnapshot from "../models/reportSnapshot.model.js";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn, logError } from "../middlewares/logger.mw.js";
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";

/** Application credit moved to member (internal 2020 transfer); not a cash receipt. */
function isApplicationCreditClaimReceipt(txn) {
  if (!txn) return false;
  if (txn.docType === "Claim") return true;
  // Legacy rows were posted as Receipt with CLAIM docNo / memo
  if (txn.docType !== "Receipt") return false;
  const memo = String(txn.memo || "");
  const docNo = String(txn.docNo || "");
  return memo.startsWith("Claim app credit") || /^CLAIM-/i.test(docNo);
}

/** After `paymentIntentId` is resolved, use it as `reference` so the row is not labeled only as CLAIM-{uuid}. */
function attachClaimLedgerReference(items) {
  if (!Array.isArray(items)) return items;
  return items.map((txn) => {
    if (!isApplicationCreditClaimReceipt(txn)) return txn;
    const pi = txn.paymentIntentId;
    if (pi) return { ...txn, reference: String(pi).trim() };
    return txn;
  });
}

export async function memberStatement(req, res, next) {
  try {
    const { memberId } = req.params;
    const { from, to } = req.query;

    logInfo("Generating member statement", { memberId, from, to });

    const q = { "entries.memberId": memberId };
    if (from || to) q.date = {};
    if (from) q.date.$gte = new Date(from);
    if (to) q.date.$lte = new Date(to);
    const allTxns = await GL.find(q)
      .sort({ date: 1, createdAt: 1 })
      .lean();

    // Filter member-facing GL; category-change rows stay as stored (-CATNET or legacy INVNEW+CADJ)
    const txns = consolidateCategoryChanges(allTxns);
    const tenantId = req.tenantId || req.ctx?.tenantId;
    const withPi = tenantId
      ? await attachPaymentIntentIdsToLedgerItems(txns, tenantId)
      : txns.map((t) => ({ ...t, paymentIntentId: null }));
    const withClaimRef = attachClaimLedgerReference(withPi);
    const txnsWithTypes = await attachTxTypesToLedgerItems(withClaimRef);

    // Publish report generated event
    await publishDomainEvent(
      EVENT_TYPES.REPORT_GENERATED,
      {
        reportType: "member_statement",
        memberId,
        from,
        to,
        transactionCount: txnsWithTypes.length,
        generatedAt: new Date().toISOString(),
      },
      {
        source: "reports.controller",
        operation: "memberStatement",
      },
    );

    res.success({ memberId, txns: txnsWithTypes });
    logInfo("Member statement generated", {
      memberId,
      transactionCount: txnsWithTypes.length,
    });
  } catch (e) {
    logError("Failed to generate member statement", {
      memberId: req.params.memberId,
      error: e.message,
    });
    next(e);
  }
}

function getMapValue(mapLike, key) {
  if (!mapLike) return null;
  if (typeof mapLike.get === "function") return mapLike.get(key) ?? null;
  if (typeof mapLike === "object") return mapLike[key] ?? null;
  return null;
}

function memberNetAr1400Cents(txn, memberId) {
  const normalizedMemberId = String(memberId || "").trim().toLowerCase();
  let debit = 0;
  let credit = 0;
  for (const entry of txn?.entries || []) {
    if (String(entry.memberId || "").trim().toLowerCase() !== normalizedMemberId) {
      continue;
    }
    if (entry.accountCode !== "1400") continue;
    const amount = Number(entry.amount) || 0;
    if (entry.dc === "D") debit += amount;
    else if (entry.dc === "C") credit += amount;
  }
  return debit - credit;
}

function normalizeDateRange(from, to) {
  const date = {};
  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) date.$gte = fromDate;
  }
  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) date.$lte = toDate;
  }
  return Object.keys(date).length ? date : null;
}

async function getMemberTrackedAccountCodes() {
  const rows = await CoA.find({ isMemberTracked: true }).select("code").lean();
  return rows.map((r) => r.code).filter(Boolean);
}

export async function refundsList(req, res, next) {
  try {
    const tenantId = req.tenantId || req.ctx?.tenantId;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "20", 10) || 20, 1), 100);
    const skip = Math.max(parseInt(req.query.skip ?? "0", 10) || 0, 0);
    const mode = req.query.mode;
    const memberId = req.query.memberId;
    const from = req.query.from;
    const to = req.query.to;

    const match = { tenantId };
    if (mode) match.mode = mode;
    if (memberId) match.memberId = memberId;
    const dateRange = normalizeDateRange(from, to);
    if (dateRange) match.refundDate = dateRange;

    const [rows, total] = await Promise.all([
      Refund.aggregate([
        { $match: match },
        { $sort: { refundDate: -1, createdAt: -1, _id: -1 } },
        {
          $lookup: {
            from: "payments",
            localField: "paymentId",
            foreignField: "_id",
            as: "payment",
          },
        },
        {
          $lookup: {
            from: "gltransactions",
            localField: "glDocNo",
            foreignField: "docNo",
            as: "gl",
          },
        },
        {
          $project: {
            _id: 1,
            tenantId: 1,
            paymentId: 1,
            amount: 1,
            mode: 1,
            payoutMethod: 1,
            refNo: 1,
            refundDate: 1,
            memo: 1,
            note: 1,
            metadata: 1,
            memberId: 1,
            applicationId: 1,
            createdAt: 1,
            glDocNo: 1,
            stripe: 1,
            payment: { $arrayElemAt: ["$payment", 0] },
            gl: { $arrayElemAt: ["$gl", 0] },
          },
        },
        { $skip: skip },
        { $limit: limit },
      ]),
      Refund.countDocuments(match),
    ]);

    const createdByUserIds = Array.from(
      new Set(
        rows
          .map((row) => {
            const metadataCreatedBy = getMapValue(row.metadata, "createdBy");
            return metadataCreatedBy || row.payment?.audit?.createdBy || null;
          })
          .filter(Boolean)
      )
    );

    let userMap = new Map();
    if (tenantId && createdByUserIds.length) {
      const users = await User.find({
        tenantId,
        userId: { $in: createdByUserIds },
      })
        .select("userId userFullName")
        .lean();
      userMap = new Map(users.map((u) => [u.userId, u.userFullName || u.userId]));
    }

    const refunds = rows.map((row) => {
      const payment = row.payment || {};
      const gl = row.gl || {};
      const glApplicationId =
        gl.entries?.find((entry) => entry.applicationId)?.applicationId || null;
      const memberNo =
        row.memberId ||
        payment.memberId ||
        gl.entries?.find((entry) => entry.memberId)?.memberId ||
        null;
      const applicationNo =
        row.applicationId ||
        payment.applicationId ||
        glApplicationId ||
        null;
      const rawCreatedBy =
        getMapValue(row.metadata, "createdBy") ||
        payment.audit?.createdBy ||
        null;
      return {
        refundId: row.stripe?.refundId || String(row._id),
        refNo: row.refNo || row.glDocNo || gl.docNo || null,
        refundDate: row.refundDate || null,
        amount: row.amount ?? 0,
        refundType: row.payoutMethod || null,
        refundSource: row.mode || null,
        memberNo,
        applicationNo,
        memo: row.memo || row.note || gl.memo || null,
        createdBy: rawCreatedBy ? userMap.get(rawCreatedBy) || rawCreatedBy : null,
        createdAt: row.createdAt || null,
      };
    });

    res.success({
      total,
      limit,
      skip,
      hasMore: skip + refunds.length < total,
      refunds,
    });
  } catch (e) {
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
    const { year, scope } = req.query;
    const memberTrackedCodes = await getMemberTrackedAccountCodes();
    const query = { memberId };
    if (memberTrackedCodes.length) {
      query.accountCode = { $in: memberTrackedCodes };
    }
    const normalizedScope = String(scope || "all").toLowerCase();
    if (!["all", "current"].includes(normalizedScope)) {
      throw AppError.badRequest("scope must be all or current");
    }

    let effectiveYear = null;
    if (year != null && year !== "") {
      const parsedYear = parseInt(year, 10);
      if (Number.isNaN(parsedYear)) throw AppError.badRequest("year must be YYYY");
      effectiveYear = parsedYear;
      query.year = parsedYear;
    } else if (normalizedScope === "current") {
      effectiveYear = new Date().getFullYear();
      query.year = effectiveYear;
    }

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
      year: effectiveYear,
      scope: effectiveYear == null ? "all" : "year",
      accountCodesUsed: memberTrackedCodes,
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
 * Member summary: net balance + most recent payment (Receipt, including app-credit claim receipts)
 * + most recent Invoice (AR on 1400 for the member, same basis as simple ledger).
 * Uses parallel indexed queries for performance.
 */
export async function memberSummary(req, res, next) {
  try {
    const { memberId } = req.params;
    const { year, scope } = req.query;
    const memberTrackedCodes = await getMemberTrackedAccountCodes();
    const query = { memberId };
    if (memberTrackedCodes.length) {
      query.accountCode = { $in: memberTrackedCodes };
    }
    const normalizedScope = String(scope || "all").toLowerCase();
    if (!["all", "current"].includes(normalizedScope)) {
      throw AppError.badRequest("scope must be all or current");
    }

    let effectiveYear = null;
    if (year != null && year !== "") {
      const parsedYear = parseInt(year, 10);
      if (Number.isNaN(parsedYear)) throw AppError.badRequest("year must be YYYY");
      effectiveYear = parsedYear;
      query.year = parsedYear;
    } else if (normalizedScope === "current") {
      effectiveYear = new Date().getFullYear();
      query.year = effectiveYear;
    }

    const [matBalRows, lastPaymentTxn, latestInvoiceTxn] = await Promise.all([
      MatBal.find(query).lean(),
      GL.findOne({
        "entries.memberId": memberId,
        docType: { $in: ["Receipt", "Claim"] },
      })
        .sort({ date: -1, createdAt: -1 })
        .lean(),
      GL.findOne({
        "entries.memberId": memberId,
        docType: "Invoice",
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
        displayLabel: isApplicationCreditClaimReceipt(lastPaymentTxn)
          ? "Claim"
          : lastPaymentTxn.memo || "Payment",
      };
    }

    let latestInvoice = null;
    if (latestInvoiceTxn) {
      const amount = memberNetAr1400Cents(latestInvoiceTxn, memberId);
      latestInvoice = {
        docNo: latestInvoiceTxn.docNo,
        docType: latestInvoiceTxn.docType,
        date: latestInvoiceTxn.date,
        amount,
        reference: buildMemberLedgerReference(latestInvoiceTxn),
      };
    }

    res.success({
      memberId,
      year: effectiveYear,
      scope: effectiveYear == null ? "all" : "year",
      accountCodesUsed: memberTrackedCodes,
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
      latestInvoice,
    });
  } catch (e) {
    next(e);
  }
}

/**
 * Bulk member summary for high-volume list screens.
 * POST /api/reports/members/summary-batch
 * Body: { memberIds: string[], year?: number, scope?: "all"|"current" }
 */
export async function memberSummaryBatch(req, res, next) {
  try {
    const tenantId = req.tenantId || req.ctx?.tenantId;
    if (!tenantId) {
      throw AppError.badRequest("Tenant context required");
    }
    const { memberIds, year, scope } = req.body || {};
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw AppError.badRequest("memberIds must be a non-empty array");
    }
    const normalizedMemberIds = [
      ...new Set(
        memberIds
          .map((id) => String(id || "").trim())
          .filter(Boolean)
      ),
    ];
    if (normalizedMemberIds.length === 0) {
      throw AppError.badRequest("memberIds must contain valid values");
    }
    if (normalizedMemberIds.length > 5000) {
      throw AppError.badRequest("memberIds exceeds maximum of 5000");
    }

    const memberTrackedCodes = await getMemberTrackedAccountCodes();
    const normalizedScope = String(scope || "all").toLowerCase();
    if (!["all", "current"].includes(normalizedScope)) {
      throw AppError.badRequest("scope must be all or current");
    }

    let effectiveYear = null;
    const matBalQuery = {
      tenantId,
      memberId: { $in: normalizedMemberIds },
    };
    if (memberTrackedCodes.length) {
      matBalQuery.accountCode = { $in: memberTrackedCodes };
    }
    if (year != null && year !== "") {
      const parsedYear = parseInt(year, 10);
      if (Number.isNaN(parsedYear)) throw AppError.badRequest("year must be YYYY");
      effectiveYear = parsedYear;
      matBalQuery.year = parsedYear;
    } else if (normalizedScope === "current") {
      effectiveYear = new Date().getFullYear();
      matBalQuery.year = effectiveYear;
    }

    const [matBalRows, paymentRows, invoiceRows] = await Promise.all([
      MatBal.find(matBalQuery).lean(),
      GL.aggregate([
        {
          $match: {
            tenantId,
            docType: { $in: ["Receipt", "Claim"] },
            "entries.memberId": { $in: normalizedMemberIds },
          },
        },
        { $sort: { date: -1, createdAt: -1 } },
        { $unwind: "$entries" },
        {
          $match: {
            "entries.memberId": { $in: normalizedMemberIds },
            "entries.accountCode": "2020",
          },
        },
        {
          $group: {
            _id: "$entries.memberId",
            docNo: { $first: "$docNo" },
            docType: { $first: "$docType" },
            date: { $first: "$date" },
            amount: { $first: "$entries.amount" },
            memo: { $first: "$memo" },
          },
        },
      ]),
      GL.aggregate([
        {
          $match: {
            tenantId,
            docType: "Invoice",
            "entries.memberId": { $in: normalizedMemberIds },
          },
        },
        { $sort: { date: -1, createdAt: -1 } },
        { $unwind: "$entries" },
        {
          $match: {
            "entries.memberId": { $in: normalizedMemberIds },
            "entries.accountCode": "1400",
          },
        },
        {
          $group: {
            _id: { memberId: "$entries.memberId", txnId: "$_id" },
            docNo: { $first: "$docNo" },
            docType: { $first: "$docType" },
            date: { $first: "$date" },
            reference: { $first: "$reference" },
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
        { $sort: { date: -1 } },
        {
          $group: {
            _id: "$_id.memberId",
            docNo: { $first: "$docNo" },
            docType: { $first: "$docType" },
            date: { $first: "$date" },
            reference: { $first: "$reference" },
            amount: { $first: { $subtract: ["$debit", "$credit"] } },
          },
        },
      ]),
    ]);

    const matByMember = new Map();
    for (const row of matBalRows) {
      const memberId = String(row.memberId || "").trim();
      if (!memberId) continue;
      if (!matByMember.has(memberId)) {
        matByMember.set(memberId, { net: 0, byAccount: {}, byBucket: {} });
      }
      const agg = matByMember.get(memberId);
      agg.net += row.amount;
      agg.byAccount[row.accountCode] = (agg.byAccount[row.accountCode] || 0) + row.amount;
      const bKey = `${row.accountCode}:${row.bucket}`;
      agg.byBucket[bKey] = (agg.byBucket[bKey] || 0) + row.amount;
    }

    const paymentByMember = new Map(
      paymentRows.map((r) => [String(r._id || "").trim(), r])
    );
    const invoiceByMember = new Map(
      invoiceRows.map((r) => [String(r._id || "").trim(), r])
    );

    const items = normalizedMemberIds.map((memberId) => {
      const mat = matByMember.get(memberId) || {
        net: 0,
        byAccount: {},
        byBucket: {},
      };
      const payment = paymentByMember.get(memberId) || null;
      const invoice = invoiceByMember.get(memberId) || null;

      const lastPayment = payment
        ? {
            docNo: payment.docNo,
            docType: payment.docType,
            date: payment.date,
            amount: Number(payment.amount) || 0,
            displayLabel: isApplicationCreditClaimReceipt(payment)
              ? "Claim"
              : payment.memo || "Payment",
          }
        : null;

      const latestInvoice = invoice
        ? {
            docNo: invoice.docNo,
            docType: invoice.docType,
            date: invoice.date,
            amount: Number(invoice.amount) || 0,
            reference: invoice.reference || invoice.docNo || "-",
          }
        : null;

      return {
        memberId,
        year: effectiveYear,
        scope: effectiveYear == null ? "all" : "year",
        accountCodesUsed: memberTrackedCodes,
        net: mat.net || 0,
        accounts: Object.entries(mat.byAccount).map(([accountCode, amount]) => ({
          accountCode,
          amount,
        })),
        buckets: Object.entries(mat.byBucket).map(([key, amount]) => {
          const [accountCode, bucket] = key.split(":");
          return { accountCode, bucket, amount };
        }),
        lastPayment,
        latestInvoice,
      };
    });

    res.success({ count: items.length, items });
  } catch (e) {
    next(e);
  }
}

const CATEGORY_CHANGE_DOCNO_RE =
  /^(.+?)-(INVNEW|CADJ|COLD|CNEW|CATNET)$/;

/** Human-readable reference for ledger (membership category, not docNo IDs). */
function buildMemberLedgerReference(txn) {
  const storedRef = txn.reference != null ? String(txn.reference).trim() : "";
  if (storedRef) return storedRef;

  const docNo = txn.docNo != null ? String(txn.docNo) : "";

  if (docNo.endsWith("-INVNEW")) {
    const cat =
      txn.entries?.find((e) => e.categoryName)?.categoryName ||
      txn.memo?.match(/Subscription\s+\d{4}\s*–\s*(.+)$/)?.[1]?.trim();
    if (cat) return cat;
  }

  if (docNo.endsWith("-CATNET")) {
    const oldLine = txn.entries?.find(
      (e) => e.adjSubType === "category-change-old-tier-release",
    );
    const newLine = txn.entries?.find(
      (e) =>
        e.dc === "C" &&
        e.categoryName &&
        (e.revenueSubType === "fee" ||
          e.revenueSubType === "Fee Increase" ||
          e.revenueSubType === "Fee Decrease"),
    );
    const oldCat = oldLine?.categoryName;
    const newCat = newLine?.categoryName;
    if (oldCat && newCat) return `${oldCat} → ${newCat}`;
    if (newCat) return newCat;
    if (oldCat) return oldCat;
  }

  if (/(?:-CADJ|-COLD|-CNEW)$/.test(docNo)) {
    const ordered = [];
    for (const e of txn.entries || []) {
      if (e.categoryName && !ordered.includes(e.categoryName)) {
        ordered.push(e.categoryName);
      }
    }
    if (ordered.length === 1) return ordered[0];
    if (ordered.length > 1) return ordered.join(" → ");
  }

  if (txn.docType === "Invoice") {
    const feeLine = txn.entries?.find(
      (e) =>
        (e.revenueSubType === "fee" ||
          e.revenueSubType === "Fee Increase" ||
          e.revenueSubType === "Fee Decrease") &&
        e.categoryName
    );
    if (feeLine?.categoryName) return feeLine.categoryName;
  }

  if (docNo.endsWith("-PRORATA")) {
    const cat = txn.entries?.find((e) => e.categoryName)?.categoryName;
    if (cat) return `Pro-rata — ${cat}`;
    return "Pro-rata fee adjustment";
  }

  return docNo || "-";
}

/** Match persisted GL shape for ledger/statement (settlement always present). */
function normalizeLedgerGlTxn(txn) {
  const isProrataFee =
    txn.docType === "Adjustment" &&
    txn.entries?.some((e) => e.adjSubType === "prorata-fee-adjustment");

  const base = isApplicationCreditClaimReceipt(txn)
    ? {
        ...txn,
        displayLabel: "Claim",
        displayType: "application_credit_claim",
      }
    : isProrataFee
      ? {
          ...txn,
          displayLabel: "Pro-rata fee adjustment",
          displayType: "prorata_fee_adjustment",
        }
      : { ...txn };
  if (base.settlement == null) {
    base.settlement = { status: "PENDING" };
  }
  base.reference = buildMemberLedgerReference(base);
  return base;
}

/**
 * Member-facing GL list: pass through category-change journals as stored (Adjustment -CATNET,
 * legacy Invoice -INVNEW + Adjustment -CADJ / -COLD -CNEW) so each item matches other GL documents.
 * Drops internal-only category-change adjustments and settlements. Pro-rata fee
 * adjustments are member-visible (they explain AR after the full-year invoice).
 */
function consolidateCategoryChanges(transactions) {
  const consolidated = [];

  for (const txn of transactions) {
    if (txn.docNo && CATEGORY_CHANGE_DOCNO_RE.test(txn.docNo)) {
      consolidated.push(normalizeLedgerGlTxn(txn));
      continue;
    }

    if (txn.docType === "Adjustment") {
      const adjSubType = txn.entries.find((e) => e.adjSubType)?.adjSubType;

      const isCategoryChangeAdjustment =
        adjSubType === "category-upgrade-unused-credit" ||
        adjSubType === "category-downgrade-unused-credit" ||
        adjSubType === "category-change-prorata-credit";

      if (isCategoryChangeAdjustment) {
        continue;
      }
    }

    if (txn.docType === "Settlement") {
      continue;
    }

    consolidated.push(normalizeLedgerGlTxn(txn));
  }

  return consolidated;
}

export async function memberLedger(req, res, next) {
  try {
    const { memberId } = req.params;
    const { accountCode } = req.query;

    const q = { "entries.memberId": memberId };
    if (accountCode) q["entries.accountCode"] = accountCode;

    const allItems = await GL.find(q)
      .sort({ date: 1, createdAt: 1 })
      .lean();

    const consolidatedItems = consolidateCategoryChanges(allItems);

    const tenantId = req.tenantId || req.ctx?.tenantId;
    const withPaymentIntent = await attachPaymentIntentIdsToLedgerItems(
      consolidatedItems,
      tenantId
    );
    const withClaimRef = attachClaimLedgerReference(withPaymentIntent);
    const withTxType = await attachTxTypesToLedgerItems(withClaimRef);

    const view =
      String(req.query.view || "simple").toLowerCase() === "full"
        ? "full"
        : "simple";
    const items =
      view === "full"
        ? withTxType
        : simplifyMemberLedgerPresentations(withTxType, memberId);

    res.success({ memberId, view, items });
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
