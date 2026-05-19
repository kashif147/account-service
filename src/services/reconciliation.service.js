import ReconciliationRecord, {
  RECON_STATUSES,
} from "../models/reconciliationRecord.model.js";
import GL from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";

const CLEARING_CODES = ["1210", "1220", "1230", "1240", "1250"];

export async function listReconciliationRecords({
  clearingAccountCode,
  reconciliationStatus,
  limit = 100,
  skip = 0,
}) {
  const q = {};
  if (clearingAccountCode) q.clearingAccountCode = clearingAccountCode;
  if (reconciliationStatus) q.reconciliationStatus = reconciliationStatus;

  const [items, total] = await Promise.all([
    ReconciliationRecord.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ReconciliationRecord.countDocuments(q),
  ]);
  return { items, total, supportedClearingAccounts: CLEARING_CODES };
}

export async function seedReconciliationFromPendingGl({
  clearingAccountCode,
  createdBy,
}) {
  if (!CLEARING_CODES.includes(clearingAccountCode)) {
    throw AppError.badRequest(
      `clearingAccountCode must be one of ${CLEARING_CODES.join(", ")}`,
    );
  }

  const pending = await GL.find({
    "settlement.status": "PENDING",
    "entries.accountCode": clearingAccountCode,
  })
    .limit(500)
    .lean();

  const created = [];
  for (const txn of pending) {
    const clearingEntry = (txn.entries || []).find(
      (e) => e.accountCode === clearingAccountCode,
    );
    if (!clearingEntry) continue;

    const exists = await ReconciliationRecord.findOne({
      glDocNo: txn.docNo,
    }).lean();
    if (exists) continue;

    const rec = await ReconciliationRecord.create({
      clearingAccountCode,
      glDocNo: txn.docNo,
      amount: clearingEntry.amount,
      reconciliationStatus: "unmatched",
      settlementStatus: txn.settlement?.status || "PENDING",
      createdBy,
    });
    created.push(rec.toObject());
  }

  return { created: created.length, records: created };
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
  return rec.toObject();
}

/**
 * Clearing account dashboard: unreconciled counts and open amounts per rail.
 */
export async function getReconciliationDashboard() {
  const accounts = await Promise.all(
    CLEARING_CODES.map(async (clearingAccountCode) => {
      const [unmatched, manual_matched, suspense, settled, pendingGl] =
        await Promise.all([
          ReconciliationRecord.countDocuments({
            clearingAccountCode,
            reconciliationStatus: "unmatched",
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
        reconciliationStatus: { $in: ["unmatched", "manual_matched", "suspense"] },
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
        manual_matched,
        suspense,
        settled,
        unreconciledCount: unmatched + manual_matched + suspense,
        openAmount,
        pendingGlCount: pendingGl,
        lastReconciledAt,
      };
    }),
  );

  return { accounts, supportedClearingAccounts: CLEARING_CODES };
}

export { RECON_STATUSES, CLEARING_CODES };
