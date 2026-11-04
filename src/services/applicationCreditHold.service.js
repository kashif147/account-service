// P5 application credit hold (owner policy, see models/applicationCreditHold.model.js).
//
// When an application is approved onto an EXISTING profile and its 2020 application credit has
// not been transferred by CLAIM-<applicationId> (subscription-service publishes no
// members.subscription.current.updated.v1 when the profile already has a live subscription, so
// the claim never runs), the credit is HELD for finance. This module only records / releases /
// lists that marker; it never posts a journal, an invoice, a claim or a refund.
import GLTransaction from "../models/glTransaction.model.js";
import ApplicationCreditHold, {
  HOLD_REASON,
  HOLD_STATUS,
} from "../models/applicationCreditHold.model.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import { AppError } from "../errors/AppError.js";
import logger from "../config/logger.js";

function norm(v) {
  return v == null ? "" : String(v).trim();
}

export function claimDocNoFor(applicationId) {
  return `CLAIM-${norm(applicationId)}`;
}

/** Real membership number (not the `profile:` placeholder, not empty). */
export function isRealMemberId(memberId) {
  const m = norm(memberId);
  return m !== "" && !m.startsWith("profile:");
}

async function claimExists(tenantId, applicationId) {
  const row = await GLTransaction.findOne({ tenantId, docNo: claimDocNoFor(applicationId) })
    .select({ _id: 1 })
    .lean();
  return !!row;
}

/**
 * Net 2020 credit (integer cents, C - D) still keyed by the application: entries.applicationId
 * (current format) or entries.memberId "app:<id>" (legacy). A posted CLAIM debits this key, so
 * after a claim it is 0.
 */
export async function unallocatedApplicationCreditCents(tenantId, applicationId) {
  const tid = requireTenantId(tenantId);
  const app = norm(applicationId);
  if (!app) return 0;
  const key = { $or: [{ "entries.applicationId": app }, { "entries.memberId": `app:${app}` }] };
  const rows = await GLTransaction.aggregate([
    { $match: { tenantId: tid, ...key } },
    { $unwind: "$entries" },
    { $match: { ...key, "entries.accountCode": "2020" } },
    {
      $group: {
        _id: null,
        net: {
          $sum: {
            $cond: [{ $eq: ["$entries.dc", "C"] }, "$entries.amount", { $multiply: ["$entries.amount", -1] }],
          },
        },
      },
    },
  ]);
  return Math.max(0, Number(rows[0]?.net) || 0);
}

/**
 * Release a pending hold once CLAIM-<applicationId> exists (the normal subscription flow
 * allocated the credit). Only a pending hold changes; idempotent.
 */
export async function releaseApplicationCreditHoldOnClaim({ tenantId, applicationId }) {
  const tid = requireTenantId(tenantId);
  const app = norm(applicationId);
  if (!app) return { released: false };
  const res = await ApplicationCreditHold.updateOne(
    { tenantId: tid, applicationId: app, status: HOLD_STATUS.PENDING },
    {
      $set: {
        status: HOLD_STATUS.RELEASED_BY_CLAIM,
        releasedAt: new Date(),
        releasedClaimDocNo: claimDocNoFor(app),
      },
    },
  );
  const released = (res?.modifiedCount || 0) > 0;
  if (released) {
    logger.info({ tenantId: tid, applicationId: app }, "Application credit hold released by CLAIM");
  }
  return { released };
}

/**
 * Record "application credit pending finance review" for an existing-profile approval whose
 * application credit is still unallocated. No journal, no invoice, no transfer.
 * Idempotent per (tenantId, applicationId): a redelivery never creates a second row or
 * changes an existing one.
 *
 * @returns {Promise<{ recorded: boolean, reason: string, amountCents?: number }>}
 */
export async function recordApplicationCreditHoldIfUnallocated({
  tenantId,
  applicationId,
  memberId,
  profileId,
  sourceEventId,
  correlationId,
}) {
  const tid = requireTenantId(tenantId);
  const app = norm(applicationId);
  if (!app || !isRealMemberId(memberId)) return { recorded: false, reason: "missing_ids" };

  if (await claimExists(tid, app)) return { recorded: false, reason: "already_claimed" };

  const amountCents = await unallocatedApplicationCreditCents(tid, app);
  if (amountCents <= 0) return { recorded: false, reason: "no_application_credit" };

  let inserted = false;
  try {
    const res = await ApplicationCreditHold.updateOne(
      { tenantId: tid, applicationId: app },
      {
        $setOnInsert: {
          memberId: norm(memberId),
          profileId: norm(profileId) || undefined,
          status: HOLD_STATUS.PENDING,
          reasonCode: HOLD_REASON.EXISTING_PROFILE_UNALLOCATED,
          amountCentsAtDetection: amountCents,
          detectedAt: new Date(),
          sourceEventId: norm(sourceEventId) || undefined,
          correlationId: norm(correlationId) || undefined,
        },
      },
      { upsert: true },
    );
    inserted = (res?.upsertedCount || 0) > 0;
  } catch (err) {
    if (err?.code !== 11000) throw err; // concurrent redelivery: the other insert won
  }
  if (!inserted) return { recorded: false, reason: "already_recorded" };

  // A CLAIM posted concurrently (the subscription flow for a returning member) between the
  // check above and the insert: release so the marker never contradicts the ledger.
  if (await claimExists(tid, app)) {
    await releaseApplicationCreditHoldOnClaim({ tenantId: tid, applicationId: app });
    return { recorded: true, reason: "released_by_concurrent_claim", amountCents };
  }

  logger.warn(
    {
      tenantId: tid,
      applicationId: app,
      memberId: norm(memberId),
      amountCents,
      reasonCode: HOLD_REASON.EXISTING_PROFILE_UNALLOCATED,
    },
    "Application credit held pending finance review (existing-profile approval, no CLAIM)",
  );
  return { recorded: true, reason: "pending_finance_review", amountCents };
}

/** Finance listing (tenant-scoped). Adds the live unallocated amount per row. */
export async function listApplicationCreditHolds({ tenantId, status, limit = 50, skip = 0 }) {
  const tid = requireTenantId(tenantId);
  const filter = { tenantId: tid };
  if (status != null && status !== "") {
    if (!Object.values(HOLD_STATUS).includes(status)) {
      throw AppError.badRequest("Unknown hold status", { status });
    }
    filter.status = status;
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const sk = Math.max(parseInt(skip, 10) || 0, 0);
  const [rows, total] = await Promise.all([
    ApplicationCreditHold.find(filter).sort({ detectedAt: -1 }).skip(sk).limit(lim).lean(),
    ApplicationCreditHold.countDocuments(filter),
  ]);
  const items = [];
  for (const r of rows) {
    items.push({
      id: String(r._id),
      applicationId: r.applicationId,
      memberId: r.memberId || null,
      profileId: r.profileId || null,
      status: r.status,
      reasonCode: r.reasonCode,
      amountCentsAtDetection: r.amountCentsAtDetection,
      currentUnallocatedCents:
        r.status === HOLD_STATUS.PENDING
          ? await unallocatedApplicationCreditCents(tid, r.applicationId)
          : 0,
      detectedAt: r.detectedAt,
      releasedAt: r.releasedAt || null,
      releasedClaimDocNo: r.releasedClaimDocNo || null,
    });
  }
  return { items, total, limit: lim, skip: sk };
}

/** True when a pending hold exists (for refund classification - see #38 integration note). */
export async function hasPendingApplicationCreditHold(tenantId, applicationId) {
  const tid = requireTenantId(tenantId);
  const app = norm(applicationId);
  if (!app) return false;
  const row = await ApplicationCreditHold.findOne({
    tenantId: tid,
    applicationId: app,
    status: HOLD_STATUS.PENDING,
  })
    .select({ _id: 1 })
    .lean();
  return !!row;
}
