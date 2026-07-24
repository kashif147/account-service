import { AppError } from "../errors/AppError.js";

export function forwardedInternalContext(req, res, next) {
  const tenantId = req.header("x-tenant-id");
  const idempotencyKey = req.header("x-idempotency-key");

  if (!tenantId) {
    return res.appError(AppError.unauthorized("Missing tenant id"));
  }

  const userId = req.header("x-user-id") || null;
  const userEmail = req.header("x-user-email") || null;
  const userType = req.header("x-user-type") || null;
  const internalRequest = req.header("x-internal-request") === "true";

  let roles = [];
  let permissions = [];
  try {
    const parsed = JSON.parse(req.header("x-user-roles") || "[]");
    roles = Array.isArray(parsed)
      ? parsed.map((role) => (typeof role === "string" ? role : role?.code)).filter(Boolean)
      : [];
  } catch {
    roles = [];
  }
  try {
    const parsed = JSON.parse(req.header("x-user-permissions") || "[]");
    permissions = Array.isArray(parsed) ? parsed : [];
  } catch {
    permissions = [];
  }

  req.ctx = {
    tenantId,
    userId,
    roles,
    permissions,
    internalRequest,
  };
  req.user = {
    id: userId,
    tenantId,
    email: userEmail,
    userType,
    roles,
    permissions,
  };
  req.userId = userId;
  req.tenantId = tenantId;
  req.roles = roles;
  req.permissions = permissions;

  if (idempotencyKey) {
    req.ctx.idempotencyKey = idempotencyKey;
  }

  return next();
}
