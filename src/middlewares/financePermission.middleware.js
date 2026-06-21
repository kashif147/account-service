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
