import mongoose from "mongoose";
import logger from "../config/logger.js";

/** One HTTP POST can include up to this many profileIds (must stay ≤ subscription-service max, default 2000). */
const SERVER_MAX_PROFILE_IDS = 2000;
const DEFAULT_CHUNK_SIZE = 500;

function chunkSize() {
  const n = parseInt(
    process.env.BATCH_SUBSCRIPTION_STATUS_CHUNK_SIZE || String(DEFAULT_CHUNK_SIZE),
    10,
  );
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CHUNK_SIZE;
  return Math.min(n, SERVER_MAX_PROFILE_IDS);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

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
 * Forwards the same trust bundle as other account-service → subscription-service calls
 * (see stripe.payment.enrichment.service buildForwardHeaders).
 */
function buildForwardHeaders(req) {
  if (!req?.headers) {
    return { Accept: "application/json", "Content-Type": "application/json" };
  }
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth) {
    headers.Authorization = auth;
  } else {
    const aad = req.headers["x-ms-token-aad-access-token"];
    if (aad) headers.Authorization = `Bearer ${aad}`;
  }
  const tenantId =
    req.tenantId || req.ctx?.tenantId || req.headers["x-tenant-id"];
  if (tenantId) {
    headers["x-tenant-id"] = String(
      Array.isArray(tenantId) ? tenantId[0] : tenantId,
    );
  }
  for (const key of [
    "x-jwt-verified",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
    "x-token-expires-at",
  ]) {
    const v = req.headers[key];
    if (v != null && v !== "") {
      headers[key] = Array.isArray(v) ? v[0] : v;
    }
  }
  return headers;
}

function parseBatchStatusPayload(json) {
  if (!json || typeof json !== "object") return [];
  const inner = json.data;
  if (inner && Array.isArray(inner.data)) {
    return inner.data;
  }
  if (Array.isArray(inner)) {
    return inner;
  }
  return [];
}

/**
 * One bulk POST to subscription-service (never one request per member row).
 */
async function postBatchSubscriptionStatusChunk(profileIds, req, baseUrl) {
  const map = new Map();
  if (!profileIds.length) {
    return map;
  }
  const url = `${baseUrl}/api/v1/subscriptions/batch-subscription-status`;
  const controller = new AbortController();
  const timeoutMs = Math.min(
    120000,
    Math.max(15000, profileIds.length * 40 + 10000),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildForwardHeaders(req),
      body: JSON.stringify({ profileIds }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      logger.warn(
        { status: res.status, detail: String(text).slice(0, 500), n: profileIds.length },
        "[BatchDetail] batch-subscription-status chunk failed",
      );
      return map;
    }
    for (const row of parseBatchStatusPayload(body)) {
      if (row?.profileId != null) {
        map.set(
          String(row.profileId),
          row.subscriptionStatus ?? null,
        );
      }
    }
    return map;
  } catch (e) {
    logger.warn(
      { err: e.message, n: profileIds.length },
      "[BatchDetail] batch-subscription-status chunk request error",
    );
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * All unique profileIds in a small number of bulk POSTs (chunked), merged into one map.
 * Chunks run sequentially to limit concurrent calls and reduce 429 risk.
 */
async function fetchSubscriptionStatusByProfileId(profileIds, req) {
  const merged = new Map();
  if (!profileIds.length) {
    return merged;
  }
  const base = (process.env.SUBSCRIPTION_SERVICE_URL || "").replace(/\/$/, "");
  if (!base) {
    logger.warn(
      "[BatchDetail] SUBSCRIPTION_SERVICE_URL not set; subscriptionStatus will be null",
    );
    return merged;
  }

  const size = chunkSize();
  const chunks = chunkArray(profileIds, size);
  for (let i = 0; i < chunks.length; i += 1) {
    const part = await postBatchSubscriptionStatusChunk(
      chunks[i],
      req,
      base,
    );
    for (const [k, v] of part) {
      merged.set(k, v);
    }
  }
  return merged;
}

/**
 * Sets per row:
 * - `subscriptionStatus` from subscription-service `POST .../batch-subscription-status` (subscription model field)
 * - `membershipStatus` same value
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

/**
 * @param {object} batch - batch detail document (lean)
 * @param {import("express").Request|null} req - needed to forward auth to subscription-service
 */
export async function enrichBatchDetailWithMembershipStatus(batch, req) {
  if (!batch) {
    return batch;
  }
  if (!req) {
    logger.warn(
      "[BatchDetail] enrichBatchDetailWithMembershipStatus called without req",
    );
    return attachStatusFields(batch, new Map());
  }

  const idSet = new Set();
  for (const row of batch.batchPayments || []) {
    const id = profileIdString(row);
    if (id && mongoose.Types.ObjectId.isValid(id)) idSet.add(id);
  }
  for (const row of batch.batchExceptions || []) {
    const id = profileIdString(row);
    if (id && mongoose.Types.ObjectId.isValid(id)) idSet.add(id);
  }
  const profileIds = [...idSet];
  const statusByProfile = await fetchSubscriptionStatusByProfileId(
    profileIds,
    req,
  );
  return attachStatusFields(batch, statusByProfile);
}
