import logger from "../config/logger.js";

const BULK_MAX_PROFILE_IDS = 5000;
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Forward gateway/JWT trust bundle (same as batch.membershipStatus.service).
 *
 * Background workers pass a `req`-shaped object built from `captureForwardHeaders`
 * (snapshot of the live request) so this works the same for live HTTP and
 * post-response workers.
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

/**
 * Snapshot the headers we need from a live request so a background worker can
 * reuse them after the HTTP response has been sent.
 */
export function captureForwardHeaders(req) {
  const snapshot = { headers: {}, tenantId: null, correlationId: null };
  if (!req) return snapshot;
  const h = req.headers || {};
  const keep = [
    "authorization",
    "x-ms-token-aad-access-token",
    "x-tenant-id",
    "x-jwt-verified",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
    "x-token-expires-at",
    "x-correlation-id",
  ];
  for (const key of keep) {
    const v = h[key];
    if (v != null && v !== "") {
      snapshot.headers[key] = Array.isArray(v) ? v[0] : v;
    }
  }
  snapshot.tenantId = req.tenantId || req.ctx?.tenantId || h["x-tenant-id"] || null;
  snapshot.correlationId =
    req.correlationId || h["x-correlation-id"] || null;
  return snapshot;
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
      throw new Error(`Upstream ${res.status}: ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function unwrapData(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.data)) return payload.data.data;
    if (Array.isArray(payload.data.items)) return payload.data.items;
    if (Array.isArray(payload.data.mandates)) return payload.data.mandates;
    return payload.data;
  }
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.mandates)) return payload.mandates;
  return payload;
}

function profileServiceBase() {
  const base = (process.env.PROFILE_SERVICE_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("PROFILE_SERVICE_URL is required for direct debit prepare");
  }
  return base;
}

/** Build profile-service API URL whether PROFILE_SERVICE_URL ends with /api or not. */
function profileApiUrl(path) {
  const base = profileServiceBase();
  const segment = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/api")) {
    return `${base}${segment}`;
  }
  return `${base}/api${segment}`;
}

function parseMandateRows(payload) {
  const rows = unwrapData(payload);
  if (Array.isArray(rows?.mandates)) return rows.mandates;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Current Active Direct Debit subscriptions from subscription-service.
 */
export async function fetchDirectDebitSubscriptions(req) {
  const base = (process.env.SUBSCRIPTION_SERVICE_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "SUBSCRIPTION_SERVICE_URL is required for direct debit prepare",
    );
  }
  const q = new URLSearchParams({
    isCurrent: "true",
    subscriptionStatus: "Active",
    paymentType: "Direct Debit",
  });
  const url = `${base}/api/v1/subscriptions?${q.toString()}`;
  const payload = await fetchJson(url, req);
  const rows = unwrapData(payload);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Active authorized DD mandates with decrypted bank fields from profile-service CRM API.
 */
export async function fetchDirectDebitMandates(req, profileIds = []) {
  const ids = [...new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean))].slice(
    0,
    BULK_MAX_PROFILE_IDS,
  );
  const body = JSON.stringify({ profileIds: ids });

  const primaryUrl = profileApiUrl(
    "/payment-forms/direct-debit/mandates-for-prepare",
  );
  const fallbackUrl = profileApiUrl("/payment-forms/filter");

  let lastError = null;

  try {
    const payload = await fetchJson(primaryUrl, req, {
      method: "POST",
      body,
    });
    return parseMandateRows(payload);
  } catch (err) {
    lastError = err;
    const is404 =
      err?.message?.includes("404") || err?.message?.includes("Not found");
    if (!is404) throw err;
    logger.warn(
      { primaryUrl, err: err.message },
      "[DirectDebit] mandates-for-prepare not found; trying filter fallback",
    );
  }

  try {
    const payload = await fetchJson(fallbackUrl, req, {
      method: "PUT",
      body: JSON.stringify({
        purpose: "direct-debit-prepare",
        profileIds: ids,
      }),
    });
    return parseMandateRows(payload);
  } catch (err) {
    const hint =
      "Ensure profile-service is deployed with POST /api/payment-forms/direct-debit/mandates-for-prepare " +
      "or PUT /api/payment-forms/filter (purpose: direct-debit-prepare).";
    throw new Error(
      `${err.message || lastError?.message || "Profile mandate fetch failed"}. ${hint}`,
    );
  }
}

export async function loadDirectDebitEligibilitySource(req) {
  const subs = await fetchDirectDebitSubscriptions(req);
  const profileIds = subs
    .map((s) => s.profileId || s.profile?._id)
    .filter(Boolean);
  let mandates = [];
  try {
    mandates = await fetchDirectDebitMandates(req, profileIds);
  } catch (err) {
    logger.warn(
      { err: err.message, profileCount: profileIds.length },
      "[DirectDebit] profile-service mandate fetch failed",
    );
    throw err;
  }
  const mandateByProfile = new Map(
    mandates.map((m) => [String(m.profileId), m]),
  );
  return { subs, mandateByProfile };
}
