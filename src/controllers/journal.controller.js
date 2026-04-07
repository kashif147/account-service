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
import { globalDBLimiter } from "../config/globalLimiter.js";
import { randomUUID } from "crypto";

// Amounts are stored as integer cents - sum them as integers
function sumArray(arr, sel) {
  return arr.reduce((s, x) => s + sel(x), 0);
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

// Wrapped in global limiter to prevent connection pool exhaustion
// when multiple heavy operations (batch approvals, batch payments) run simultaneously
export async function postBalancedJournal({
  date,
  docType,
  docNo,
  memo,
  lines,
  settlement,
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
          throw AppError.badRequest(
            `periodBucket required on ${e.accountCode}`,
            {
              accountCode: e.accountCode,
              periodBucket: e.periodBucket,
            }
          );
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

    // Validate fees are integers (cents)
    if (!Number.isInteger(oldAnnualFee) || oldAnnualFee < 0) {
      throw AppError.badRequest(
        "oldAnnualFee must be a non-negative integer (minor units)"
      );
    }
    if (!Number.isInteger(newAnnualFee) || newAnnualFee <= 0) {
      throw AppError.badRequest(
        "newAnnualFee must be a positive integer (minor units)"
      );
    }

    const { startISO, endISO, year } = yearBoundsFrom(changeDate);
    // pre-change ends the day before change
    const changeMinusISO = new Date(
      new Date(changeDate).getTime() - 24 * 3600 * 1000
    )
      .toISOString()
      .slice(0, 10);

    // Both fees are in cents - compare directly
    const isUpgrade = newAnnualFee > oldAnnualFee;

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

    // Validate amount is integer (cents)
    if (!Number.isInteger(amount) || amount <= 0) {
      throw AppError.badRequest(
        "amount must be a positive integer (minor units, e.g., 32600 for €326.00)"
      );
    }
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

/**
 * Process batch payments (deduction batch): shared by HTTP handler and RabbitMQ worker.
 * @param {string|Date} paymentDate
 * @param {Array} batchPayments
 * @returns {Promise<{ processed: number, failed: number, results: array, errors?: array }>}
 */
export async function runProcessDeductionBatchPayments(paymentDate, batchPayments) {
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

    const lines = [
      { accountCode: "1230", dc: "D", amount: amountNum },
      {
        accountCode: "2020",
        dc: "C",
        amount: amountNum,
        periodBucket: "current",
        memberId: String(membershipNumber),
      },
    ];

    const settlement = {
      provider: "test",
      status: "PENDING",
    };

    try {
      const txn = await postBalancedJournal({
        date,
        docType: "Receipt",
        docNo: `test-${randomUUID()}`,
        memo: "test",
        lines,
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

/**
 * Process batch: HTTP entry; body { paymentDate, batchPayments }.
 */
export async function processDeductionBatch(req, res, next) {
  try {
    const out = await runProcessDeductionBatchPayments(
      req.body.paymentDate,
      req.body.batchPayments
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
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

function extractIdentifiers(entries = []) {
  const linked =
    entries.find((e) => e?.accountCode === "2020" && (e?.memberId || e?.applicationId)) ||
    entries.find((e) => e?.memberId || e?.applicationId) ||
    null;
  return {
    memberId: linked?.memberId || null,
    applicationId: linked?.applicationId || null,
  };
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pickPreferredEmail(raw) {
  if (!raw) return null;
  const preferred = String(raw.preferredEmail || "")
    .trim()
    .toLowerCase();
  const fromPreferred =
    preferred === "work"
      ? raw.workEmail
      : preferred === "personal"
      ? raw.personalEmail
      : null;
  const email = fromPreferred || raw.personalEmail || raw.workEmail || raw.normalizedEmail;
  return email ? String(email).trim().toLowerCase() : null;
}

function resolveApiPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.data !== undefined) return payload.data;
  return payload;
}

function buildForwardHeaders(req, includeInternal = false) {
  const headers = { Accept: "application/json" };
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth) headers.Authorization = auth;

  const tenantId = req.tenantId || req.ctx?.tenantId || req.headers["x-tenant-id"];
  if (tenantId) headers["x-tenant-id"] = String(tenantId);

  if (includeInternal) {
    headers["x-internal-request"] = "true";
  }

  return headers;
}

async function fetchJson(url, req, options = {}) {
  const cache = options.cache instanceof Map ? options.cache : null;
  const cacheKey = `${options.method || "GET"}:${url}`;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const requestPromise = (async () => {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        ...buildForwardHeaders(req, options.includeInternal),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
  })();

  if (cache) {
    cache.set(cacheKey, requestPromise);
  }

  return requestPromise;
}

async function mapWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out = new Array(items.length);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, items.length));
  let idx = 0;

  async function run() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => run()));
  return out;
}

async function loadPendingApplicationMap(applicationIds, req) {
  const byApplicationId = new Map();
  if (!applicationIds.length) return byApplicationId;

  const base =
    process.env.APPLICATION_SERVICE_URL ||
    process.env.PROFILE_SERVICE_URL ||
    "";
  if (!base) {
    logWarn("APPLICATION_SERVICE_URL / PROFILE_SERVICE_URL not configured");
    return byApplicationId;
  }

  const fetchCache = new Map();
  const upstreamConcurrency = parseInt(
    process.env.STRIPE_ENRICHMENT_UPSTREAM_CONCURRENCY || "6",
    10
  );

  await mapWithConcurrency(applicationIds, upstreamConcurrency, async (applicationId) => {
    try {
      const url = `${base.replace(/\/$/, "")}/api/applications/${encodeURIComponent(
        applicationId
      )}`;
      const payload = await fetchJson(url, req, { cache: fetchCache });
      const app = resolveApiPayload(payload);
      if (app && app.applicationId) {
        byApplicationId.set(String(app.applicationId), app);
      }
    } catch (error) {
      logWarn("Failed to fetch application for stripe payment enrichment", {
        applicationId,
        error: error.message,
      });
    }
  });

  return byApplicationId;
}

async function loadApprovedMemberMap(memberIds, req) {
  const byMemberId = new Map();
  if (!memberIds.length) return byMemberId;

  const profileBase = (process.env.PROFILE_SERVICE_URL || "").replace(/\/$/, "");
  const subscriptionBase = (
    process.env.SUBSCRIPTION_SERVICE_URL || ""
  ).replace(/\/$/, "");

  if (!profileBase || !subscriptionBase) {
    logWarn(
      "PROFILE_SERVICE_URL or SUBSCRIPTION_SERVICE_URL not configured — approved enrichment limited"
    );
    return byMemberId;
  }

  const fetchCache = new Map();
  const upstreamConcurrency = parseInt(
    process.env.STRIPE_ENRICHMENT_UPSTREAM_CONCURRENCY || "6",
    10
  );

  await mapWithConcurrency(memberIds, upstreamConcurrency, async (memberId) => {
    try {
        const searchUrl = `${profileBase}/api/profile/search?q=${encodeURIComponent(
          memberId
        )}&limit=25`;
        const searchPayload = await fetchJson(searchUrl, req, { cache: fetchCache });
        const searchData = resolveApiPayload(searchPayload);
        const results = Array.isArray(searchData?.results) ? searchData.results : [];
        const profile =
          results.find(
            (r) =>
              String(r?.membershipNumber || "").trim().toLowerCase() ===
              String(memberId).trim().toLowerCase()
          ) || null;

        if (!profile?._id) return;

        const subscriptionsUrl =
          `${subscriptionBase}/api/v1/subscriptions` +
          `?profileId=${encodeURIComponent(String(profile._id))}` +
          `&isCurrent=true&page=1&limit=1`;

        let currentSubscription = null;
        try {
          const subPayload = await fetchJson(subscriptionsUrl, req, {
            includeInternal: true,
            cache: fetchCache,
          });
          const subData = resolveApiPayload(subPayload);
          const list = Array.isArray(subData?.data) ? subData.data : [];
          currentSubscription = list[0] || null;
        } catch (subError) {
          logWarn("Failed to fetch current subscription for profile", {
            memberId,
            profileId: profile._id,
            error: subError.message,
          });
        }

        byMemberId.set(String(memberId), { profile, currentSubscription });
    } catch (error) {
      logWarn("Failed to fetch profile for stripe payment enrichment", {
        memberId,
        error: error.message,
      });
    }
  });

  return byMemberId;
}

function enrichStripePaymentItem({ item, identifiers, pendingByApp, approvedByMember }) {
  const memberId = identifiers.memberId;
  const applicationId = identifiers.applicationId;

  let membershipNumber = null;
  let fullName = null;
  let normalizedEmail = null;
  let mobileNumber = null;
  let membershipCategory = null;
  let membershipStatus = null;
  let joinDate = null;
  let renewalDate = null;
  let billingCycle = null;

  if (memberId) {
    const approved = approvedByMember.get(String(memberId));
    const profile = approved?.profile || null;
    const sub = approved?.currentSubscription || null;

    membershipNumber = String(memberId);
    fullName =
      profile?.personalInfo?.fullName ||
      [profile?.personalInfo?.forename, profile?.personalInfo?.surname]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      null;
    normalizedEmail =
      profile?.normalizedEmail || pickPreferredEmail(profile?.contactInfo);
    mobileNumber = profile?.contactInfo?.mobileNumber || null;
    membershipCategory = sub?.membershipCategory || null;
    membershipStatus =
      sub?.subscriptionStatus || profile?.additionalInformation?.membershipStatus || null;
    joinDate = safeDate(sub?.startDate);
    renewalDate = safeDate(sub?.endDate);
    billingCycle = sub?.paymentFrequency || null;
  } else if (applicationId) {
    const appId = String(applicationId);
    const application = pendingByApp.get(appId);
    const personal = application?.personalDetails || null;
    const professional = application?.professionalDetails || null;
    const subscription = application?.subscriptionDetails || null;

    membershipNumber = null;
    fullName =
      personal?.personalInfo?.fullName ||
      [personal?.personalInfo?.forename, personal?.personalInfo?.surname]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      null;
    normalizedEmail = personal?.normalizedEmail || pickPreferredEmail(personal?.contactInfo);
    mobileNumber = personal?.contactInfo?.mobileNumber || null;
    membershipCategory =
      subscription?.membershipCategory ||
      professional?.membershipCategory ||
      null;
    membershipStatus =
      subscription?.membershipStatus || application?.applicationStatus || null;
    joinDate = safeDate(subscription?.dateJoined);
    renewalDate = safeDate(subscription?.dateLeft);
    billingCycle = subscription?.paymentFrequency || null;
  }

  return {
    ...item,
    memberId: memberId || null,
    applicationId: applicationId || null,
    membershipNumber,
    fullName,
    normalizedEmail,
    mobileNumber,
    membershipCategory,
    membershipStatus,
    memberhsipStatus: membershipStatus, // backwards compatibility for typoed consumers
    joinDate,
    JoinDate: joinDate,
    renewalDate,
    RenewalDate: renewalDate,
    billingCycle,
    email: normalizedEmail,
    phone: mobileNumber,
    category: membershipCategory,
    "Member No": membershipNumber || applicationId || "-",
    id: item?._id ? String(item._id) : item?.docNo,
    transactionId: item?.docNo,
  };
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

    const [rawItems, total] = await Promise.all([
      GLTransaction.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(pageSize)
        .lean(),
      GLTransaction.countDocuments(query),
    ]);

    const idPairs = rawItems.map((item) => ({
      item,
      identifiers: extractIdentifiers(item.entries),
    }));
    const memberIds = [
      ...new Set(idPairs.map((p) => p.identifiers.memberId).filter(Boolean)),
    ];
    const applicationIds = [
      ...new Set(idPairs.map((p) => p.identifiers.applicationId).filter(Boolean)),
    ];

    const [pendingByApp, approvedByMember] = await Promise.all([
      loadPendingApplicationMap(applicationIds, req),
      loadApprovedMemberMap(memberIds, req),
    ]);

    const items = idPairs.map(({ item, identifiers }) =>
      enrichStripePaymentItem({ item, identifiers, pendingByApp, approvedByMember })
    );

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
