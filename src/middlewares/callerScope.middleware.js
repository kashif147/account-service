// Caller-class authorization (P5 portal object-authorization remediation).
//
// Caller classes are decided from the VERIFIED identity only:
//  - internal: req.ctx.internalRequest === true, which only forwardedInternalContext sets
//    (x-internal-request with NO user JWT / gateway identity). A user token never becomes
//    internal, even when a calling service also sends x-internal-request.
//  - CRM staff: req.user.userType === "CRM" (gateway claim / verified Bearer).
//  - PORTAL member: req.user.userType === "PORTAL".
//  - anything else (missing / unknown userType): denied (fail closed).
//
// Object ownership for PORTAL callers is established from the verified principal, never from
// a client-supplied memberId / profileId: the caller's own profile comes from profile-service
// GET /api/profile/my-profile (forwarding the caller's own identity), and a Payment is owned
// by the user that created it (audit.createdBy = the verified ctx.userId at intent creation).
import { AppError } from "../errors/AppError.js";
import { forwardedInternalContext } from "./context.js";

function norm(v) {
  return v == null ? "" : String(v).trim();
}

export function callerUserType(req) {
  return norm(req.user?.userType).toUpperCase();
}

export function isTrustedInternalCall(req) {
  return req.ctx?.internalRequest === true;
}

export function isCrmCaller(req) {
  return !isTrustedInternalCall(req) && callerUserType(req) === "CRM";
}

export function isPortalCaller(req) {
  return !isTrustedInternalCall(req) && callerUserType(req) === "PORTAL";
}

function crmOnly() {
  return new AppError("This action is restricted to CRM staff", 403, "CRM_ONLY");
}

function notOwner() {
  // Same response whether the target exists or not: never leak existence.
  return new AppError("Not permitted for this record", 403, "NOT_OWNER");
}

/** CRM staff only (403 CRM_ONLY otherwise). Place BEFORE the PDP requirePermission. */
export function requireCrmUser(req, res, next) {
  if (isCrmCaller(req)) return next();
  return next(crmOnly());
}

/** Genuine internal S2S call, or CRM staff. PORTAL / unknown denied. */
export function requireInternalOrCrm(req, res, next) {
  if (isTrustedInternalCall(req) || isCrmCaller(req)) return next();
  return next(crmOnly());
}

function internalOnly() {
  return new AppError(
    "This endpoint is only available to internal service calls",
    403,
    "INTERNAL_ONLY",
  );
}

/**
 * Internal-only route (no user chain behind it): the SAME trust contract as
 * `trustedInternalOnly` (x-internal-request: true, NO user identity header of any kind, an
 * explicit 24-hex x-tenant-id -> 400 TENANT_ID_REQUIRED / INVALID_TENANT_ID, then
 * forwardedInternalContext re-checked), but where trustedInternalOnly would fall through to a
 * user registration (`next("route")`) this denies 403 INTERNAL_ONLY instead. A user token /
 * gateway headers / forwarded x-user-* + a spoofed x-internal-request is never internal.
 */
export function requireTrustedInternalOnly(req, res, next) {
  return trustedInternalOnly(req, res, (arg) =>
    arg === "route" ? next(internalOnly()) : next(arg),
  );
}

async function defaultFetchMyPortalProfile(req) {
  const mod = await import("../services/profileUpstream.client.js");
  return mod.fetchMyPortalProfile(req);
}

/**
 * Member-scoped report routes (`/reports/member/:memberId/...`): CRM staff, or a PORTAL
 * member reading their OWN account only. The caller's own membershipNumber / profileId is
 * resolved from the verified principal via profile-service (my-profile); the :memberId path
 * value is only ever compared against it. Anything else -> 403.
 */
export function createRequireCrmOrOwnMember(deps = {}) {
  const fetchMyPortalProfile = deps.fetchMyPortalProfile || defaultFetchMyPortalProfile;
  return async function requireCrmOrOwnMember(req, res, next) {
    if (isCrmCaller(req)) return next();
    if (!isPortalCaller(req)) return next(crmOnly());
    const target = norm(req.params?.memberId);
    if (!target) return next(notOwner());
    let mine;
    try {
      mine = await fetchMyPortalProfile(req);
    } catch {
      return next(
        AppError.serviceUnavailable(
          "Unable to verify the member for this request. Please try again.",
        ),
      );
    }
    const ownKeys = [norm(mine?.membershipNumber), norm(mine?.profileId)].filter(Boolean);
    if (ownKeys.includes(target)) return next();
    return next(notOwner());
  };
}

export const requireCrmOrOwnMember = createRequireCrmOrOwnMember();

async function defaultLoadPaymentByIntent(tenantId, paymentIntentId) {
  const { default: Payment } = await import("../models/payment.model.js");
  return Payment.findOne({ tenantId, "stripe.paymentIntentId": paymentIntentId })
    .select({ _id: 1, audit: 1 })
    .lean();
}

/**
 * `/payments/intents/:paymentIntentId/...` and `/payments/by-stripe/:paymentIntentId`:
 * internal S2S, CRM staff, or a PORTAL caller acting on a Payment it created itself
 * (audit.createdBy === verified ctx.userId, looked up in the trusted tenant only).
 */
export function createRequireInternalOrCrmOrIntentOwner(deps = {}) {
  const loadPaymentByIntent = deps.loadPaymentByIntent || defaultLoadPaymentByIntent;
  return async function requireInternalOrCrmOrIntentOwner(req, res, next) {
    if (isTrustedInternalCall(req) || isCrmCaller(req)) return next();
    if (!isPortalCaller(req)) return next(crmOnly());
    const tenantId = norm(req.ctx?.tenantId);
    const userId = norm(req.ctx?.userId || req.user?.id);
    const paymentIntentId = norm(req.params?.paymentIntentId);
    if (!tenantId || !userId || !paymentIntentId) return next(notOwner());
    let payment;
    try {
      payment = await loadPaymentByIntent(tenantId, paymentIntentId);
    } catch (err) {
      return next(err);
    }
    if (payment && norm(payment.audit?.createdBy) === userId) return next();
    return next(notOwner());
  };
}

export const requireInternalOrCrmOrIntentOwner = createRequireInternalOrCrmOrIntentOwner();

// Headers that carry (or claim) a user identity. Any of them present means the request is
// judged as a user call, never as a trusted internal one.
const USER_IDENTITY_HEADERS = [
  "authorization",
  "x-jwt-verified",
  "x-auth-source",
  "x-user-id",
  "x-user-email",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
  "x-ms-client-principal",
  "x-ms-token-aad-access-token",
];
const HEX_OBJECT_ID = /^[a-fA-F0-9]{24}$/;

/**
 * First half of an "internal S2S OR user chain" route pair (see
 * `POST /reports/gl-journal-replication`). Admits ONLY a genuine internal call:
 * `x-internal-request: true`, NO user identity header of any kind, and an explicit
 * 24-hex `x-tenant-id` (missing -> 400 TENANT_ID_REQUIRED, malformed -> 400
 * INVALID_TENANT_ID). The context is then built by `forwardedInternalContext`
 * (ctx.internalRequest === true, no userId) and the handler runs.
 *
 * Anything else calls `next("route")`, so Express falls through to the route's second
 * registration (the normal authenticated user chain), where the caller is judged as the
 * user it presents - a user token + spoofed `x-internal-request` never gets this grant.
 */
export function trustedInternalOnly(req, res, next) {
  const headers = req.headers || {};
  const claimsUser = USER_IDENTITY_HEADERS.some((h) => headers[h] != null);
  if (claimsUser || norm(headers["x-internal-request"]) !== "true") {
    return next("route");
  }
  const tenantId = norm(headers["x-tenant-id"]);
  if (!tenantId) {
    return next(new AppError("x-tenant-id is required for internal calls", 400, "TENANT_ID_REQUIRED"));
  }
  if (!HEX_OBJECT_ID.test(tenantId)) {
    return next(new AppError("x-tenant-id must be a 24-hex id", 400, "INVALID_TENANT_ID"));
  }
  return forwardedInternalContext(req, res, (err) => {
    if (err) return next(err);
    if (isTrustedInternalCall(req) && !req.ctx?.userId && norm(req.ctx?.tenantId) === tenantId) {
      return next();
    }
    return next(crmOnly());
  });
}
