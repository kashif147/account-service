import CreditNote from "../models/creditNote.model.js";
import GL from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";
import MaterializedBalance from "../models/materializedBalance.model.js";
import { publishFinanceAudit } from "./finance.audit.publisher.js";
import { buildFinanceAuditSnapshot } from "../helpers/financeAuditActions.js";

const INCOME_CODE_RE = /^40\d{2}$/;

/**
 * Resolve revenue account from original invoice GL.
 * @param {string} invoiceDocNo
 * @param {string} memberId
 */
export async function resolveInvoiceIncomeCode(invoiceDocNo, memberId) {
  const inv = await GL.findOne({
    docNo: invoiceDocNo,
    docType: "Invoice",
  }).lean();
  if (!inv) {
    throw AppError.notFound(`Invoice ${invoiceDocNo} not found`);
  }
  const mid = String(memberId || "").trim();
  const incomeLine = (inv.entries || []).find(
    (e) =>
      INCOME_CODE_RE.test(String(e.accountCode || "")) &&
      e.dc === "C" &&
      (!e.memberId || String(e.memberId).trim() === mid),
  );
  if (!incomeLine) {
    const adjLine = (inv.entries || []).find(
      (e) => e.accountCode === "4900" && e.dc === "D",
    );
    if (adjLine) return { incomeCode: "4900", isAdjustmentLine: true };
    throw AppError.badRequest(
      `No revenue line found on invoice ${invoiceDocNo}`,
    );
  }
  return {
    incomeCode: incomeLine.accountCode,
    categoryName: incomeLine.categoryName,
    isAdjustmentLine: false,
  };
}

/**
 * After CN credits AR, move member AR credit to 2020 (paid invoice excess).
 */
async function postPaidInvoiceCreditTransfer({
  date,
  memberId,
  periodBucket,
  amountCents,
  docNo,
  userId,
}) {
  if (amountCents <= 0) return null;
  return postBalancedJournal({
    date,
    userId,
    docType: "Claim",
    docNo,
    memo: `Credit note — member credit to Payment on Account`,
    lines: [
      {
        accountCode: "1400",
        dc: "D",
        amount: amountCents,
        memberId,
        periodBucket,
      },
      {
        accountCode: "2020",
        dc: "C",
        amount: amountCents,
        memberId,
        periodBucket: "advance",
      },
    ],
  });
}

/**
 * Maximum total credit-note amount (cents) still allowed against an invoice.
 * @param {string} invoiceDocNo
 * @param {string} memberId
 * @param {string} [excludeDocNo] — draft being created/approved (omit from committed sum)
 */
export async function getRemainingCreditableCents(
  invoiceDocNo,
  memberId,
  excludeDocNo,
) {
  const inv = await GL.findOne({
    docNo: invoiceDocNo,
    docType: "Invoice",
  }).lean();
  if (!inv) {
    throw AppError.notFound(`Invoice ${invoiceDocNo} not found`);
  }

  const mid = String(memberId || "").trim();
  let memberArDebit = 0;
  let revenueCredit = 0;

  for (const e of inv.entries || []) {
    const amt = Number(e.amount) || 0;
    if (
      e.accountCode === "1400" &&
      e.dc === "D" &&
      String(e.memberId || "").trim() === mid
    ) {
      memberArDebit += amt;
    }
    if (INCOME_CODE_RE.test(String(e.accountCode || "")) && e.dc === "C") {
      revenueCredit += amt;
    }
    if (e.accountCode === "4900" && e.dc === "D") {
      revenueCredit += amt;
    }
  }

  const invoiceCap = Math.max(memberArDebit, revenueCredit);
  if (invoiceCap <= 0) {
    throw AppError.badRequest(
      `Invoice ${invoiceDocNo} has no creditable amount for this member`,
    );
  }

  const q = {
    invoiceDocNo,
    memberId: mid,
    status: { $in: ["Draft", "Approved"] },
  };
  if (excludeDocNo) q.docNo = { $ne: excludeDocNo };

  const existing = await CreditNote.find(q).select("amount").lean();
  const committed = existing.reduce((s, cn) => s + (Number(cn.amount) || 0), 0);
  return Math.max(0, invoiceCap - committed);
}

async function assertCreditNoteWithinInvoiceLimit({
  invoiceDocNo,
  memberId,
  amount,
  excludeDocNo,
}) {
  const remaining = await getRemainingCreditableCents(
    invoiceDocNo,
    memberId,
    excludeDocNo,
  );
  if (amount > remaining) {
    const euros = (remaining / 100).toFixed(2);
    throw AppError.badRequest(
      remaining <= 0
        ? `Invoice ${invoiceDocNo} is already fully credited`
        : `Credit note amount exceeds remaining creditable balance (€${euros} left on this invoice)`,
    );
  }
}

/**
 * AR credit balance on 1400 after CN (cents): payments exceeded remaining AR.
 */
async function memberArCreditAfterCn(memberId, periodBucket, year) {
  const rows = await MaterializedBalance.find({
    memberId,
    accountCode: "1400",
    year,
    bucket: periodBucket,
  }).lean();
  const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  if (sum < 0) return -sum;
  return 0;
}

export async function createCreditNoteDraft({
  docNo,
  memberId,
  invoiceDocNo,
  amount,
  periodBucket = "current",
  reason,
  notes,
  effectiveDate,
  createdBy,
  tenantId,
  profileId,
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw AppError.badRequest("amount must be a positive integer (cents)");
  }
  const exists = await CreditNote.findOne({ docNo }).lean();
  if (exists) throw AppError.conflict(`Credit note ${docNo} already exists`);

  const { incomeCode, categoryName, isAdjustmentLine } =
    await resolveInvoiceIncomeCode(invoiceDocNo, memberId);

  await assertCreditNoteWithinInvoiceLimit({
    invoiceDocNo,
    memberId,
    amount,
  });

  const cn = await CreditNote.create({
    docNo,
    memberId,
    invoiceDocNo,
    amount,
    periodBucket,
    status: "Draft",
    incomeCode,
    categoryName,
    reason,
    notes,
    effectiveDate: new Date(effectiveDate),
    createdBy,
  });

  if (tenantId) {
    await publishFinanceAudit({
      action: "CREDIT_NOTE_DRAFT_CREATED",
      tenantId,
      profileId,
      memberId,
      actorId: createdBy,
      after: buildFinanceAuditSnapshot({
        docNo,
        memberId,
        profileId,
        invoiceDocNo,
        amountCents: amount,
        reason,
        status: "Draft",
      }),
    });
  }

  return { creditNote: cn.toObject(), isAdjustmentLine };
}

export async function approveCreditNote({
  docNo,
  approvedBy,
  userId,
  tenantId,
  profileId,
}) {
  const cn = await CreditNote.findOne({ docNo });
  if (!cn) throw AppError.notFound(`Credit note ${docNo} not found`);
  if (cn.status === "Approved") {
    return { creditNote: cn.toObject(), gl: await GL.findOne({ docNo: cn.glDocNo }).lean() };
  }
  if (cn.status === "Cancelled") {
    throw AppError.badRequest("Cannot approve a cancelled credit note");
  }
  if (cn.status !== "Draft") {
    throw AppError.badRequest(`Credit note status is ${cn.status}`);
  }

  await assertCreditNoteWithinInvoiceLimit({
    invoiceDocNo: cn.invoiceDocNo,
    memberId: cn.memberId,
    amount: cn.amount,
    excludeDocNo: cn.docNo,
  });

  const revenueCode = cn.incomeCode || "4900";
  const glDocNo = cn.glDocNo || `CN-${docNo}`;

  const revenueLine = {
    accountCode: revenueCode,
    dc: "D",
    amount: cn.amount,
    categoryName: cn.categoryName,
  };
  if (revenueCode === "4900") {
    revenueLine.adjSubType = "credit-note";
  }

  const gl = await postBalancedJournal({
    date: cn.effectiveDate,
    userId,
    tenantId,
    profileId: profileId || undefined,
    docType: "CreditNote",
    docNo: glDocNo,
    reference: cn.invoiceDocNo,
    memo: cn.reason || `Credit note – ${cn.categoryName || cn.invoiceDocNo}`,
    operation: "credit_note_approve",
    lines: [
      revenueLine,
      {
        accountCode: "1400",
        dc: "C",
        amount: cn.amount,
        memberId: cn.memberId,
        periodBucket: cn.periodBucket,
      },
    ],
  });

  const year = new Date(cn.effectiveDate).getFullYear();
  const arCredit = await memberArCreditAfterCn(
    cn.memberId,
    cn.periodBucket,
    year,
  );
  let transferGl = null;
  let transferGlDocNo = null;
  if (arCredit > 0) {
    const transferAmount = Math.min(arCredit, cn.amount);
    transferGlDocNo = `${glDocNo}-2020`;
    transferGl = await postPaidInvoiceCreditTransfer({
      date: cn.effectiveDate,
      memberId: cn.memberId,
      periodBucket: cn.periodBucket,
      amountCents: transferAmount,
      docNo: transferGlDocNo,
      userId,
    });
  }

  cn.status = "Approved";
  cn.approvedBy = approvedBy;
  cn.approvedAt = new Date();
  cn.glDocNo = glDocNo;
  cn.transferGlDocNo = transferGlDocNo;
  await cn.save();

  if (tenantId) {
    await publishFinanceAudit({
      action: "CREDIT_NOTE_APPROVED",
      tenantId,
      profileId,
      memberId: cn.memberId,
      actorId: approvedBy || userId,
      before: buildFinanceAuditSnapshot({
        docNo: cn.docNo,
        status: "Draft",
        amountCents: cn.amount,
      }),
      after: buildFinanceAuditSnapshot({
        docNo: cn.docNo,
        glDocNo,
        status: "Approved",
        amountCents: cn.amount,
        invoiceDocNo: cn.invoiceDocNo,
        memberId: cn.memberId,
        profileId,
      }),
    });
  }

  return {
    creditNote: cn.toObject(),
    gl,
    transferGl,
  };
}

export async function cancelCreditNote({
  docNo,
  cancelledBy,
  tenantId,
  profileId,
}) {
  const cn = await CreditNote.findOne({ docNo });
  if (!cn) throw AppError.notFound(`Credit note ${docNo} not found`);
  if (cn.status === "Approved") {
    throw AppError.badRequest(
      "Approved credit notes cannot be cancelled; post a reversing entry via finance controls",
    );
  }
  if (cn.status === "Cancelled") {
    return cn.toObject();
  }
  cn.status = "Cancelled";
  cn.cancelledBy = cancelledBy;
  cn.cancelledAt = new Date();
  await cn.save();

  if (tenantId) {
    await publishFinanceAudit({
      action: "CREDIT_NOTE_CANCELLED",
      tenantId,
      profileId,
      memberId: cn.memberId,
      actorId: cancelledBy,
      before: buildFinanceAuditSnapshot({
        docNo: cn.docNo,
        status: "Draft",
        amountCents: cn.amount,
      }),
      after: buildFinanceAuditSnapshot({
        docNo: cn.docNo,
        status: "Cancelled",
        amountCents: cn.amount,
        memberId: cn.memberId,
        profileId,
      }),
    });
  }

  return cn.toObject();
}

export async function getCreditNote(docNo) {
  const cn = await CreditNote.findOne({ docNo }).lean();
  if (!cn) throw AppError.notFound(`Credit note ${docNo} not found`);
  return cn;
}

export async function listCreditNotes({ memberId, status, limit = 50, skip = 0 }) {
  const q = {};
  if (memberId) q.memberId = memberId;
  if (status) q.status = status;
  const [items, total] = await Promise.all([
    CreditNote.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CreditNote.countDocuments(q),
  ]);
  return { items, total };
}
