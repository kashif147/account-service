import mongoose from "mongoose";
import {
  connectSubscriptionDB,
  getSubscriptionConnection,
} from "../config/subscriptionDb.js";
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
 * (isCurrent, else latest by startDate) — see subscription-service subscription.model.
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
 * Builds a map profileId -> subscriptionStatus (subscription collection field).
 */
async function loadSubscriptionStatusByProfileId(batch) {
  const map = new Map();
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
    return map;
  }

  const oids = [...profileIds].map((id) => new mongoose.Types.ObjectId(id));
  const baseQuery = {
    profileId: { $in: oids },
    deleted: { $ne: true },
  };

  let Sub;
  try {
    Sub = getSubscriptionReadModel();
  } catch (e) {
    logger.debug(
      { err: e.message },
      "[BatchDetail] subscription read model unavailable",
    );
    return map;
  }

  const runFind = (query) =>
    Sub.find(query)
      .select("profileId isCurrent subscriptionStatus startDate createdAt")
      .lean();

  let query = { ...baseQuery };
  if (batch.tenantId) {
    query.tenantId = batch.tenantId;
  }
  let subs = await runFind(query);

  if (subs.length === 0 && batch.tenantId) {
    logger.warn(
      { batchId: String(batch._id), tenantId: batch.tenantId },
      "[BatchDetail] 0 subscription rows for batch tenant; retrying without tenant filter",
    );
    subs = await runFind(baseQuery);
  }

  const byProfile = new Map();
  for (const s of subs) {
    const k = s.profileId?.toString();
    if (!k) continue;
    if (!byProfile.has(k)) byProfile.set(k, []);
    byProfile.get(k).push(s);
  }

  for (const [pid, rows] of byProfile) {
    const sub = pickSubscriptionForProfile(rows);
    const st = sub?.subscriptionStatus ?? null;
    if (st != null) {
      map.set(pid, st);
    }
  }
  return map;
}

/**
 * Adds per-row:
 * - `subscriptionStatus` — copied from subscription-service `subscription` documents'
 *   `subscriptionStatus` (see subscription.model.js).
 * - `membershipStatus` — same value (alias for UIs that already use this name).
 * Always sets these keys (null when unknown or DB unavailable).
 */
function attachStatusFields(batch, statusByProfile) {
  const attach = (row) => {
    const pid = profileIdString(row);
    const subscriptionStatus = pid
      ? statusByProfile.get(pid) ?? null
      : null;
    return {
      ...row,
      subscriptionStatus,
      membershipStatus: subscriptionStatus,
    };
  };
  return {
    ...batch,
    batchPayments: (batch.batchPayments || []).map(attach),
    batchExceptions: (batch.batchExceptions || []).map(attach),
  };
}

export async function enrichBatchDetailWithMembershipStatus(batch) {
  if (!batch) {
    return batch;
  }

  await connectSubscriptionDB().catch((e) => {
    logger.warn(
      { err: e.message },
      "[BatchDetail] subscription Mongo connect failed; subscriptionStatus will be null. Set SUBSCRIPTION_MONGODB_URI to the same URI as subscription-service MONGO_URI.",
    );
  });

  const conn = getSubscriptionConnection();
  if (!conn || conn.readyState !== 1) {
    logger.warn(
      "[BatchDetail] subscription DB not connected; batch rows will have subscriptionStatus: null. Configure SUBSCRIPTION_MONGODB_URI on account-service.",
    );
    return attachStatusFields(batch, new Map());
  }

  let statusByProfile;
  try {
    statusByProfile = await loadSubscriptionStatusByProfileId(batch);
  } catch (err) {
    logger.warn(
      { err: err.message, batchId: batch._id },
      "[BatchDetail] subscription lookup failed",
    );
    statusByProfile = new Map();
  }

  return attachStatusFields(batch, statusByProfile);
}
