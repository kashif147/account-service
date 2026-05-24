import logger from "../config/logger.js";

const BULK_MAX = 5000;
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Forward gateway/JWT trust bundle (same as directDebitUpstream.client).
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
  const cid = req.correlationId || req.headers["x-correlation-id"];
  if (cid) {
    headers["x-correlation-id"] = String(Array.isArray(cid) ? cid[0] : cid);
  }
  return headers;
}

async function fetchJson(url, req, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: { ...buildForwardHeaders(req), ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg =
        json?.message ||
        json?.data?.message ||
        json?.error?.message ||
        text?.slice(0, 300) ||
        res.statusText;
      throw new Error(`Profile upstream ${res.status}: ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function profileBase() {
  const base = (process.env.PROFILE_SERVICE_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("PROFILE_SERVICE_URL is required for profile lookups");
  }
  return base;
}

function unwrapProfiles(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

export async function fetchProfilesByMembershipNumbers(req, membershipNumbers) {
  const nums = [
    ...new Set(
      (membershipNumbers || [])
        .map((n) => String(n).trim())
        .filter(Boolean),
    ),
  ].slice(0, BULK_MAX);
  if (!nums.length) return [];

  const url = `${profileBase()}/api/profile/lookup-by-membership`;
  const payload = await fetchJson(url, req, {
    method: "POST",
    body: JSON.stringify({ membershipNumbers: nums }),
  });
  return unwrapProfiles(payload);
}

export async function findProfileByMembershipNumber(
  req,
  membershipNumberTrimmed,
) {
  const url = `${profileBase()}/api/profile/lookup-by-membership`;
  const payload = await fetchJson(url, req, {
    method: "POST",
    body: JSON.stringify({
      membershipNumbers: [membershipNumberTrimmed],
      diagnose: true,
    }),
  });
  const profiles = unwrapProfiles(payload);
  if (profiles.length > 0) {
    return { profile: profiles[0], lookupError: null };
  }
  return {
    profile: null,
    lookupError:
      payload?.lookupError ||
      "No profile found with this membership number. Confirm the member exists in profile-service and the number matches exactly.",
  };
}

export async function fetchProfilesByIds(req, profileIds) {
  const ids = [
    ...new Set(
      (profileIds || []).map((id) => String(id).trim()).filter(Boolean),
    ),
  ].slice(0, BULK_MAX);
  if (!ids.length) return [];

  const url = `${profileBase()}/api/profile/batch-lookup`;
  const payload = await fetchJson(url, req, {
    method: "POST",
    body: JSON.stringify({ profileIds: ids }),
  });
  return unwrapProfiles(payload);
}

/**
 * Attach profile documents to batchPayments.profileId (replaces cross-DB populate).
 */
export async function enrichBatchDetailWithProfiles(batch, req) {
  if (!batch) return batch;
  const profileIds = new Set();
  for (const p of batch.batchPayments || []) {
    const id = p?.profileId;
    if (id && typeof id === "object" && id._id) continue;
    if (id) profileIds.add(String(id));
  }
  if (!profileIds.size) return batch;

  try {
    const profiles = await fetchProfilesByIds(req, [...profileIds]);
    const byId = new Map(profiles.map((p) => [String(p._id), p]));
    const enrichPayments = (payments) =>
      (payments || []).map((p) => {
        const rawId = p?.profileId;
        const idStr =
          rawId && typeof rawId === "object" && rawId._id
            ? String(rawId._id)
            : rawId
              ? String(rawId)
              : null;
        if (!idStr) return p;
        const doc = byId.get(idStr);
        return doc ? { ...p, profileId: doc } : p;
      });

    return {
      ...batch,
      batchPayments: enrichPayments(batch.batchPayments),
    };
  } catch (err) {
    logger.warn(
      { err: err.message, profileCount: profileIds.size },
      "[ProfileUpstream] batch profile enrichment failed",
    );
    return batch;
  }
}
