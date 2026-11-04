// P5 application refund state - account-service client for profile-service's signed lookup
//   GET {PROFILE_SERVICE_URL}/api/internal/applications/:applicationId/refund-state
// installed as the refund policy's provider (payments.service.js setApplicationRefundStateProvider,
// wired in app.js). Flow A of a CRM refund (payment still on its application key, no member link
// or CLAIM transfer) needs the application's status from its owner, profile-service.
//
// Authority: ONLY a p5-svc-sig/1 signature made with account-service's own independent key
// (lib/profileRequestSigning.js; PROFILE_SIGNING_KID / PROFILE_SIGNING_SECRET). No CRM token,
// no gateway identity header and no x-internal-request is forwarded: CRM finance authorization was
// decided once, at the refund endpoint; profile-service applies no permission check. The tenant
// is the refund request's trusted tenant, sent as the SIGNED x-tenant-id.
//
// Result mapping (no money moves on any non-success; payments.service refuses under enforce):
//   200, body {data:{applicationId, tenantId, status}} matching the request, status one of
//     in-progress | submitted | processed | rejected      -> { applicationId, tenantId, status }
//   401 / 403 (signature rejected)                        -> { unverified, reason: "auth" }
//                                                            => 409 REFUND_APPLICATION_STATE_UNVERIFIED
//   404, 422, 200 with another id / tenant / unknown status -> { unverified, reason: "business" }
//                                                            => 409 REFUND_APPLICATION_STATE_UNVERIFIED
//   timeout (3 s), transport error, 5xx, any other status, unparseable 200 body, signer not
//   configured, PROFILE_SERVICE_URL unset, breaker open (5 s after a timeout / transport error)
//                                                          -> { unavailable, reason }
//                                                            => 503 REFUND_APPLICATION_STATE_UNAVAILABLE
// Logs carry status, outcome and reason only - never headers, signature, nonce or secret.
import logger from "../config/logger.js";
import { signatureHeaders, signingConfig } from "../lib/profileRequestSigning.js";

export const DEFAULT_TIMEOUT_MS = 3000;
// Fail-fast after an outage: a timeout or transport error opens a short breaker during which calls
// answer "unavailable" (reason circuit_open) without touching the network. The batched attempts
// lookup (payments.service lookupApplicationRefundStates: up to 200 ids, concurrency 5) is then
// bounded by ~one timeout (3 s) instead of 200 / 5 x 3 s. It only ever fails CLOSED.
export const BREAKER_OPEN_MS = 5000;
let breakerOpenUntil = 0;
export function resetRefundStateBreaker() {
  breakerOpenUntil = 0;
}
const STATUSES = new Set(["in-progress", "submitted", "processed", "rejected"]);
const APPLICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TENANT_RE = /^[a-f0-9]{24}$/;

function profileBase(env) {
  // Accept PROFILE_SERVICE_URL with or without a trailing /api (same as directDebitUpstream).
  return String(env.PROFILE_SERVICE_URL || "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
}

const unavailable = (reason, extra = {}) => ({ unavailable: true, reason, ...extra });
const unverified = (reason, extra = {}) => ({ unverified: true, reason, ...extra });

function logOutcome(log, result, fields) {
  try {
    const level = result.unavailable || result.unverified ? "warn" : "info";
    log[level]({ ...fields, outcome: result.unavailable ? "unavailable" : result.unverified ? "unverified" : "verified", reason: result.reason || null }, "Application refund-state lookup");
  } catch {
    /* logging never breaks the lookup */
  }
}

/**
 * @param {{ tenantId: string, applicationId: string }} args
 * @param {{ env?, fetchImpl?, timeoutMs?, now?, logger? }} deps
 */
export async function fetchApplicationRefundState({ tenantId, applicationId } = {}, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const log = deps.logger || logger;
  const appId = String(applicationId ?? "");
  const tenant = String(tenantId ?? "");
  const fields = { tenantId: tenant, applicationId: appId };
  const done = (result, extra = {}) => {
    logOutcome(log, result, { ...fields, ...extra });
    return result;
  };

  if (!APPLICATION_ID_RE.test(appId) || !TENANT_RE.test(tenant)) return done(unverified("business"), { cause: "invalid_identifier" });
  const base = profileBase(env);
  if (!base) return done(unavailable("not_configured"), { cause: "profile_url" });
  if (!signingConfig(env)) return done(unavailable("not_configured"), { cause: "signing_key" });

  const useBreaker = deps.breaker !== false;
  const nowMs = () => (deps.now ? deps.now() : Date.now());
  if (useBreaker && nowMs() < breakerOpenUntil) return done(unavailable("circuit_open"));

  const url = `${base}/api/internal/applications/${encodeURIComponent(appId)}/refund-state`;
  let headers;
  try {
    headers = signatureHeaders({ method: "GET", url, tenant, env, now: deps.now ? deps.now() : Date.now() });
  } catch {
    return done(unavailable("not_configured"), { cause: "profile_url" });
  }
  if (!headers) return done(unavailable("not_configured"), { cause: "signing_key" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text = "";
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "x-tenant-id": tenant, ...headers },
      signal: controller.signal,
      redirect: "error",
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const timedOut = controller.signal.aborted || err?.name === "AbortError" || err?.name === "TimeoutError";
    if (useBreaker) breakerOpenUntil = Math.max(breakerOpenUntil, nowMs() + BREAKER_OPEN_MS);
    return done(unavailable(timedOut ? "timeout" : "transport"));
  }
  clearTimeout(timer);

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const upstreamCode = typeof json?.code === "string" ? json.code : null;
  const status = res.status;
  if (status === 401 || status === 403) return done(unverified("auth"), { upstreamStatus: status, upstreamCode });
  if (status === 404 || status === 422) return done(unverified("business"), { upstreamStatus: status, upstreamCode });
  if (status !== 200) return done(unavailable(status >= 500 ? "upstream_5xx" : "upstream_status"), { upstreamStatus: status, upstreamCode });

  const data = json && typeof json === "object" && !Array.isArray(json) ? json.data : null;
  if (!data || typeof data !== "object") return done(unavailable("malformed_response"), { upstreamStatus: status });
  if (String(data.applicationId ?? "") !== appId || String(data.tenantId ?? "") !== tenant) {
    return done(unverified("business"), { upstreamStatus: status, cause: "identifier_mismatch" });
  }
  if (!STATUSES.has(data.status)) return done(unverified("business"), { upstreamStatus: status, cause: "unknown_status" });
  return done({ applicationId: appId, tenantId: tenant, status: data.status }, { upstreamStatus: status });
}

/** The provider shape payments.service expects. */
export function applicationRefundStateProvider({ tenantId, applicationId }) {
  return fetchApplicationRefundState({ tenantId, applicationId });
}
