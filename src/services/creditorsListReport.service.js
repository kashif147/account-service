import GL from "../models/glTransaction.model.js";
import { computeMemberBalanceFromGl } from "../helpers/memberCreditorBalance.helper.js";

function isMemberKey(memberId) {
  const mid = String(memberId || "").trim();
  if (!mid) return false;
  return !mid.toLowerCase().startsWith("app:");
}

/**
 * End-of-day UTC for an ISO date or Date (inclusive GL cutoff).
 * @param {string|Date} asOf
 */
export function resolveAsOfEndDate(asOf) {
  if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) {
    return new Date(
      Date.UTC(
        asOf.getUTCFullYear(),
        asOf.getUTCMonth(),
        asOf.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
  }
  const raw = String(asOf || "").trim();
  if (!raw) {
    throw new Error("asOf date is required");
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    const d = Number(match[3]);
    return new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid asOf date");
  }
  return new Date(
    Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

/**
 * Last calendar day of month (month 1–12) end-of-day UTC.
 */
export function resolveMonthYearAsOfEnd(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || y < 2000 || y > 2100) {
    throw new Error("year must be YYYY");
  }
  if (!Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error("month must be 1–12");
  }
  return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
}

/**
 * GL balances on member AR (1400) and POA (2020) as at endDate.
 * Signed amount = debits − credits per account; combined net = ar1400 + poa2020.
 * Creditor when net < 0 (organisation liability / member credit per Irish POA treatment).
 */
async function memberBalancesAsOfGl(endDate) {
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

  const byMember = new Map();
  for (const r of rows) {
    const memberId = String(r.memberId || "").trim();
    if (!isMemberKey(memberId)) continue;
    if (!byMember.has(memberId)) {
      byMember.set(memberId, { ar1400: 0, poa2020: 0 });
    }
    const bucket = byMember.get(memberId);
    if (r.accountCode === "1400") bucket.ar1400 = Number(r.amount) || 0;
    if (r.accountCode === "2020") bucket.poa2020 = Number(r.amount) || 0;
  }

  return [...byMember.entries()].map(([memberId, v]) => {
    const { net, amountCents } = computeMemberBalanceFromGl({
      ar1400: v.ar1400,
      poa2020: v.poa2020,
    });
    return {
      memberId,
      ar1400: v.ar1400,
      poa2020: v.poa2020,
      net,
      amountCents,
    };
  });
}

/**
 * Members with outstanding credit (organisation owes) as at reporting date.
 * Only GL entries with date <= asOf end-of-day are included.
 */
export async function listCreditorsAsOf({
  asOf,
  year,
  month,
  dateFrom,
  dateTo,
  offset = 0,
  limit = 5000,
} = {}) {
  let asOfEnd;
  let periodMode = "asOf";
  let periodYear = null;
  let periodMonth = null;
  let periodDateFrom = null;
  let periodDateTo = null;

  if (year != null && month != null && month !== "") {
    asOfEnd = resolveMonthYearAsOfEnd(year, month);
    periodMode = "monthYear";
    periodYear = Number(year);
    periodMonth = Number(month);
  } else if (dateTo) {
    asOfEnd = resolveAsOfEndDate(dateTo);
    periodMode = "dateRange";
    periodDateTo = asOfEnd.toISOString().slice(0, 10);
    if (dateFrom) {
      const fromMatch = String(dateFrom).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      periodDateFrom = fromMatch ? fromMatch[0] : String(dateFrom).trim();
    }
  } else if (asOf) {
    asOfEnd = resolveAsOfEndDate(asOf);
    periodDateTo = asOfEnd.toISOString().slice(0, 10);
  } else {
    throw new Error("Provide asOf, or year and month, or dateTo");
  }

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 5000), 5000);

  const balances = await memberBalancesAsOfGl(asOfEnd);
  const allRows = balances
    .filter((b) => b.amountCents > 0)
    .map((b) => ({
      memberId: b.memberId,
      amountCents: b.amountCents,
    }))
    .sort((a, b) => {
      const cmp = a.memberId.localeCompare(b.memberId, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (cmp !== 0) return cmp;
      return b.amountCents - a.amountCents;
    });

  const total = allRows.length;
  const rows = allRows.slice(safeOffset, safeOffset + safeLimit);

  return {
    asOf: asOfEnd.toISOString(),
    asOfDate: asOfEnd.toISOString().slice(0, 10),
    periodMode,
    year: periodYear,
    month: periodMonth,
    dateFrom: periodDateFrom,
    dateTo: periodDateTo || asOfEnd.toISOString().slice(0, 10),
    rows,
    total,
    offset: safeOffset,
    limit: safeLimit,
  };
}

/** @deprecated Use listCreditorsAsOf — kept for sync script compatibility */
export async function listCreditorsReport(params = {}) {
  const { tenantId, year, offset, limit } = params;
  const asOf =
    year != null
      ? resolveMonthYearAsOfEnd(year, 12)
      : resolveAsOfEndDate(new Date());
  return listCreditorsAsOf({
    asOf: asOf.toISOString().slice(0, 10),
    offset,
    limit,
  });
}

export async function getMemberCreditorRow() {
  return null;
}
