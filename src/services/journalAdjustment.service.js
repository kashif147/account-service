import JournalAdjustment from "../models/journalAdjustment.model.js";
import { AppError } from "../errors/AppError.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";

export async function createJournalAdjustmentDraft({
  docNo,
  debitAccount,
  creditAccount,
  amount,
  memberId,
  reason,
  notes,
  financialPeriod,
  effectiveDate,
  createdBy,
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw AppError.badRequest("amount must be a positive integer (cents)");
  }
  if (debitAccount === creditAccount) {
    throw AppError.badRequest("debitAccount and creditAccount must differ");
  }

  const exists = await JournalAdjustment.findOne({ docNo }).lean();
  if (exists) throw AppError.conflict(`Journal adjustment ${docNo} exists`);

  const adj = await JournalAdjustment.create({
    docNo,
    debitAccount,
    creditAccount,
    amount,
    memberId: memberId || undefined,
    reason,
    notes,
    financialPeriod,
    effectiveDate: new Date(effectiveDate),
    approvalStatus: "Draft",
    createdBy,
  });

  return adj.toObject();
}

export async function approveJournalAdjustment({ docNo, approvedBy, userId }) {
  const adj = await JournalAdjustment.findOne({ docNo });
  if (!adj) throw AppError.notFound(`Journal adjustment ${docNo} not found`);
  if (adj.approvalStatus === "Approved") {
    return { adjustment: adj.toObject() };
  }
  if (adj.approvalStatus !== "Draft") {
    throw AppError.badRequest(`Status is ${adj.approvalStatus}`);
  }

  const glDocNo = adj.glDocNo || `JADJ-${docNo}`;
  const lines = [
    { accountCode: adj.debitAccount, dc: "D", amount: adj.amount },
    { accountCode: adj.creditAccount, dc: "C", amount: adj.amount },
  ];
  if (adj.memberId) {
    const tracked = ["1400", "2020"];
    if (tracked.includes(adj.debitAccount)) {
      lines[0].memberId = adj.memberId;
      lines[0].periodBucket = "current";
    }
    if (tracked.includes(adj.creditAccount)) {
      lines[1].memberId = adj.memberId;
      lines[1].periodBucket = "current";
    }
  }

  const gl = await postBalancedJournal({
    date: adj.effectiveDate,
    userId,
    docType: "Adjustment",
    docNo: glDocNo,
    memo: `Journal adjustment – ${adj.reason}`,
    lines,
  });

  adj.approvalStatus = "Approved";
  adj.approvedBy = approvedBy;
  adj.glDocNo = glDocNo;
  await adj.save();

  return { adjustment: adj.toObject(), gl };
}

export async function listJournalAdjustments({ limit = 50, skip = 0 }) {
  const [items, total] = await Promise.all([
    JournalAdjustment.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    JournalAdjustment.countDocuments(),
  ]);
  return { items, total };
}
