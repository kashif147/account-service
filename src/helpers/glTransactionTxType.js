import CoA from "../models/coa.model.js";

/** Cash / bank / clearing codes used to label how cash moved for receipts & refunds. */
export const GL_TX_TYPE_ACCOUNT_CODES = [
  "1100",
  "1200",
  "1210",
  "1220",
  "1230",
  "1240",
  "1250",
];

const CODE_SET = new Set(GL_TX_TYPE_ACCOUNT_CODES);

function pickLargestAmount(lines) {
  if (!lines.length) return null;
  return lines.reduce((best, e) =>
    Number(e.amount) > Number(best.amount) ? e : best
  );
}

/**
 * Pick the entry line that best represents payment/refund rail (clearing or cash).
 * @param {object} txn - GL transaction (docType, entries)
 * @returns {string|null} accountCode
 */
export function resolveTxTypeAccountCode(txn) {
  const entries = txn.entries || [];
  const docType = String(txn.docType || "");

  // Write-off: no clearing/cash legs — label by bad-debt line or AR reduction
  if (docType === "WriteOff" && entries.length) {
    const byAdj = entries.find((e) => e.adjSubType === "writeoff");
    if (byAdj?.accountCode) return String(byAdj.accountCode);
    const expense = entries.find((e) => e.accountCode === "5200");
    if (expense) return "5200";
    const ar = entries.find((e) => e.accountCode === "1400");
    if (ar) return "1400";
    return null;
  }

  const hits = entries.filter((e) => CODE_SET.has(e.accountCode));
  if (!hits.length) return null;

  if (docType === "Refund") {
    const credits = hits.filter((e) => e.dc === "C");
    const pool = credits.length ? credits : hits;
    const line = pickLargestAmount(pool);
    return line ? line.accountCode : null;
  }

  if (docType === "Receipt") {
    const debits = hits.filter((e) => e.dc === "D");
    const pool = debits.length ? debits : hits;
    const line = pickLargestAmount(pool);
    return line ? line.accountCode : null;
  }

  for (const code of GL_TX_TYPE_ACCOUNT_CODES) {
    const line = hits.find((e) => e.accountCode === code);
    if (line) return line.accountCode;
  }

  return hits[0].accountCode;
}

export async function loadCoaTxTypeDescriptionMap(extraCodes = []) {
  const codes = [
    ...new Set([...GL_TX_TYPE_ACCOUNT_CODES, ...extraCodes].filter(Boolean)),
  ];
  const rows = await CoA.find({
    code: { $in: codes },
  })
    .select({ code: 1, description: 1 })
    .lean();
  return new Map(rows.map((r) => [r.code, r.description]));
}

/**
 * @param {object[]} items - ledger / statement rows
 * @returns {Promise<object[]>} same items with `txType: { code, description } | null`
 */
export async function attachTxTypesToLedgerItems(items) {
  if (!Array.isArray(items) || items.length === 0) return items || [];
  const resolvedCodes = items
    .map((txn) => resolveTxTypeAccountCode(txn))
    .filter((c) => c != null);
  const descMap = await loadCoaTxTypeDescriptionMap(resolvedCodes);
  return items.map((txn) => {
    const code = resolveTxTypeAccountCode(txn);
    const txType =
      code != null
        ? { code, description: descMap.get(code) ?? null }
        : null;
    return { ...txn, txType };
  });
}
