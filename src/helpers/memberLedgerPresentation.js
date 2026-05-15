/**
 * Simple member ledger view: presentation-only (full GL unchanged).
 * - Initial subscription: show original Invoice + Prorata rows separately (labeled).
 * - Category change: one row (net AR), labeled Fee Increase / Fee Decrease.
 */

const PRORATA_SUFFIX = "-PRORATA";
const CATNET_SUFFIX = "-CATNET";
const INVNEW_SUFFIX = "-INVNEW";
const CADJ_SUFFIX = "-CADJ";

function memberNormId(memberId) {
  return String(memberId || "").trim().toLowerCase();
}

/** Net (debit − credit) on 1400 for the member in cents. */
function netMemberArCents(txn, norm) {
  let debit = 0;
  let credit = 0;
  for (const e of txn.entries || []) {
    if (String(e.memberId || "").trim().toLowerCase() !== norm) continue;
    if (e.accountCode !== "1400") continue;
    const amt = Number(e.amount) || 0;
    if (e.dc === "D") debit += amt;
    else credit += amt;
  }
  return debit - credit;
}

/** Net member AR on 1400 for one GL document (cents). Shared with member summary (latest invoice). */
export function memberNetAr1400Cents(txn, memberId) {
  return netMemberArCents(txn, memberNormId(memberId));
}

function pickCategoryName(txn) {
  const feeLine = txn.entries?.find(
    (e) =>
      (e.revenueSubType === "fee" ||
        e.revenueSubType === "Fee Increase" ||
        e.revenueSubType === "Fee Decrease") &&
      e.categoryName,
  );
  return feeLine?.categoryName || null;
}

function maxCreatedAtIso(a, b) {
  const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
  const t = Math.max(ta, tb);
  if (!t) return a?.createdAt || b?.createdAt || new Date().toISOString();
  return new Date(t).toISOString();
}

function syntheticArLine({ memberId, netDrCents, periodBucket = "current" }) {
  const mid = String(memberId || "").trim();
  if (netDrCents > 0) {
    return {
      accountCode: "1400",
      dc: "D",
      amount: netDrCents,
      memberId: mid,
      periodBucket,
    };
  }
  if (netDrCents < 0) {
    return {
      accountCode: "1400",
      dc: "C",
      amount: -netDrCents,
      memberId: mid,
      periodBucket,
    };
  }
  return null;
}

function normalizeGroupedRow(txn) {
  const base = { ...txn };
  const clearingDocTypes = new Set(["Receipt", "Claim", "Refund"]);
  if (base.settlement == null && clearingDocTypes.has(base.docType)) {
    base.settlement = { status: "PENDING" };
  }
  return base;
}

/** Doc column label for single CATNET adjustment (Fee Increase / Fee Decrease / neutral). */
function feeChangeLedgerDisplayDocTypeCatNet(txn) {
  const entries = txn.entries || [];
  if (entries.some((e) => e.revenueSubType === "Fee Increase"))
    return "Fee Increase";
  if (entries.some((e) => e.revenueSubType === "Fee Decrease"))
    return "Fee Decrease";
  return "Fee Adjustment";
}

function pickCatNetCategories(txn) {
  const oldLine = txn.entries?.find(
    (e) => e.adjSubType === "category-change-old-tier-release",
  );
  const newLine = txn.entries?.find(
    (e) =>
      e.dc === "C" &&
      e.categoryName &&
      (e.revenueSubType === "fee" ||
        e.revenueSubType === "Fee Increase" ||
        e.revenueSubType === "Fee Decrease"),
  );
  return {
    oldCat: oldLine?.categoryName ?? null,
    newCat: newLine?.categoryName ?? null,
  };
}

/** Doc column label for category-change bundle (from INVNEW revenue line). */
function feeChangeLedgerDisplayDocType(invNew) {
  const feeLine = invNew.entries?.find(
    (e) =>
      e.revenueSubType === "Fee Increase" ||
      e.revenueSubType === "Fee Decrease" ||
      e.revenueSubType === "fee",
  );
  const st = feeLine?.revenueSubType;
  if (st === "Fee Increase") return "Fee Increase";
  if (st === "Fee Decrease") return "Fee Decrease";
  return "Fee Adjustment";
}

/**
 * Single simple-view row for mid-year category change (replaces INVNEW + CADJ pair).
 */
function buildFeeChangeSimpleRow(invNew, cadj, memberId) {
  const norm = memberNormId(memberId);
  const netDr = netMemberArCents(invNew, norm) + netMemberArCents(cadj, norm);
  const newCat = pickCategoryName(invNew);
  const oldLine = cadj.entries?.find(
    (e) =>
      e.adjSubType === "category-upgrade-unused-credit" ||
      e.adjSubType === "category-downgrade-unused-credit",
  );
  const oldCat = oldLine?.categoryName || null;
  const memoParts = [];
  if (oldCat && newCat) memoParts.push(`${oldCat} → ${newCat}`);
  else if (newCat) memoParts.push(newCat);
  const memo =
    memoParts.length > 0
      ? `Membership category change — ${memoParts[0]}`
      : cadj.memo || "Membership category change (fee adjusted for the year)";
  const line = syntheticArLine({
    memberId,
    netDrCents: netDr,
    periodBucket:
      invNew.entries?.find((e) => e.memberId)?.periodBucket || "current",
  });
  const entries = line ? [line] : [];

  const ledgerDisplayDocType = feeChangeLedgerDisplayDocType(invNew);

  return normalizeGroupedRow({
    _id: `simple-fee-change-${String(cadj._id)}`,
    date: cadj.date || invNew.date,
    createdAt: maxCreatedAtIso(invNew, cadj),
    docType: "Adjustment",
    docNo: String(cadj.docNo || ""),
    memo,
    displayLabel: ledgerDisplayDocType,
    ledgerDisplayDocType,
    ledgerPresentation: "fee_change_simple",
    groupKind: "category_change",
    sourceDocNos: [
      String(invNew.docNo || ""),
      String(cadj.docNo || ""),
    ].filter(Boolean),
    entries,
    reference:
      oldCat && newCat ? `Category change — ${oldCat} → ${newCat}` : "Category change",
    paymentIntentId: null,
    txType: null,
  });
}

/** Single-row simple view for CATNET category-change adjustment (one GL doc). */
function buildFeeChangeCatNetRow(txn, memberId) {
  const norm = memberNormId(memberId);
  const netDr = netMemberArCents(txn, norm);
  const { oldCat, newCat } = pickCatNetCategories(txn);
  const memoParts = [];
  if (oldCat && newCat) memoParts.push(`${oldCat} → ${newCat}`);
  else if (newCat) memoParts.push(newCat);
  const memo =
    memoParts.length > 0
      ? `Membership category change — ${memoParts[0]}`
      : txn.memo || "Membership category change (fee adjusted for the year)";
  const line = syntheticArLine({
    memberId,
    netDrCents: netDr,
    periodBucket:
      txn.entries?.find((e) => e.memberId)?.periodBucket || "current",
  });
  const entries = line ? [line] : [];
  const ledgerDisplayDocType = feeChangeLedgerDisplayDocTypeCatNet(txn);

  return normalizeGroupedRow({
    _id: `simple-fee-change-${String(txn._id)}`,
    date: txn.date,
    createdAt: txn.createdAt || txn.date,
    docType: "Adjustment",
    docNo: String(txn.docNo || ""),
    memo,
    displayLabel: ledgerDisplayDocType,
    ledgerDisplayDocType,
    ledgerPresentation: "fee_change_simple",
    groupKind: "category_change",
    sourceDocNos: [String(txn.docNo || "")].filter(Boolean),
    entries,
    reference:
      oldCat && newCat
        ? `Category change — ${oldCat} → ${newCat}`
        : "Category change",
    paymentIntentId: null,
    txType: null,
  });
}

/** Initial subscription prorata row: show as Fee Adjustment in simple view. */
function withProrataSimpleLabels(txn) {
  return {
    ...txn,
    ledgerDisplayDocType: "Fee Adjustment",
    displayLabel: "Fee Adjustment",
  };
}

/**
 * @param {object[]} items - normalized ledger rows (post consolidateCategoryChanges)
 * @param {string} memberId
 * @returns {object[]}
 */
export function simplifyMemberLedgerPresentations(items, memberId) {
  const consumed = new Set();
  const out = [];

  for (const txn of items) {
    const id = String(txn._id ?? "");
    if (id && consumed.has(id)) continue;

    const docNo = String(txn.docNo || "");

    if (docNo.endsWith(CATNET_SUFFIX)) {
      out.push(buildFeeChangeCatNetRow(txn, memberId));
      continue;
    }

    if (docNo.endsWith(INVNEW_SUFFIX)) {
      const base = docNo.slice(0, -INVNEW_SUFFIX.length);
      const cadj = items.find(
        (x) =>
          String(x.docNo || "") === base + CADJ_SUFFIX &&
          !consumed.has(String(x._id ?? "")),
      );
      if (cadj) {
        consumed.add(String(txn._id ?? ""));
        consumed.add(String(cadj._id ?? ""));
        out.push(buildFeeChangeSimpleRow(txn, cadj, memberId));
        continue;
      }
      out.push(txn);
      continue;
    }

    if (docNo.endsWith(CADJ_SUFFIX)) {
      const base = docNo.slice(0, -CADJ_SUFFIX.length);
      const invNew = items.find(
        (x) =>
          String(x.docNo || "") === base + INVNEW_SUFFIX &&
          !consumed.has(String(x._id ?? "")),
      );
      if (invNew) {
        consumed.add(String(invNew._id ?? ""));
        consumed.add(String(txn._id ?? ""));
        out.push(buildFeeChangeSimpleRow(invNew, txn, memberId));
        continue;
      }
      out.push(txn);
      continue;
    }

    if (docNo.endsWith(PRORATA_SUFFIX)) {
      out.push(withProrataSimpleLabels(txn));
      continue;
    }

    out.push(txn);
  }

  return out;
}
