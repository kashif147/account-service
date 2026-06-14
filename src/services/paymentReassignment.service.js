import GL from "../models/glTransaction.model.js";
import Payment from "../models/payment.model.js";
import { AppError } from "../errors/AppError.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";
import { inferPaymentMethodFromLines } from "../helpers/financeAuditActions.js";
import { buildMemberReceiptCreditEntries } from "../helpers/paymentReceiptAllocation.js";
import { memberPaymentCreditCents } from "../helpers/memberLastPayment.js";
import { reverseMemberReceipt } from "./memberCreditOperations.service.js";
import {
  assertPaymentBelongsToMember,
  assertReassignablePaymentDoc,
  buildReassignAuditMemo,
  buildReversalAuditMemo,
  extractClaimReassignContext,
  extractReceiptReassignContext,
  isPaymentDocReversed,
  reassignedReceiptDocNo,
  reassignedRetainDocNo,
  reassignedToDocNo,
  receiptReversalDocNo,
  getOriginalPaymentYear,
  buildReassignPaymentPlan,
  normalizeReassignPaymentItems,
  resolveCorrectionDate,
  resolvePartialMoveAmounts,
  summarizePriorYearPayments,
} from "../helpers/paymentReassignment.helper.js";

/**
 * Mirror a Claim with offsetting Adjustment (same pattern as receipt reversal).
 */
async function reverseMemberClaim({
  claimDocNo,
  reversalDocNo,
  memberId,
  userId,
  memo,
  correctionDate,
}) {
  const docNo = String(claimDocNo || "").trim();
  const revNo = String(reversalDocNo || "").trim();
  const mid = String(memberId || "").trim();
  if (!docNo || !revNo) {
    throw AppError.badRequest("claimDocNo and reversalDocNo are required");
  }
  if (!mid) throw AppError.badRequest("memberId is required");

  const original = await GL.findOne({ docNo, docType: "Claim" }).lean();
  if (!original) {
    throw AppError.notFound(`Claim ${docNo} not found`);
  }

  const memberCheck = assertPaymentBelongsToMember(original, mid);
  if (!memberCheck.ok) throw AppError.badRequest(memberCheck.reason);

  const priorRev = await GL.findOne({ docNo: revNo }).lean();
  if (priorRev) {
    throw AppError.conflict(`Reversal document ${revNo} already exists`);
  }

  if (await isPaymentDocReversed(GL, docNo, "Claim")) {
    throw AppError.conflict(`Claim ${docNo} was already reversed`);
  }

  const lines = (original.entries || []).map((e) => ({
    accountCode: e.accountCode,
    dc: e.dc === "D" ? "C" : "D",
    amount: e.amount,
    memberId: e.memberId,
    applicationId: e.applicationId,
    periodBucket: e.periodBucket,
    categoryName: e.categoryName,
    revenueSubType: e.revenueSubType,
    adjSubType: e.adjSubType,
  }));

  if (!lines.length) {
    throw AppError.badRequest("Claim has no lines to reverse");
  }

  return postBalancedJournal({
    date: new Date(correctionDate),
    userId,
    docType: "Adjustment",
    docNo: revNo,
    reference: docNo,
    memo: memo || `Reverse claim ${docNo}`,
    lines,
    operation: "reverse_claim",
    adjSubType: "claim-reversal",
  });
}

async function postReassignedReceipt({
  targetMemberId,
  toMemberId,
  amountCents,
  clearingCode,
  settlement,
  originalDocNo,
  fromMemberId,
  userMemo,
  userId,
  tenantId,
  correctionDate,
  originalTxnMemo,
  newDocNo,
  totalCents,
  leg = "move",
}) {
  const docNoKey = newDocNo || reassignedReceiptDocNo(originalDocNo);
  const exists = await GL.findOne({ docNo: docNoKey }).lean();
  if (exists) {
    return { docNo: docNoKey, skipped: true, journal: exists };
  }

  const creditLines = await buildMemberReceiptCreditEntries(
    targetMemberId,
    amountCents,
    correctionDate,
  );

  const lines = [
    { accountCode: clearingCode, dc: "D", amount: amountCents },
    ...creditLines,
  ];

  const memo = buildReassignAuditMemo({
    fromMemberId,
    toMemberId,
    targetMemberId,
    originalDocNo,
    userMemo,
    correctionDate,
    originalTxnMemo,
    moveCents: amountCents,
    totalCents,
    leg,
  });

  const journal = await postBalancedJournal({
    date: correctionDate,
    userId,
    tenantId,
    docType: "Receipt",
    docNo: docNoKey,
    reference: originalDocNo,
    memo,
    lines,
    operation: "payment_reassignment",
    paymentMethod: inferPaymentMethodFromLines(lines),
    ...(settlement && leg === "move" ? { settlement } : {}),
  });

  return { docNo: docNoKey, skipped: false, journal };
}

async function postReassignedClaim({
  targetMemberId,
  toMemberId,
  applicationId,
  amountCents,
  periodBucket,
  originalDocNo,
  fromMemberId,
  userMemo,
  userId,
  tenantId,
  correctionDate,
  originalTxnMemo,
  newDocNo,
  totalCents,
  leg = "move",
}) {
  const docNoKey = newDocNo || reassignedReceiptDocNo(originalDocNo);
  const exists = await GL.findOne({ docNo: docNoKey }).lean();
  if (exists) {
    return { docNo: docNoKey, skipped: true, journal: exists };
  }

  const debitEntry = {
    accountCode: "2020",
    dc: "D",
    amount: amountCents,
    applicationId,
    periodBucket,
  };

  const lines = [
    debitEntry,
    {
      accountCode: "2020",
      dc: "C",
      amount: amountCents,
      memberId: targetMemberId,
      periodBucket,
    },
  ];

  const memo = buildReassignAuditMemo({
    fromMemberId,
    toMemberId,
    targetMemberId,
    originalDocNo,
    userMemo,
    correctionDate,
    originalTxnMemo,
    moveCents: amountCents,
    totalCents,
    leg,
  });

  const journal = await postBalancedJournal({
    date: correctionDate,
    userId,
    tenantId,
    docType: "Claim",
    docNo: docNoKey,
    reference: originalDocNo,
    memo,
    lines,
    operation: "payment_reassignment",
    ...(leg === "move"
      ? {
          sourceApplicationId: applicationId,
          claimMemberId: targetMemberId,
        }
      : {}),
  });

  return { docNo: docNoKey, skipped: false, journal };
}

/**
 * Update Stripe Payment doc when receipt docNo is RCP-{paymentId}.
 */
async function syncPaymentMemberFromReceiptDoc(originalDocNo, toMemberId, tenantId) {
  const m = String(originalDocNo || "")
    .trim()
    .match(/^RCP-([a-fA-F0-9]{24})$/i);
  if (!m) return { updated: false };
  const filter = { _id: m[1] };
  if (tenantId) filter.tenantId = tenantId;
  const result = await Payment.updateOne(filter, {
    $set: { memberId: String(toMemberId).trim() },
  });
  return { updated: (result.modifiedCount || 0) > 0, paymentId: m[1] };
}

/**
 * Reassign one posted payment (Receipt or Claim) from fromMemberId to toMemberId.
 */
export async function reassignSinglePayment({
  originalDocNo,
  fromMemberId,
  toMemberId,
  userId,
  tenantId,
  memo,
  correctionDate,
  amountCents: requestedMoveCents,
}) {
  const docNo = String(originalDocNo || "").trim();
  const fromMid = String(fromMemberId || "").trim();
  const toMid = String(toMemberId || "").trim();

  if (!docNo) throw AppError.badRequest("originalDocNo is required");
  if (!fromMid || !toMid) {
    throw AppError.badRequest("fromMemberId and toMemberId are required");
  }
  if (fromMid === toMid) {
    throw AppError.badRequest("Target member must differ from source member");
  }

  const original = await GL.findOne({
    docNo,
    docType: { $in: ["Receipt", "Claim"] },
  }).lean();

  if (!original) {
    throw AppError.notFound(`Payment document ${docNo} not found`);
  }

  const docType = original.docType;
  const typeCheck = assertReassignablePaymentDoc(original, docType);
  if (!typeCheck.ok) throw AppError.badRequest(typeCheck.reason);

  const belongCheck = assertPaymentBelongsToMember(original, fromMid);
  if (!belongCheck.ok) throw AppError.badRequest(belongCheck.reason);

  if (await isPaymentDocReversed(GL, docNo, docType)) {
    throw AppError.conflict(`Payment ${docNo} was already reversed`);
  }

  const reversalDocNo = receiptReversalDocNo(docNo);
  const reversalMemo = buildReversalAuditMemo({
    originalDocNo: docNo,
    docType,
    toMemberId: toMid,
    userMemo: memo,
    correctionDate,
  });

  let reversal;
  if (docType === "Receipt") {
    reversal = await reverseMemberReceipt({
      receiptDocNo: docNo,
      reversalDocNo,
      memberId: fromMid,
      userId,
      memo: reversalMemo,
      date: correctionDate,
    });
  } else {
    reversal = await reverseMemberClaim({
      claimDocNo: docNo,
      reversalDocNo,
      memberId: fromMid,
      userId,
      memo: reversalMemo,
      correctionDate,
    });
  }

  let totalCents;
  if (docType === "Receipt") {
    const ctx = extractReceiptReassignContext(original, fromMid);
    if (!ctx.ok) throw AppError.badRequest(ctx.reason);
    totalCents = ctx.amountCents;
  } else {
    const ctx = extractClaimReassignContext(original, fromMid);
    if (!ctx.ok) throw AppError.badRequest(ctx.reason);
    totalCents = ctx.amountCents;
  }

  const amounts = resolvePartialMoveAmounts(totalCents, requestedMoveCents);
  if (!amounts.ok) throw AppError.badRequest(amounts.reason);

  const { moveCents, retainCents, isPartial } = amounts;

  let repostTo;
  let repostRetain = null;

  if (docType === "Receipt") {
    const ctx = extractReceiptReassignContext(original, fromMid);
    const toDocNo = isPartial
      ? reassignedToDocNo(docNo)
      : reassignedReceiptDocNo(docNo);

    repostTo = await postReassignedReceipt({
      targetMemberId: toMid,
      toMemberId: toMid,
      amountCents: moveCents,
      clearingCode: ctx.clearingCode,
      settlement: ctx.settlement,
      originalDocNo: docNo,
      fromMemberId: fromMid,
      userMemo: memo,
      userId,
      tenantId,
      correctionDate,
      originalTxnMemo: original.memo,
      newDocNo: toDocNo,
      totalCents,
      leg: "move",
    });

    if (isPartial) {
      repostRetain = await postReassignedReceipt({
        targetMemberId: fromMid,
        toMemberId: toMid,
        amountCents: retainCents,
        clearingCode: ctx.clearingCode,
        settlement: null,
        originalDocNo: docNo,
        fromMemberId: fromMid,
        userMemo: memo,
        userId,
        tenantId,
        correctionDate,
        originalTxnMemo: original.memo,
        newDocNo: reassignedRetainDocNo(docNo),
        totalCents,
        leg: "retain",
      });
    }
  } else {
    const ctx = extractClaimReassignContext(original, fromMid);
    const toDocNo = isPartial
      ? reassignedToDocNo(docNo)
      : reassignedReceiptDocNo(docNo);

    repostTo = await postReassignedClaim({
      targetMemberId: toMid,
      toMemberId: toMid,
      amountCents: moveCents,
      applicationId: ctx.applicationId,
      periodBucket: ctx.periodBucket,
      originalDocNo: docNo,
      fromMemberId: fromMid,
      userMemo: memo,
      userId,
      tenantId,
      correctionDate,
      originalTxnMemo: original.memo,
      newDocNo: toDocNo,
      totalCents,
      leg: "move",
    });

    if (isPartial) {
      repostRetain = await postReassignedClaim({
        targetMemberId: fromMid,
        toMemberId: toMid,
        amountCents: retainCents,
        applicationId: ctx.applicationId,
        periodBucket: ctx.periodBucket,
        originalDocNo: docNo,
        fromMemberId: fromMid,
        userMemo: memo,
        userId,
        tenantId,
        correctionDate,
        originalTxnMemo: original.memo,
        newDocNo: reassignedRetainDocNo(docNo),
        totalCents,
        leg: "retain",
      });
    }
  }

  const paymentSync =
    !isPartial && docType === "Receipt"
      ? await syncPaymentMemberFromReceiptDoc(docNo, toMid, tenantId)
      : { updated: false };

  return {
    originalDocNo: docNo,
    docType,
    fromMemberId: fromMid,
    toMemberId: toMid,
    reversalDocNo: reversal?.docNo || reversalDocNo,
    reassignedDocNo: repostTo.docNo,
    reassignedSkipped: repostTo.skipped,
    retainedDocNo: repostRetain?.docNo,
    retainedSkipped: repostRetain?.skipped,
    isPartial,
    totalAmountCents: totalCents,
    movedAmountCents: moveCents,
    retainedAmountCents: retainCents,
    correctionDate,
    originalPaymentYear: getOriginalPaymentYear(original),
    paymentRecordUpdated: paymentSync.updated,
    paymentId: paymentSync.paymentId,
  };
}


/**
 * Reassign multiple payments in one request (validates all before posting).
 * @param {{ receiptDocNos: string[], fromMemberId: string, toMemberId: string, memo: string, userId?: string, tenantId?: string, correctionDate?: string, effectiveDate?: string }} input
 */
export async function reassignMemberPayments(input) {
  const {
    fromMemberId,
    toMemberId,
    memo,
    userId,
    tenantId,
    correctionDate: correctionDateInput,
    effectiveDate,
    totalMoveAmountCents: totalMoveInput,
  } = input;

  const fromMid = String(fromMemberId || "").trim();
  const items = normalizeReassignPaymentItems(input);
  const docNos = items.map((i) => i.receiptDocNo).filter(Boolean);
  if (!docNos.length) {
    throw AppError.badRequest(
      "At least one payment is required (payments[] or receiptDocNos)",
    );
  }
  if (!String(memo || "").trim()) {
    throw AppError.badRequest(
      "memo is required (audit reason for reassignment)",
    );
  }

  let correctionDate;
  try {
    correctionDate = resolveCorrectionDate(
      correctionDateInput || effectiveDate,
    );
  } catch (err) {
    throw AppError.badRequest(err.message || String(err));
  }

  const originals = await GL.find({
    docNo: { $in: docNos },
    docType: { $in: ["Receipt", "Claim"] },
  }).lean();

  const paymentTotals = new Map();
  for (const txn of originals) {
    paymentTotals.set(txn.docNo, {
      totalCents: memberPaymentCreditCents(fromMid, txn),
      date: txn.date,
    });
  }

  const poolCents =
    totalMoveInput != null && totalMoveInput !== ""
      ? Math.floor(Number(totalMoveInput))
      : null;

  const planResult = buildReassignPaymentPlan({
    items,
    paymentTotals,
    totalMoveAmountCents: poolCents,
  });
  if (!planResult.ok) {
    throw AppError.badRequest(planResult.reason);
  }

  const priorYearPayments = summarizePriorYearPayments(
    originals,
    correctionDate,
  );

  const results = [];
  const errors = [];

  for (const item of planResult.plan) {
    const originalDocNo = item.receiptDocNo;
    try {
      const row = await reassignSinglePayment({
        originalDocNo,
        fromMemberId,
        toMemberId,
        userId,
        tenantId,
        memo,
        correctionDate,
        amountCents: item.amountCents,
      });
      results.push({
        ...row,
        allocationAction: item.action,
        plannedMoveCents: item.moveCents,
        plannedRetainCents: item.retainCents,
      });
    } catch (err) {
      errors.push({
        originalDocNo,
        message: err.message || String(err),
        status: err.status || 500,
      });
    }
  }

  if (!results.length && errors.length) {
    throw AppError.badRequest("No payments could be reassigned", { errors });
  }

  return {
    reassigned: results.length,
    failed: errors.length,
    correctionDate,
    totalMoveAmountCents: poolCents ?? undefined,
    allocationPlan: planResult.allocationSummary?.plan,
    allocationUntouched: planResult.allocationSummary?.untouchedCount,
    priorYearPayments,
    closedPeriodNote:
      priorYearPayments.length > 0
        ? "Original receipts remain in their posted year. Reversal and reassignment post in the correction period only."
        : undefined,
    results,
    errors: errors.length ? errors : undefined,
  };
}
