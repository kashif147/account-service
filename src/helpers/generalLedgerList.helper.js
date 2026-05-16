import GL from "../models/glTransaction.model.js";
import CoA from "../models/coa.model.js";
import { simplifyMemberLedgerPresentations } from "./memberLedgerPresentation.js";
import { attachPaymentIntentIdsToLedgerItems } from "./memberLedgerPaymentIntent.js";
import { attachTxTypesToLedgerItems } from "./glTransactionTxType.js";
import { listCreditNotes } from "../services/creditNote.service.js";
import { isApplicationCreditClaimReceipt } from "./memberLastPayment.js";

function attachClaimLedgerReference(items) {
  if (!Array.isArray(items)) return items;
  return items.map((txn) => {
    if (!isApplicationCreditClaimReceipt(txn)) return txn;
    const pi = txn.paymentIntentId;
    if (pi) return { ...txn, reference: String(pi).trim() };
    return txn;
  });
}

const CATEGORY_CHANGE_DOCNO_RE =
  /^(.+?)-(INVNEW|CADJ|COLD|CNEW|CATNET)$/;

const FETCH_PAGE_SIZE = 500;
const DEFAULT_MAX_GL_DOCUMENTS = 15000;

function normalizeLedgerGlTxn(txn) {
  const isProrataFee =
    txn.docType === "Adjustment" &&
    txn.entries?.some((e) => e.adjSubType === "prorata-fee-adjustment");

  const base =
    txn.docType === "CreditNote"
      ? {
          ...txn,
          displayLabel: "Credit Note",
          ledgerDisplayDocType: "Credit Note",
        }
      : isProrataFee
        ? {
            ...txn,
            displayLabel: "Pro-rata fee adjustment",
            displayType: "prorata_fee_adjustment",
          }
        : { ...txn };

  const clearingDocTypes = new Set(["Receipt", "Claim", "Refund"]);
  if (base.settlement == null && clearingDocTypes.has(base.docType)) {
    base.settlement = { status: "PENDING" };
  }
  return base;
}

function consolidateCategoryChanges(transactions) {
  const consolidated = [];
  for (const txn of transactions) {
    if (txn.docNo && CATEGORY_CHANGE_DOCNO_RE.test(txn.docNo)) {
      consolidated.push(normalizeLedgerGlTxn(txn));
      continue;
    }
    if (txn.docType === "Adjustment") {
      const adjSubType = txn.entries?.find((e) => e.adjSubType)?.adjSubType;
      const isCategoryChangeAdjustment =
        adjSubType === "category-upgrade-unused-credit" ||
        adjSubType === "category-downgrade-unused-credit" ||
        adjSubType === "category-change-prorata-credit";
      if (isCategoryChangeAdjustment) continue;
    }
    if (txn.docType === "Settlement") continue;
    consolidated.push(normalizeLedgerGlTxn(txn));
  }
  return consolidated;
}

async function getMemberTrackedAccountCodes() {
  const rows = await CoA.find({ isMemberTracked: true }).select("code").lean();
  return rows.map((r) => r.code).filter(Boolean);
}

function normMemberKey(value) {
  return String(value || "").trim().toLowerCase();
}

/** Member this GL row belongs to (claims use document-level claimMemberId). */
export function resolveGlTxnMemberId(txn, trackedCodes = []) {
  const docType = String(txn.docType || "").trim().toLowerCase();
  if (docType === "claim") {
    const claimMid = String(txn.claimMemberId || "").trim();
    if (claimMid) return claimMid;
  }
  const entries = txn.entries || [];
  const tracked = new Set(
    trackedCodes.length ? trackedCodes : ["1400", "2020"],
  );
  const primary = entries.find((e) => e.memberId && tracked.has(e.accountCode));
  if (primary?.memberId) return String(primary.memberId).trim();
  const any = entries.find((e) => e.memberId);
  return any?.memberId ? String(any.memberId).trim() : "";
}

function entriesForMemberAmounts(txn, memberId) {
  const tid = normMemberKey(memberId);
  const docType = String(txn.docType || "").trim().toLowerCase();
  const list = txn.entries || [];

  if (docType === "claim") {
    const claimMid = String(txn.claimMemberId || "").trim();
    if (claimMid && normMemberKey(claimMid) === tid) {
      const byClaim = list.filter(
        (e) => normMemberKey(e.memberId) === normMemberKey(claimMid),
      );
      return byClaim.length > 0 ? byClaim : list;
    }
  }

  return list.filter((e) => normMemberKey(e.memberId) === tid);
}

function flattenGlRow(txn, memberId) {
  const mid = String(memberId).trim();
  let debit = 0;
  let credit = 0;
  for (const e of entriesForMemberAmounts(txn, mid)) {
    const amt = Number(e.amount) || 0;
    if (e.dc === "D") debit += amt;
    if (e.dc === "C") credit += amt;
  }
  const docTypeNorm = String(txn.docType || "").trim().toLowerCase();
  let docTypeLabel =
    txn.ledgerDisplayDocType ||
    txn.displayLabel ||
    txn.docType ||
    "";
  if (docTypeNorm === "claim") {
    docTypeLabel = txn.displayLabel || "Online payment";
  }

  return {
    _id: txn._id,
    memberId: mid,
    docType: txn.docType,
    docTypeLabel,
    docNo: txn.docNo || "",
    date: txn.date,
    memo: txn.memo || "",
    reference: txn.reference || txn.docNo || "",
    debit,
    credit,
    createdAt: txn.createdAt,
    updatedAt: txn.updatedAt,
    ledgerPresentation: txn.ledgerPresentation || null,
    displayType: txn.displayType || null,
    approvalStatus: txn.approvalStatus || "Posted",
  };
}

function buildMemberFacingGlQuery({ memberId, docType, from, to }) {
  const q = { docType: { $ne: "Settlement" } };
  const date = {};
  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) date.$gte = fromDate;
  }
  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) date.$lte = toDate;
  }
  if (Object.keys(date).length) q.date = date;

  if (memberId) {
    const mid = String(memberId).trim();
    q.$or = [{ "entries.memberId": mid }, { claimMemberId: mid }];
  } else {
    q.$or = [
      { "entries.memberId": { $exists: true, $nin: [null, ""] } },
      { claimMemberId: { $exists: true, $nin: [null, ""] } },
    ];
  }

  if (docType) q.docType = docType;
  return q;
}

async function fetchAllMemberFacingGl(q, maxDocuments) {
  const cap = Math.min(Math.max(maxDocuments, 1), DEFAULT_MAX_GL_DOCUMENTS);
  const rawItems = [];
  let skip = 0;
  while (rawItems.length < cap) {
    const batch = await GL.find(q)
      .sort({ createdAt: -1, date: -1 })
      .skip(skip)
      .limit(FETCH_PAGE_SIZE)
      .lean();
    if (!batch.length) break;
    rawItems.push(...batch);
    skip += batch.length;
    if (batch.length < FETCH_PAGE_SIZE) break;
  }
  const totalGlDocuments = await GL.countDocuments(q);
  return {
    rawItems,
    totalGlDocuments,
    truncated: rawItems.length < totalGlDocuments,
  };
}

async function appendDraftCreditNoteRows(rows, { memberId, includeDrafts }) {
  if (!includeDrafts) return rows;
  const limit = 1000;
  const { items } = await listCreditNotes({
    memberId: memberId || undefined,
    status: "Draft",
    limit,
    skip: 0,
  });
  for (const cn of items) {
    const mid = String(cn.memberId || "").trim();
    if (!mid) continue;
    const amt = Number(cn.amount) || 0;
    rows.push({
      _id: `draft-cn-${cn.docNo}`,
      memberId: mid,
      docType: "CreditNote",
      docTypeLabel: "Credit Note",
      docNo: cn.docNo || "",
      date: cn.effectiveDate || cn.createdAt,
      memo: cn.reason || cn.notes || "",
      reference: cn.invoiceDocNo || cn.docNo || "",
      debit: 0,
      credit: amt,
      createdAt: cn.createdAt,
      updatedAt: cn.updatedAt,
      approvalStatus: "Draft",
    });
  }
  return rows;
}

/**
 * Build organisation-wide general ledger rows (all members, member-facing GL).
 */
export async function buildGeneralLedgerList({
  memberId = "",
  docType = "",
  from,
  to,
  tenantId,
  maxDocuments = DEFAULT_MAX_GL_DOCUMENTS,
  includeDrafts = true,
}) {
  const q = buildMemberFacingGlQuery({ memberId, docType, from, to });
  const { rawItems, totalGlDocuments, truncated } = await fetchAllMemberFacingGl(
    q,
    maxDocuments,
  );

  const consolidated = consolidateCategoryChanges(rawItems);
  const trackedCodes = await getMemberTrackedAccountCodes();

  const byMember = new Map();
  for (const txn of consolidated) {
    const mid = resolveGlTxnMemberId(txn, trackedCodes);
    if (!mid) continue;
    if (!byMember.has(mid)) byMember.set(mid, []);
    byMember.get(mid).push(txn);
  }

  const rowGroups = await Promise.all(
    [...byMember.entries()].map(async ([mid, items]) => {
      let withPi = items;
      if (tenantId) {
        withPi = await attachPaymentIntentIdsToLedgerItems(items, tenantId);
      }
      const withClaim = attachClaimLedgerReference(withPi);
      const withTx = await attachTxTypesToLedgerItems(withClaim);
      const simplified = simplifyMemberLedgerPresentations(withTx, mid);
      return simplified.map((txn) => flattenGlRow(txn, mid));
    }),
  );

  let items = rowGroups
    .flat()
    .filter((row) => Math.abs(row.debit) > 0 || Math.abs(row.credit) > 0);

  items = await appendDraftCreditNoteRows(items, {
    memberId,
    includeDrafts,
  });

  items.sort((a, b) => {
    const ta = new Date(a.createdAt || a.date || 0).getTime();
    const tb = new Date(b.createdAt || b.date || 0).getTime();
    return tb - ta;
  });

  return {
    items,
    totalGlDocuments,
    totalRows: items.length,
    truncated,
    maxDocuments,
  };
}
