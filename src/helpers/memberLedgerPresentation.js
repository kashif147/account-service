/**
 * Collapse related GL documents into one member-facing row (simple ledger view).
 * Full GL remains unchanged; this is presentation-only.
 */

const PRORATA_SUFFIX = "-PRORATA";
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
  if (base.settlement == null) {
    base.settlement = { status: "PENDING" };
  }
  return base;
}

function buildSubscriptionProrataGroup(invoice, prorata, memberId) {
  const norm = memberNormId(memberId);
  const netDr =
    netMemberArCents(invoice, norm) + netMemberArCents(prorata, norm);
  const cat = pickCategoryName(invoice);
  const memo = cat
    ? `Subscription fee for the year (pro-rated from your start date) — ${cat}`
    : "Subscription fee for the year (pro-rated from your start date)";
  const line = syntheticArLine({ memberId, netDrCents: netDr });
  const entries = line ? [line] : [];

  return normalizeGroupedRow({
    _id: `grouped-subscription-${String(invoice._id)}`,
    date: invoice.date,
    createdAt: maxCreatedAtIso(invoice, prorata),
    docType: "LedgerSummary",
    docNo: String(invoice.docNo || ""),
    memo,
    displayLabel: "Subscription (pro-rated)",
    ledgerPresentation: "grouped",
    groupKind: "subscription_prorata",
    sourceDocNos: [
      String(invoice.docNo || ""),
      String(prorata.docNo || ""),
    ].filter(Boolean),
    entries,
    reference: cat ? `Subscription — ${cat}` : "Subscription",
  });
}

function buildCategoryChangeGroup(invNew, cadj, memberId) {
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
      : "Membership category change (fee adjusted for the year)";
  const line = syntheticArLine({
    memberId,
    netDrCents: netDr,
    periodBucket:
      invNew.entries?.find((e) => e.memberId)?.periodBucket || "current",
  });
  const entries = line ? [line] : [];

  return normalizeGroupedRow({
    _id: `grouped-category-${String(invNew._id)}`,
    date: invNew.date,
    createdAt: maxCreatedAtIso(invNew, cadj),
    docType: "LedgerSummary",
    docNo: String(invNew.docNo || "").replace(/-INVNEW$/, "") || invNew.docNo,
    memo,
    displayLabel: "Category change",
    ledgerPresentation: "grouped",
    groupKind: "category_change",
    sourceDocNos: [
      String(invNew.docNo || ""),
      String(cadj.docNo || ""),
    ].filter(Boolean),
    entries,
    reference:
      oldCat && newCat ? `Category change — ${oldCat} → ${newCat}` : "Category change",
  });
}

/**
 * @param {object[]} items - normalized ledger rows (post consolidateCategoryChanges)
 * @param {string} memberId
 * @returns {object[]}
 */
export function simplifyMemberLedgerPresentations(items, memberId) {
  const norm = memberNormId(memberId);
  const consumed = new Set();
  const out = [];

  for (const txn of items) {
    const id = String(txn._id ?? "");
    if (id && consumed.has(id)) continue;

    const docNo = String(txn.docNo || "");

    if (docNo.endsWith(PRORATA_SUFFIX)) {
      const base = docNo.slice(0, -PRORATA_SUFFIX.length);
      const inv = items.find(
        (x) =>
          x.docType === "Invoice" &&
          String(x.docNo || "") === base &&
          !String(x.docNo || "").endsWith(INVNEW_SUFFIX) &&
          !consumed.has(String(x._id ?? "")),
      );
      if (inv) {
        consumed.add(String(inv._id ?? ""));
        consumed.add(String(txn._id ?? ""));
        out.push(buildSubscriptionProrataGroup(inv, txn, memberId));
        continue;
      }
      out.push(txn);
      continue;
    }

    if (txn.docType === "Invoice" && !docNo.endsWith(INVNEW_SUFFIX)) {
      const pr = items.find(
        (x) =>
          String(x.docNo || "") === docNo + PRORATA_SUFFIX &&
          !consumed.has(String(x._id ?? "")),
      );
      if (pr) {
        consumed.add(String(txn._id ?? ""));
        consumed.add(String(pr._id ?? ""));
        out.push(buildSubscriptionProrataGroup(txn, pr, memberId));
        continue;
      }
      out.push(txn);
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
        out.push(buildCategoryChangeGroup(txn, cadj, memberId));
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
        out.push(buildCategoryChangeGroup(invNew, txn, memberId));
        continue;
      }
      out.push(txn);
      continue;
    }

    out.push(txn);
  }

  return out;
}
