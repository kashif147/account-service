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

/** Finance back-office read (reconciliation list, journal adjustments list). */
export function requireFinanceRead(req, res, next) {
  const perms = collectRequestPermissions(req);
  // Gateway/JWT without permission claims: allow read (matches accounts.reports access).
  if (perms.length === 0 && (req.user?.id || req.ctx?.userId)) {
    return next();
  }
  if (canFinanceRead(req)) return next();
  return next(
    AppError.forbidden(
      "Finance read permission required (payments:read or accounts.admin:read)",
    ),
  );
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

/** Internal S2S call, or authenticated non-portal user with a finance read permission. */
export function requireInternalOrFinanceRead(req, res, next) {
  if (isTrustedInternalCall(req)) return next();
  return requireFinanceReadStrict(req, res, next);
}
