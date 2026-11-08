import { AppError } from "../errors/AppError.js";
import {
  collectRequestPermissions,
  hasFinanceActionRole,
  hasFinancePermission,
} from "../helpers/financePermissions.js";

function canFinanceRead(req) {
  const perms = collectRequestPermissions(req);
  return (
    hasFinancePermission(perms, "payments", "read") ||
    hasFinancePermission(perms, "accounts.admin", "read") ||
    hasFinancePermission(perms, "accounts.reports", "read")
  );
}

function canFinanceWrite(req) {
  const perms = collectRequestPermissions(req);
  return hasFinanceActionRole(req) && (
    hasFinancePermission(perms, "payments", "write") ||
    hasFinancePermission(perms, "payments", "create") ||
    hasFinancePermission(perms, "accounts.admin", "write") ||
    hasFinancePermission(perms, "accounts.journals", "write")
  );
}

// Finance datasets (direct-debit runs / PAIN.008, reconciliation, journal adjustments,
// refunds) are readable only with an explicit finance permission claim. Literal match only:
// hasFinancePermission()'s alias table maps accounts.reports:read -> payments:read, and
// accounts.reports:read is also held by the portal MEMBER role, so it must never unlock these.
const FINANCE_DATA_READ_CLAIMS = [
  "*",
  "admin",
  "payments:*",
  "payments:read",
  "accounts.admin:*",
  "accounts.admin:read",
];

function hasFinanceDataReadClaim(req) {
  const perms = collectRequestPermissions(req);
  return FINANCE_DATA_READ_CLAIMS.some((p) => perms.includes(p));
}

function callerUserType(req) {
  return String(req.user?.userType || "").trim().toUpperCase();
}

/**
 * Finance back-office read (direct-debit runs, reconciliation, journal adjustments).
 * CRM staff (verified userType) holding payments:read or accounts.admin:read only.
 * A token with no permission claims, a PORTAL member, or a missing/unknown userType is
 * denied (fail closed); accounts.reports:read alone does not qualify.
 */
export function requireFinanceRead(req, res, next) {
  if (callerUserType(req) !== "CRM") {
    return next(
      new AppError("Finance read is restricted to CRM staff", 403, "CRM_ONLY"),
    );
  }
  if (hasFinanceDataReadClaim(req)) return next();
  return next(
    AppError.forbidden(
      "Finance read permission required (payments:read or accounts.admin:read)",
    ),
  );
}

/**
 * CRM staff only (verified userType "CRM"), before any finance permission check. PDP P3: mounted on the whole
 * direct-debit run router, so a PORTAL member or a token with a missing / unknown userType is refused on the
 * write routes too (requireFinanceWrite itself checks role + permission only, not the caller type).
 */
export function requireCrmStaff(req, res, next) {
  if (callerUserType(req) === "CRM") return next();
  return next(new AppError("Restricted to CRM staff", 403, "CRM_ONLY"));
}

/** Finance back-office write (seed, match, approve adjustments). */
export function requireFinanceWrite(req, res, next) {
  if (canFinanceWrite(req)) return next();
  return next(
    AppError.forbidden(
      "Finance action access requires Accounts Manager or Deputy Accounts Manager role with finance write permission",
    ),
  );
}

/**
 * True only for a genuine service-to-service call: internalAuth routed it through
 * forwardedInternalContext (x-internal-request: true and NO user JWT/gateway identity).
 * ensureAuthenticated never sets ctx.internalRequest, so a user token plus a spoofed
 * x-internal-request header does not qualify.
 */
function isTrustedInternalCall(req) {
  return req.ctx?.internalRequest === true;
}

/**
 * Strict finance read for user-originated calls: no "empty permission claims" bypass and
 * never a PORTAL (member) user.
 */
export function requireFinanceReadStrict(req, res, next) {
  const userType = String(req.user?.userType || "").toUpperCase();
  if (userType === "PORTAL") {
    return next(AppError.forbidden("Finance read permission required"));
  }
  if (canFinanceRead(req)) return next();
  return next(
    AppError.forbidden(
      "Finance read permission required (payments:read, accounts.admin:read or accounts.reports:read)",
    ),
  );
}

/** Internal S2S call, or authenticated user with finance write (role + permission). */
export function requireInternalOrFinanceWrite(req, res, next) {
  if (isTrustedInternalCall(req)) return next();
  return requireFinanceWrite(req, res, next);
}

/** Internal S2S call, or CRM staff with an explicit finance data read claim (see requireFinanceRead). */
export function requireInternalOrFinanceDataRead(req, res, next) {
  if (isTrustedInternalCall(req)) return next();
  return requireFinanceRead(req, res, next);
}

/** Internal S2S call, or authenticated non-portal user with a finance read permission. */
export function requireInternalOrFinanceRead(req, res, next) {
  if (isTrustedInternalCall(req)) return next();
  return requireFinanceReadStrict(req, res, next);
}
