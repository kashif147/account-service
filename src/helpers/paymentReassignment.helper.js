import { resolveTxTypeAccountCode } from "./glTransactionTxType.js";
import { memberPaymentCreditCents } from "./memberLastPayment.js";

const RECEIPT_REVERSAL_MEMO_PREFIX = "Reverse receipt ";
const CLAIM_REVERSAL_MEMO_PREFIX = "Reverse claim ";
const REASSIGN_RECEIPT_PREFIX = "RAS-";

/** @param {string} docNo */
export function reassignedReceiptDocNo(docNo) {
  const base = String(docNo || "").trim();
  return `${REASSIGN_RECEIPT_PREFIX}${base}`.slice(0, 120);
}

/** @param {string} docNo — target member leg (partial or full move) */
export function reassignedToDocNo(docNo) {
  const base = String(docNo || "").trim();
  return `${REASSIGN_RECEIPT_PREFIX}${base}-TO`.slice(0, 120);
}

/** @param {string} docNo — remainder left on source member after partial move */
export function reassignedRetainDocNo(docNo) {
  const base = String(docNo || "").trim();
  return `${REASSIGN_RECEIPT_PREFIX}${base}-RET`.slice(0, 120);
}

/**
 * @param {number} totalCents
 * @param {number|null|undefined} requestedMoveCents — omit for full move
 */
export function resolvePartialMoveAmounts(totalCents, requestedMoveCents) {
  const total = Math.max(0, Math.floor(Number(totalCents) || 0));
  if (total <= 0) {
    return { ok: false, reason: "Payment has no amount to reassign" };
  }

  const hasRequest =
    requestedMoveCents != null &&
    requestedMoveCents !== "" &&
    !Number.isNaN(Number(requestedMoveCents));

  let moveCents = hasRequest ? Math.floor(Number(requestedMoveCents)) : total;

  if (!Number.isInteger(moveCents) || moveCents <= 0) {
    return {
      ok: false,
      reason: "amountCents must be a positive integer (minor units)",
    };
  }
  if (moveCents > total) {
    return {
      ok: false,
      reason: `amountCents (${moveCents}) cannot exceed payment total (${total})`,
    };
  }

  const retainCents = total - moveCents;
  return {
    ok: true,
    moveCents,
    retainCents,
    totalCents: total,
    isPartial: retainCents > 0,
  };
}

/**
 * Greedy allocation: oldest payments first, full moves until total exhausted, then one partial.
 * Payments after the pool is used are left untouched (not reversed).
 *
 * @param {{ receiptDocNo: string, totalCents: number, date?: string|Date }[]} payments
 * @param {number} totalMoveCents
 */
export function allocateTotalMoveAcrossPayments(payments, totalMoveCents) {
  const moveTotal = Math.floor(Number(totalMoveCents) || 0);
  const sorted = [...(payments || [])].sort((a, b) => {
    const da = a?.date ? new Date(a.date).getTime() : 0;
    const db = b?.date ? new Date(b.date).getTime() : 0;
    if (da !== db) return da - db;
    return String(a.receiptDocNo || "").localeCompare(
      String(b.receiptDocNo || ""),
    );
  });

  const selectedTotalCents = sorted.reduce(
    (s, p) => s + Math.max(0, Math.floor(Number(p.totalCents) || 0)),
    0,
  );

  if (selectedTotalCents <= 0) {
    return { ok: false, reason: "Selected payments have no amount to reassign" };
  }
  if (moveTotal <= 0) {
    return {
      ok: false,
      reason: "totalMoveAmountCents must be a positive integer (minor units)",
    };
  }
  if (moveTotal > selectedTotalCents) {
    return {
      ok: false,
      reason: `Total to move (${moveTotal}) cannot exceed selected payments total (${selectedTotalCents})`,
    };
  }

  let remaining = moveTotal;
  const plan = [];

  for (const p of sorted) {
    const docNo = String(p.receiptDocNo || "").trim();
    const lineTotal = Math.max(0, Math.floor(Number(p.totalCents) || 0));
    if (!docNo || lineTotal <= 0) continue;

    if (remaining <= 0) {
      plan.push({
        receiptDocNo: docNo,
        action: "skip",
        moveCents: 0,
        retainCents: lineTotal,
        totalCents: lineTotal,
      });
      continue;
    }

    if (remaining >= lineTotal) {
      plan.push({
        receiptDocNo: docNo,
        action: "full",
        moveCents: lineTotal,
        retainCents: 0,
        totalCents: lineTotal,
      });
      remaining -= lineTotal;
    } else {
      plan.push({
        receiptDocNo: docNo,
        action: "partial",
        moveCents: remaining,
        retainCents: lineTotal - remaining,
        totalCents: lineTotal,
      });
      remaining = 0;
    }
  }

  return {
    ok: true,
    plan,
    totalMoveCents: moveTotal,
    selectedTotalCents,
    allocatedCents: moveTotal - remaining,
    untouchedCount: plan.filter((x) => x.action === "skip").length,
  };
}

/**
 * Build per-payment move amounts from explicit items and/or pooled total.
 * @param {{ items: { receiptDocNo: string, amountCents?: number|null }[], paymentTotals: Map<string, { totalCents: number, date?: Date }>, totalMoveAmountCents?: number|null }} ctx
 */
export function buildReassignPaymentPlan({ items, paymentTotals, totalMoveAmountCents }) {
  const hasPool =
    totalMoveAmountCents != null &&
    totalMoveAmountCents !== "" &&
    !Number.isNaN(Number(totalMoveAmountCents));

  const explicitAll = items.every(
    (i) => i.amountCents != null && i.amountCents !== "",
  );

  if (hasPool) {
    const payments = items.map((i) => {
      const meta = paymentTotals.get(i.receiptDocNo) || {};
      return {
        receiptDocNo: i.receiptDocNo,
        totalCents: meta.totalCents || 0,
        date: meta.date,
      };
    });
    const allocated = allocateTotalMoveAcrossPayments(
      payments,
      totalMoveAmountCents,
    );
    if (!allocated.ok) return allocated;

    return {
      ok: true,
      plan: allocated.plan
        .filter((p) => p.action !== "skip")
        .map((p) => ({
          receiptDocNo: p.receiptDocNo,
          amountCents: p.action === "full" ? null : p.moveCents,
          action: p.action,
          moveCents: p.moveCents,
          retainCents: p.retainCents,
          totalCents: p.totalCents,
        })),
      allocationSummary: allocated,
    };
  }

  if (explicitAll) {
    return {
      ok: true,
      plan: items.map((i) => ({
        receiptDocNo: i.receiptDocNo,
        amountCents: Math.floor(Number(i.amountCents)),
        action: "explicit",
      })),
    };
  }

  return {
    ok: true,
    plan: items.map((i) => ({
      receiptDocNo: i.receiptDocNo,
      amountCents: null,
      action: "full",
    })),
  };
}

/**
 * Normalise API body to [{ receiptDocNo, amountCents? }].
 * @param {{ payments?: object[], receiptDocNos?: string[] }} input
 */
export function normalizeReassignPaymentItems(input) {
  const { payments, receiptDocNos = [] } = input || {};
  if (Array.isArray(payments) && payments.length) {
    return payments.map((p) => ({
      receiptDocNo: String(p?.receiptDocNo || p?.originalDocNo || "").trim(),
      amountCents:
        p?.amountCents != null && p?.amountCents !== ""
          ? Math.floor(Number(p.amountCents))
          : null,
    }));
  }
  return [...new Set(receiptDocNos.map((d) => String(d || "").trim()).filter(Boolean))].map(
    (receiptDocNo) => ({ receiptDocNo, amountCents: null }),
  );
}

/** @param {string} docNo */
export function receiptReversalDocNo(docNo) {
  return `RVR-${String(docNo || "").trim()}`.slice(0, 120);
}

/**
 * @param {object} txn - GL transaction
 * @param {string} fromMemberId
 */
export function assertPaymentBelongsToMember(txn, fromMemberId) {
  const mid = String(fromMemberId || "").trim();
  const touched = (txn.entries || []).some(
    (e) => String(e.memberId || "").trim() === mid,
  );
  if (!touched) {
    return {
      ok: false,
      reason: `Document ${txn.docNo} is not allocated to member ${mid}`,
    };
  }
  return { ok: true };
}

/**
 * @param {object} txn
 * @param {"Receipt"|"Claim"} expectedDocType
 */
export function assertReassignablePaymentDoc(txn, expectedDocType) {
  const docType = String(txn?.docType || "");
  if (docType !== expectedDocType) {
    return {
      ok: false,
      reason: `Document ${txn?.docNo} is ${docType}, expected ${expectedDocType}`,
    };
  }
  return { ok: true };
}

/**
 * Member-facing payment total and clearing rail from an original Receipt.
 * @param {object} txn
 * @param {string} fromMemberId
 */
export function extractReceiptReassignContext(txn, fromMemberId) {
  const amountCents = memberPaymentCreditCents(fromMemberId, txn);
  if (amountCents <= 0) {
    return {
      ok: false,
      reason: `No member credit amount found on ${txn.docNo} for member ${fromMemberId}`,
    };
  }
  const clearingCode = resolveTxTypeAccountCode(txn);
  if (!clearingCode) {
    return {
      ok: false,
      reason: `Could not determine clearing account on ${txn.docNo}`,
    };
  }
  return {
    ok: true,
    amountCents,
    clearingCode,
    settlement: txn.settlement || null,
    originalDate: txn.date,
  };
}

/**
 * @param {object} txn - Claim document
 * @param {string} fromMemberId
 */
export function extractClaimReassignContext(txn, fromMemberId) {
  const amountCents = memberPaymentCreditCents(fromMemberId, txn);
  if (amountCents <= 0) {
    return {
      ok: false,
      reason: `No member credit on claim ${txn.docNo} for member ${fromMemberId}`,
    };
  }
  const applicationId =
    txn.sourceApplicationId ||
    (txn.entries || []).find((e) => e.applicationId)?.applicationId ||
    null;
  if (!applicationId) {
    return {
      ok: false,
      reason: `Claim ${txn.docNo} has no applicationId for reassignment`,
    };
  }
  const bucket =
    (txn.entries || []).find(
      (e) => String(e.memberId || "").trim() === fromMemberId,
    )?.periodBucket || "current";
  return {
    ok: true,
    amountCents,
    applicationId: String(applicationId).trim(),
    periodBucket: bucket,
    originalDate: txn.date,
  };
}

/**
 * Parse batch import context from receipt memo (batch uploads).
 * @param {string} memo
 * @returns {string|null}
 */
export function extractBatchContextFromMemo(memo) {
  const s = String(memo || "").trim();
  if (!/Batch:/i.test(s)) return null;
  const segments = s
    .split("|")
    .map((p) => p.trim())
    .filter((p) => /^Batch:/i.test(p) || /^Ref:/i.test(p) || /^Member:/i.test(p) || /^Row:/i.test(p));
  return segments.length ? segments.join(" | ") : null;
}

/**
 * Calendar year of the original posted payment (for closed-period warnings).
 * @param {object} txn
 * @returns {number|null}
 */
export function getOriginalPaymentYear(txn) {
  if (!txn?.date) return null;
  const y = new Date(txn.date).getFullYear();
  return Number.isFinite(y) ? y : null;
}

/**
 * Correction journals must post in the current (open) period — not back-dated into audited years.
 * @param {string|Date|undefined} input - ISO date or omitted (= today)
 * @returns {string} YYYY-MM-DD
 */
export function resolveCorrectionDate(input) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const todayIso = now.toISOString().split("T")[0];

  let iso = input != null ? String(input).trim().split("T")[0] : "";
  if (!iso) iso = todayIso;

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("correctionDate must be a valid ISO date (YYYY-MM-DD)");
  }

  const correctionYear = parsed.getFullYear();
  if (correctionYear < currentYear) {
    throw new Error(
      `Correction date must be in ${currentYear} or later. Do not back-date into closed audited periods; original receipts stay in their year.`,
    );
  }

  return iso;
}

/**
 * @param {object[]} originals - GL lean docs
 * @param {string} correctionDateIso
 */
export function summarizePriorYearPayments(originals, correctionDateIso) {
  const correctionYear = new Date(correctionDateIso).getFullYear();
  const prior = [];
  for (const txn of originals || []) {
    const y = getOriginalPaymentYear(txn);
    if (y != null && y < correctionYear) {
      prior.push({
        docNo: txn.docNo,
        originalYear: y,
        originalDate:
          txn.date instanceof Date
            ? txn.date.toISOString().split("T")[0]
            : String(txn.date || "").split("T")[0],
      });
    }
  }
  return prior;
}

export function buildReassignAuditMemo({
  fromMemberId,
  toMemberId,
  targetMemberId,
  originalDocNo,
  userMemo,
  correctionDate,
  originalTxnMemo,
  moveCents,
  totalCents,
  leg = "move",
}) {
  const target = targetMemberId || toMemberId;
  const parts = [];

  if (leg === "retain" && moveCents != null) {
    parts.push(
      `Reassign retain: €${(moveCents / 100).toFixed(2)} remains on member ${fromMemberId}`,
      `after partial move to ${toMemberId}`,
    );
  } else if (
    moveCents != null &&
    totalCents != null &&
    Math.floor(moveCents) < Math.floor(totalCents)
  ) {
    parts.push(
      `Reassign partial: €${(moveCents / 100).toFixed(2)} of €${(totalCents / 100).toFixed(2)} → member ${target}`,
      `From member ${fromMemberId}`,
    );
  } else {
    parts.push(`Reassign payment: member ${fromMemberId} → ${target}`);
  }

  parts.push(`Original: ${originalDocNo}`, `Correction date: ${correctionDate || "—"}`);
  const batchCtx = extractBatchContextFromMemo(originalTxnMemo);
  if (batchCtx) parts.push(`Source import: ${batchCtx}`);
  const note = String(userMemo || "").trim();
  if (note) parts.push(`Reason: ${note}`);
  return parts.join(" | ");
}

export function buildReversalAuditMemo({
  originalDocNo,
  docType,
  toMemberId,
  userMemo,
  correctionDate,
}) {
  const label = docType === "Claim" ? "claim" : "receipt";
  const base = `Reverse ${label} ${originalDocNo} (reassign to member ${toMemberId})`;
  const parts = [base, `Correction date: ${correctionDate || "—"}`];
  const note = String(userMemo || "").trim();
  if (note) parts.push(note);
  return parts.join(" | ");
}

export async function isPaymentDocReversed(GL, originalDocNo, docType) {
  const prefix =
    docType === "Claim" ? CLAIM_REVERSAL_MEMO_PREFIX : RECEIPT_REVERSAL_MEMO_PREFIX;
  const escaped = String(originalDocNo || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = await GL.findOne({
    memo: { $regex: `${prefix}${escaped}` },
  }).lean();
  return Boolean(hit);
}
