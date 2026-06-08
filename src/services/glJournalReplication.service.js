import GL from "../models/glTransaction.model.js";
import { AppError } from "../errors/AppError.js";

const REPLICATED_ACCOUNTS = new Set(["1400", "2020"]);

function toJournalDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function flattenGlDocument(txn, tenantId, eventIdPrefix) {
  const docNo = String(txn.docNo || "").trim();
  if (!docNo) return [];

  const journalDate = toJournalDate(txn.date);
  if (!journalDate) return [];

  const postedAt = txn.createdAt || txn.date || new Date();
  const settlementStatus = txn.settlement?.status || null;
  const entries = Array.isArray(txn.entries) ? txn.entries : [];

  const lines = [];
  entries.forEach((entry, lineIndex) => {
    const accountCode = String(entry.accountCode || "").trim();
    if (!REPLICATED_ACCOUNTS.has(accountCode)) return;

    const memberId = String(entry.memberId || txn.claimMemberId || "").trim();
    if (!memberId) return;

    const dc = entry.dc === "C" ? "C" : "D";
    const amountCents = Math.max(0, Math.floor(Number(entry.amount) || 0));
    if (amountCents <= 0) return;

    lines.push({
      event_id: `${eventIdPrefix}-${docNo}-${lineIndex}`,
      tenant_id: tenantId,
      journal_id: txn._id ? String(txn._id) : null,
      doc_no: docNo,
      doc_type: txn.docType ? String(txn.docType) : null,
      journal_date: journalDate,
      member_id: memberId,
      account_code: accountCode,
      dc,
      amount_cents: amountCents,
      line_index: lineIndex,
      reference: txn.reference ? String(txn.reference) : null,
      settlement_status: settlementStatus,
      posted_at: postedAt,
    });
  });

  return lines;
}

/**
 * Internal replication feed for reporting_db backfill (member AR 1400 / POA 2020 lines).
 * POST /api/reports/gl-journal-replication
 */
export async function glJournalReplicationFeed(req, res, next) {
  try {
    const tenantId = req.tenantId || req.ctx?.tenantId;
    if (!tenantId) {
      throw AppError.badRequest("Tenant context required");
    }

    const limit = Math.min(Math.max(Number(req.body?.limit) || 200, 1), 500);
    const cursor = req.body?.cursor ? String(req.body.cursor).trim() : null;

    const query = {
      "entries.accountCode": { $in: ["1400", "2020"] },
      "entries.memberId": { $exists: true, $ne: null },
    };
    if (cursor) {
      query._id = { $gt: cursor };
    }

    const docs = await GL.find(query)
      .sort({ _id: 1 })
      .limit(limit)
      .lean();

    const eventIdPrefix = `backfill-${tenantId}`;
    const lines = docs.flatMap((doc) =>
      flattenGlDocument(doc, String(tenantId), eventIdPrefix),
    );

    const nextCursor =
      docs.length === limit ? String(docs[docs.length - 1]._id) : null;

    res.success({
      lines,
      nextCursor,
      count: lines.length,
      documentCount: docs.length,
    });
  } catch (e) {
    next(e);
  }
}
