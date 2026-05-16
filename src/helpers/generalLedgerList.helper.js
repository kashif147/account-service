import GL from "../models/glTransaction.model.js";
import CoA from "../models/coa.model.js";
import { simplifyMemberLedgerPresentations } from "./memberLedgerPresentation.js";
import { attachPaymentIntentIdsToLedgerItems } from "./memberLedgerPaymentIntent.js";
import { attachTxTypesToLedgerItems } from "./glTransactionTxType.js";
import { listCreditNotes } from "../services/creditNote.service.js";
import { isApplicationCreditClaimReceipt } from "./memberLastPayment.js";
import {
  buildMemberFacingGlQuery,
  createMemberIdentityResolver,
  entryBelongsToMember,
  normMemberKey,
} from "./memberIdentityResolver.js";

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

/** Member this GL row belongs to (claims, profile:/app: keys, applicationId). */
export function resolveGlTxnMemberId(txn, trackedCodes = [], resolver = null) {
  const docType = String(txn.docType || "").trim().toLowerCase();
  if (docType === "claim") {
    const raw = String(txn.claimMemberId || "").trim();
    const claimMid = resolver ? resolver.resolveMemberId(raw) : raw;
    if (claimMid) return claimMid;
  }

  const entries = txn.entries || [];
  const tracked = new Set(
    trackedCodes.length ? trackedCodes : ["1400", "2020"],
  );

  const resolveRaw = (raw) => {
    if (!raw) return "";
    return resolver ? resolver.resolveMemberId(raw) : String(raw).trim();
  };

  for (const e of entries) {
    if (e.memberId && tracked.has(e.accountCode)) {
      const mid = resolveRaw(e.memberId);
      if (mid) return mid;
    }
  }

  if (resolver) {
    for (const e of entries) {
      if (e.applicationId) {
        const mid = resolver.resolveApplicationId(e.applicationId);
        if (mid) return mid;
      }
    }
    if (txn.sourceApplicationId) {
      const mid = resolver.resolveApplicationId(txn.sourceApplicationId);
      if (mid) return mid;
    }
  }

  for (const e of entries) {
    if (e.memberId) {
      const mid = resolveRaw(e.memberId);
      if (mid) return mid;
    }
  }

  return "";
}

function entriesForMemberAmounts(txn, memberId, resolver) {
  const tid = normMemberKey(memberId);
  const docType = String(txn.docType || "").trim().toLowerCase();
  const list = txn.entries || [];

  if (docType === "claim") {
    const rawClaim = String(txn.claimMemberId || "").trim();
    const claimMid = resolver
      ? resolver.resolveMemberId(rawClaim)
      : rawClaim;
    if (claimMid && normMemberKey(claimMid) === tid) {
      const byClaim = list.filter((e) =>
        entryBelongsToMember(e, memberId, resolver),
      );
      return byClaim.length > 0 ? byClaim : list;
    }
  }

  if (resolver) {
    return list.filter((e) => entryBelongsToMember(e, memberId, resolver));
  }

  return list.filter((e) => normMemberKey(e.memberId) === tid);
}

function flattenGlRow(txn, memberId, resolver) {
  const mid = String(memberId).trim();
  let debit = 0;
  let credit = 0;
  for (const e of entriesForMemberAmounts(txn, mid, resolver)) {
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
  const filterMember = String(memberId || "").trim();
  const q = await buildMemberFacingGlQuery({ memberId: filterMember, docType, from, to });
  const { rawItems, totalGlDocuments, truncated } = await fetchAllMemberFacingGl(
    q,
    maxDocuments,
  );

  const consolidated = consolidateCategoryChanges(rawItems);
  const trackedCodes = await getMemberTrackedAccountCodes();
  const resolver = await createMemberIdentityResolver(consolidated, {
    seedMemberId: filterMember || undefined,
  });

  const byMember = new Map();
  for (const txn of consolidated) {
    const mid = resolveGlTxnMemberId(txn, trackedCodes, resolver);
    if (!mid) continue;
    if (
      filterMember &&
      normMemberKey(mid) !== normMemberKey(filterMember)
    ) {
      continue;
    }
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
      return simplified.map((txn) => flattenGlRow(txn, mid, resolver));
    }),
  );

  let items = rowGroups
    .flat()
    .filter((row) => Math.abs(row.debit) > 0 || Math.abs(row.credit) > 0);

  items = await appendDraftCreditNoteRows(items, {
    memberId: filterMember,
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
