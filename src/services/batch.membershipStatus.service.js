import mongoose from "mongoose";
import { getSubscriptionConnection } from "../config/subscriptionDb.js";
import { getSubscriptionReadModel } from "../models/subscriptionRead.model.js";
import logger from "../config/logger.js";

function profileIdString(row) {
  const p = row.profileId;
  if (p == null) return null;
  if (typeof p === "object" && p._id != null) {
    return p._id.toString();
  }
  if (p instanceof mongoose.Types.ObjectId) {
    return p.toString();
  }
  if (typeof p === "string" && mongoose.Types.ObjectId.isValid(p)) {
    return p;
  }
  return String(p);
}

/**
 * Picks the subscription document that best represents "current" membership
 * (same idea as profile-service subscription client: isCurrent, else latest by date).
 */
function pickSubscriptionForProfile(rows) {
  if (!rows?.length) return null;
  const current = rows.find((r) => r.isCurrent === true);
  if (current) return current;
  const sorted = [...rows].sort((a, b) => {
    const ad = new Date(a.startDate || a.createdAt || 0).getTime();
    const bd = new Date(b.startDate || b.createdAt || 0).getTime();
    return bd - ad;
  });
  return sorted[0] || null;
}

/**
 * Adds `membershipStatus` (subscription subscriptionStatus value, e.g. Active, Resigned)
 * to each batchPayments / batchExceptions row with a resolvable profileId.
 */
export async function enrichBatchDetailWithMembershipStatus(batch) {
  if (!batch) {
    return batch;
  }
  const conn = getSubscriptionConnection();
  if (!conn || conn.readyState !== 1) {
    return batch;
  }

  let Sub;
  try {
    Sub = getSubscriptionReadModel();
  } catch (e) {
    logger.debug(
      { err: e.message },
      "[BatchDetail] subscription model unavailable",
    );
    return batch;
  }

  const profileIds = new Set();
  for (const row of batch.batchPayments || []) {
    const id = profileIdString(row);
    if (id && mongoose.Types.ObjectId.isValid(id)) profileIds.add(id);
  }
  for (const row of batch.batchExceptions || []) {
    const id = profileIdString(row);
    if (id && mongoose.Types.ObjectId.isValid(id)) profileIds.add(id);
  }

  if (profileIds.size === 0) {
    return batch;
  }

  const oids = [...profileIds].map((id) => new mongoose.Types.ObjectId(id));
  const query = {
    profileId: { $in: oids },
    deleted: { $ne: true },
  };
  if (batch.tenantId) {
    query.tenantId = batch.tenantId;
  }

  let subs = [];
  try {
    subs = await Sub.find(query)
      .select("profileId isCurrent subscriptionStatus startDate createdAt")
      .lean();
  } catch (err) {
    logger.warn(
      { err: err.message, batchId: batch._id },
      "[BatchDetail] subscription lookup failed",
    );
    return batch;
  }

  const byProfile = new Map();
  for (const s of subs) {
    const k = s.profileId?.toString();
    if (!k) continue;
    if (!byProfile.has(k)) byProfile.set(k, []);
    byProfile.get(k).push(s);
  }

  const statusByProfile = new Map();
  for (const [pid, rows] of byProfile) {
    const sub = pickSubscriptionForProfile(rows);
    const st = sub?.subscriptionStatus ?? null;
    if (st != null) statusByProfile.set(pid, st);
  }

  const attach = (row) => {
    const pid = profileIdString(row);
    const membershipStatus = pid
      ? statusByProfile.get(pid) ?? null
      : null;
    return { ...row, membershipStatus };
  };

  return {
    ...batch,
    batchPayments: (batch.batchPayments || []).map(attach),
    batchExceptions: (batch.batchExceptions || []).map(attach),
  };
}
