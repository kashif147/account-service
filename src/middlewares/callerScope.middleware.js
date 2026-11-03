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
    .select({ _id: 1, audit: 1, payer: 1 })
    .lean();
}

/**
 * `/payments/intents/:paymentIntentId/...` and `/payments/by-stripe/:paymentIntentId`:
 * internal S2S, CRM staff, or a PORTAL caller acting on a Payment it created itself
 * (payer.userId - or audit.createdBy for a legacy row without payer - === verified
 * ctx.userId, looked up in the trusted tenant only).
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
    // Owner = the verified payer bound at intent creation (payer.userId); a legacy row
    // created before payer existed falls back to audit.createdBy.
    const owner = payment
      ? norm(payment.payer ? payment.payer.userId : payment.audit?.createdBy)
      : "";
    if (owner && owner === userId) return next();
    return next(notOwner());
  };
}

export const requireInternalOrCrmOrIntentOwner = createRequireInternalOrCrmOrIntentOwner();
