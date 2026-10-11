// portal-service HTTP client (application intake data). account-service never reads
// portal-service's database; it asks portal-service as the CALLER, forwarding the caller's
// own gateway/JWT identity, so portal-service applies its own tenant + ownership rules.
import { requireTenantId } from "../helpers/tenantScope.js";

const DEFAULT_TIMEOUT_MS = 15000;
const FORWARDED = [
  "x-jwt-verified",
  "x-auth-source",
  "x-user-id",
  "x-user-email",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
  "x-correlation-id",
];

function portalBase() {
  const base = (process.env.PORTAL_SERVICE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("PORTAL_SERVICE_URL is required for application lookups");
  return base;
}

function buildHeaders(req) {
  const headers = {
    Accept: "application/json",
    // Always the trusted tenant, never the raw inbound header.
    "x-tenant-id": requireTenantId(req),
  };
  const auth = req?.headers?.authorization || req?.headers?.Authorization;
  if (auth) headers.Authorization = auth;
  for (const key of FORWARDED) {
    const v = req?.headers?.[key];
    if (v != null && v !== "") headers[key] = Array.isArray(v) ? v[0] : v;
  }
  return headers;
}

export class UpstreamNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "UpstreamNotFoundError";
  }
}

/**
 * The caller's own application subscription details
 * (GET {PORTAL_SERVICE_URL}/api/subscription-details/:applicationId). portal-service scopes
 * this to the trusted tenant and, for PORTAL users, to the caller's own userId, so a
 * result proves the application exists in this tenant and belongs to the caller.
 *
 * @returns {Promise<{ applicationId: string, membershipCategory: string|null, paymentType: string|null }>}
 * @throws {UpstreamNotFoundError} when portal-service does not return it for this caller
 */
export async function fetchMyApplicationSubscription(req, applicationId) {
  const id = String(applicationId || "").trim();
  if (!id) throw new UpstreamNotFoundError("applicationId required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${portalBase()}/api/subscription-details/${encodeURIComponent(id)}`,
      { method: "GET", headers: buildHeaders(req), signal: controller.signal },
    );
    if (res.status === 404 || res.status === 403 || res.status === 400) {
      throw new UpstreamNotFoundError("Application not found");
    }
    if (!res.ok) throw new Error(`portal-service ${res.status}`);
    const json = await res.json().catch(() => null);
    const d = json?.data;
    if (!d || typeof d !== "object") throw new UpstreamNotFoundError("Application not found");
    const sub = d.subscriptionDetails || {};
    return {
      applicationId: String(d.applicationId || d.ApplicationId || id),
      membershipCategory:
        sub.membershipCategory != null && String(sub.membershipCategory).trim() !== ""
          ? String(sub.membershipCategory).trim()
          : null,
      paymentType:
        sub.paymentType != null && String(sub.paymentType).trim() !== ""
          ? String(sub.paymentType).trim()
          : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
