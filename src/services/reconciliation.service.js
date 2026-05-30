import ReconciliationRecord, {
  RECON_STATUSES,
} from "../models/reconciliationRecord.model.js";
import GL from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";
import {
  enrichReconciliationRecords,
  findGlMatchForBankLine,
} from "../helpers/reconciliationEnrichment.js";

const CLEARING_CODES = ["1210", "1220", "1230", "1240", "1250"];

function normalizeClearingFilter(clearingAccountCode) {
  const code = String(clearingAccountCode || "").trim();
  if (!code || code.toLowerCase() === "all") return null;
  if (!CLEARING_CODES.includes(code)) {
    throw AppError.badRequest(
      `clearingAccountCode must be one of ${CLEARING_CODES.join(", ")} or all`,
    );
  }
  return code;
}

export async function listReconciliationRecords({
  clearingAccountCode,
  reconciliationStatus,
  limit = 100,
  skip = 0,
}) {
  const q = {};
  const clearing = normalizeClearingFilter(clearingAccountCode);
  if (clearing) q.clearingAccountCode = clearing;
  if (reconciliationStatus) q.reconciliationStatus = reconciliationStatus;

  const [rawItems, total] = await Promise.all([
    ReconciliationRecord.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ReconciliationRecord.countDocuments(q),
  ]);

  const items = await enrichReconciliationRecords(rawItems);
  return { items, total, supportedClearingAccounts: CLEARING_CODES };
}

export async function seedReconciliationFromPendingGl({
  clearingAccountCode,
  createdBy,
}) {
  const clearing = normalizeClearingFilter(clearingAccountCode);
  if (!clearing) {
    throw AppError.badRequest("clearingAccountCode is required for seed");
  }

  const pending = await GL.find({
    "settlement.status": "PENDING",
    "entries.accountCode": clearing,
  })
    .limit(500)
    .lean();

  const created = [];
  for (const txn of pending) {
    const clearingEntry = (txn.entries || []).find(
      (e) => e.accountCode === clearing,
    );
    if (!clearingEntry) continue;

    const exists = await ReconciliationRecord.findOne({
      glDocNo: txn.docNo,
    }).lean();
    if (exists) continue;

    const rec = await ReconciliationRecord.create({
      clearingAccountCode: clearing,
      glDocNo: txn.docNo,
      amount: clearingEntry.amount,
      reconciliationStatus: "unmatched",
      settlementStatus: txn.settlement?.status || "PENDING",
      sourceType: "gl",
      createdBy,
    });
    created.push(rec.toObject());
  }

  return { created: created.length, records: created };
}

/**
 * Import bank / payout lines as unmatched reconciliation rows.
 */
export async function importBankReconciliationLines({
  clearingAccountCode,
  batchReference,
  lines,
  createdBy,
}) {
  const clearing = normalizeClearingFilter(clearingAccountCode);
  if (!clearing) {
    throw AppError.badRequest("clearingAccountCode is required");
  }
  if (!Array.isArray(lines) || !lines.length) {
    throw AppError.badRequest("lines must be a non-empty array");
  }

  const batchId =
    String(batchReference || "").trim() ||
    `BANK-${clearing}-${Date.now().toString(36).toUpperCase()}`;

  const created = [];
  const skipped = [];

  for (const line of lines) {
    const externalReference = String(
      line.externalReference || line.bankRef || "",
    ).trim();
    const amount = Math.round(Number(line.amount));
    if (!externalReference || !Number.isInteger(amount) || amount <= 0) {
      skipped.push({ line, reason: "invalid reference or amount" });
      continue;
    }

    const dup = await ReconciliationRecord.findOne({
      clearingAccountCode: clearing,
      externalReference,
      amount,
      reconciliationStatus: { $ne: "settled" },
    }).lean();
    if (dup) {
      skipped.push({ externalReference, reason: "duplicate open line" });
      continue;
    }

    const rec = await ReconciliationRecord.create({
      clearingAccountCode: clearing,
      externalReference,
      amount,
      memberId: line.memberId || undefined,
      reconciliationStatus: "unmatched",
      settlementStatus: "PENDING",
      sourceType: "bank",
      importBatchId: batchId,
      notes: line.notes || undefined,
      createdBy,
    });
    created.push(rec.toObject());
  }

  return {
    importBatchId: batchId,
    created: created.length,
    skipped: skipped.length,
    records: created,
    skippedDetails: skipped.slice(0, 20),
  };
}

/**
 * Propose or apply auto-matches for unmatched bank / GL rows.
 */
export async function runAutoMatchReconciliation({
  clearingAccountCode,
  matchedBy,
  apply = true,
}) {
  const q = { reconciliationStatus: "unmatched" };
  const clearing = normalizeClearingFilter(clearingAccountCode);
  if (clearing) q.clearingAccountCode = clearing;

  const unmatched = await ReconciliationRecord.find(q).limit(500).lean();
  const results = [];

  for (const rec of unmatched) {
    let match = null;

    if (rec.sourceType === "bank" || rec.externalReference) {
      match = await findGlMatchForBankLine({
        externalReference: rec.externalReference,
        amount: rec.amount,
        clearingAccountCode: rec.clearingAccountCode,
      });
    } else if (rec.glDocNo) {
      const gl = await GL.findOne({ docNo: rec.glDocNo }).lean();
      const payoutId = gl?.settlement?.payoutId;
      if (payoutId) {
        const bankRec = await ReconciliationRecord.findOne({
          clearingAccountCode: rec.clearingAccountCode,
          externalReference: payoutId,
          reconciliationStatus: "unmatched",
          sourceType: "bank",
        }).lean();
        if (bankRec && Number(bankRec.amount) === Number(rec.amount)) {
          match = {
            glDocNo: rec.glDocNo,
            confidence: "high",
            amountDifference: 0,
            memberId: null,
            via: "payoutId",
          };
        }
      }
    }

    if (!match || (match.confidence !== "high" && match.confidence !== "medium")) {
      continue;
    }

    const payload = {
      recordId: String(rec._id),
      glDocNo: match.glDocNo,
      confidence: match.confidence,
      amountDifference: match.amountDifference ?? 0,
      memberId: match.memberId || rec.memberId || null,
    };

    if (apply) {
      await ReconciliationRecord.findByIdAndUpdate(rec._id, {
        reconciliationStatus: "auto_matched",
        matchedGlDocNo: match.glDocNo,
        matchedBy,
        memberId: payload.memberId || rec.memberId,
      });
    }

    results.push(payload);
  }

  return {
    applied: apply,
    matched: results.length,
    matches: results,
  };
}

export async function manualMatchReconciliation({
  recordId,
  matchedGlDocNo,
  matchedBy,
}) {
  const rec = await ReconciliationRecord.findById(recordId);
  if (!rec) throw AppError.notFound("Reconciliation record not found");

  rec.reconciliationStatus = "manual_matched";
  rec.matchedGlDocNo = matchedGlDocNo;
  rec.matchedBy = matchedBy;
  await rec.save();
  return rec.toObject();
}

export async function moveToSuspense({ recordId, suspenseReason, matchedBy }) {
  const rec = await ReconciliationRecord.findById(recordId);
  if (!rec) throw AppError.notFound("Reconciliation record not found");

  rec.reconciliationStatus = "suspense";
  rec.suspenseReason = suspenseReason;
  rec.matchedBy = matchedBy;
  await rec.save();
  return rec.toObject();
}

export async function markReconciliationSettled({ recordId }) {
  const rec = await ReconciliationRecord.findById(recordId);
  if (!rec) throw AppError.notFound("Reconciliation record not found");

  rec.reconciliationStatus = "settled";
  rec.settlementStatus = "SETTLED";
  rec.settledAt = new Date();
  await rec.save();

  if (rec.glDocNo) {
    await GL.updateOne(
      { docNo: rec.glDocNo },
      {
        $set: {
          "settlement.status": "SETTLED",
          "settlement.settledAt": new Date(),
        },
      },
    );
  }

  return rec.toObject();
}

/**
 * Clearing account dashboard: unreconciled counts and open amounts per rail.
 */
export async function getReconciliationDashboard() {
  const accounts = await Promise.all(
    CLEARING_CODES.map(async (clearingAccountCode) => {
      const [
        unmatched,
        auto_matched,
        manual_matched,
        suspense,
        settled,
        pendingGl,
      ] = await Promise.all([
        ReconciliationRecord.countDocuments({
          clearingAccountCode,
          reconciliationStatus: "unmatched",
        }),
        ReconciliationRecord.countDocuments({
          clearingAccountCode,
          reconciliationStatus: "auto_matched",
        }),
        ReconciliationRecord.countDocuments({
          clearingAccountCode,
          reconciliationStatus: "manual_matched",
        }),
        ReconciliationRecord.countDocuments({
          clearingAccountCode,
          reconciliationStatus: "suspense",
        }),
        ReconciliationRecord.countDocuments({
          clearingAccountCode,
          reconciliationStatus: "settled",
        }),
        GL.countDocuments({
          "settlement.status": "PENDING",
          "entries.accountCode": clearingAccountCode,
        }),
      ]);

      const openRecords = await ReconciliationRecord.find({
        clearingAccountCode,
        reconciliationStatus: {
          $in: ["unmatched", "auto_matched", "manual_matched", "suspense"],
        },
      })
        .select({ amount: 1 })
        .lean();

      const openAmount = openRecords.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );

      const lastSettled = await ReconciliationRecord.findOne({
        clearingAccountCode,
        reconciliationStatus: "settled",
      })
        .sort({ settledAt: -1, updatedAt: -1 })
        .select({ settledAt: 1, updatedAt: 1 })
        .lean();

      const lastReconciledAt =
        lastSettled?.settledAt || lastSettled?.updatedAt || null;

      return {
        clearingAccountCode,
        unmatched,
        auto_matched,
        manual_matched,
        suspense,
        settled,
        unreconciledCount:
          unmatched + auto_matched + manual_matched + suspense,
        openAmount,
        pendingGlCount: pendingGl,
        lastReconciledAt,
      };
    }),
  );

  const totals = accounts.reduce(
    (acc, row) => ({
      unreconciledCount: acc.unreconciledCount + row.unreconciledCount,
      openAmount: acc.openAmount + row.openAmount,
      pendingGlCount: acc.pendingGlCount + row.pendingGlCount,
      unmatched: acc.unmatched + row.unmatched,
      auto_matched: acc.auto_matched + row.auto_matched,
      manual_matched: acc.manual_matched + row.manual_matched,
      suspense: acc.suspense + row.suspense,
      settled: acc.settled + row.settled,
    }),
    {
      unreconciledCount: 0,
      openAmount: 0,
      pendingGlCount: 0,
      unmatched: 0,
      auto_matched: 0,
      manual_matched: 0,
      suspense: 0,
      settled: 0,
    },
  );

  return {
    accounts,
    totals,
    supportedClearingAccounts: CLEARING_CODES,
  };
}

export { RECON_STATUSES, CLEARING_CODES };
