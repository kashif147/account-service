import { AppError } from "../errors/AppError.js";

// Identity-bearing headers. On the internal (no-token) path they would be an unverified identity
// claim, so their presence refuses the request instead of populating req.user from them.
const UNVERIFIED_IDENTITY_HEADERS = ["x-user-id", "x-user-type", "x-user-email", "x-user-roles", "x-user-permissions"];

export function forwardedInternalContext(req, res, next) {
  if (UNVERIFIED_IDENTITY_HEADERS.some((h) => req.header(h) != null && String(req.header(h)).trim() !== "")) {
    return res.appError(
      AppError.unauthorized("User identity requires a verified token", { tokenError: true, code: "UNVERIFIED_IDENTITY" }),
    );
  }
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
