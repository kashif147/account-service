import GL from "../models/glTransaction.model.js";

const AMOUNT_TOLERANCE_CENTS = 50;

function memberIdFromGl(txn) {
  if (!txn?.entries?.length) return null;
  for (const e of txn.entries) {
    const mid = String(e.memberId || "").trim();
    if (mid && !mid.toLowerCase().startsWith("app:")) return mid;
  }
  return null;
}

function clearingLineAmount(txn, clearingAccountCode) {
  const line = (txn.entries || []).find(
    (e) => e.accountCode === clearingAccountCode,
  );
  return line ? Number(line.amount) || 0 : null;
}

/**
 * @param {object} rec — reconciliation record lean doc
 * @param {Map<string, object>} glByDocNo — preloaded GL txns
 */
export function enrichReconciliationRecord(rec, glByDocNo = new Map()) {
  const amount = Number(rec.amount) || 0;
  const bankRef =
    rec.externalReference ||
    rec.bankReference ||
    rec.glDocNo ||
    "";

  let memberId = rec.memberId || null;
  let expectedAmount = amount;
  let payoutId = null;
  let glDocType = null;

  if (rec.glDocNo) {
    const gl = glByDocNo.get(rec.glDocNo);
    if (gl) {
      memberId = memberId || memberIdFromGl(gl);
      const clearingAmt = clearingLineAmount(gl, rec.clearingAccountCode);
      if (clearingAmt != null) expectedAmount = clearingAmt;
      payoutId = gl.settlement?.payoutId || null;
      glDocType = gl.docType || null;
    }
  }

  const amountDifference = amount - expectedAmount;
  const absDiff = Math.abs(amountDifference);

  let matchConfidence = "none";
  let suggestedAction = "manual_match";

  const st = rec.reconciliationStatus || "unmatched";
  if (st === "settled") {
    matchConfidence = "complete";
    suggestedAction = "none";
  } else if (st === "auto_matched") {
    matchConfidence = "high";
    suggestedAction = "settle";
  } else if (st === "manual_matched") {
    matchConfidence = "medium";
    suggestedAction = "settle";
  } else if (st === "suspense") {
    matchConfidence = "low";
    suggestedAction = "review";
  } else if (rec.matchedGlDocNo) {
    matchConfidence = "medium";
    suggestedAction = "settle";
  } else if (absDiff === 0 && rec.glDocNo && rec.sourceType !== "bank") {
    matchConfidence = "high";
    suggestedAction = "settle";
  } else if (absDiff <= AMOUNT_TOLERANCE_CENTS && rec.glDocNo) {
    matchConfidence = "medium";
    suggestedAction = "review";
  } else if (absDiff > AMOUNT_TOLERANCE_CENTS && amount > 0) {
    matchConfidence = "low";
    suggestedAction = absDiff <= 500 ? "review" : "suspense";
  }

  return {
    ...rec,
    bankRef,
    memberId,
    expectedAmount,
    amountDifference,
    matchConfidence,
    suggestedAction,
    payoutId,
    glDocType,
  };
}

export async function enrichReconciliationRecords(records) {
  if (!records?.length) return [];

  const docNos = [
    ...new Set(records.map((r) => r.glDocNo).filter(Boolean)),
  ];
  const glRows = docNos.length
    ? await GL.find({ docNo: { $in: docNos } }).lean()
    : [];
  const glByDocNo = new Map(glRows.map((g) => [g.docNo, g]));

  return records.map((r) => enrichReconciliationRecord(r, glByDocNo));
}

export async function findGlMatchForBankLine({
  externalReference,
  amount,
  clearingAccountCode,
}) {
  const ref = String(externalReference || "").trim();
  if (!ref) return null;

  const candidates = await GL.find({
    $or: [
      { docNo: ref },
      { reference: ref },
      { "settlement.payoutId": ref },
    ],
    "entries.accountCode": clearingAccountCode,
  })
    .limit(20)
    .lean();

  const amt = Number(amount) || 0;
  let best = null;

  for (const gl of candidates) {
    const clearingAmt = clearingLineAmount(gl, clearingAccountCode);
    if (clearingAmt == null) continue;
    const diff = Math.abs(clearingAmt - amt);
    const confidence =
      diff === 0 ? "high" : diff <= AMOUNT_TOLERANCE_CENTS ? "medium" : "low";
    if (!best || diff < Math.abs(best.clearingAmount - amt)) {
      best = {
        glDocNo: gl.docNo,
        clearingAmount: clearingAmt,
        amountDifference: amt - clearingAmt,
        confidence,
        memberId: memberIdFromGl(gl),
        payoutId: gl.settlement?.payoutId || null,
      };
    }
  }

  if (best?.confidence === "high") return best;
  if (best?.confidence === "medium") return best;
  return null;
}

export { AMOUNT_TOLERANCE_CENTS };
