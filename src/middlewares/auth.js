import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";
import * as gatewaySecurity from "@membership/policy-middleware/security";
import { tenantContextMiddleware } from "@membership/policy-middleware";
const { validateGatewayRequest } = gatewaySecurity;

function jwtSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.ACCESS_TOKEN_SECRET ||
    process.env.ACCESS_TOEKN_SECRET // tolerate legacy typo
  );
}

/** Verify a ProjectShell user JWT with this service's secret: HS256 only, exp/nbf enforced. */
function verifyUserJwt(token) {
  const secret = jwtSecret();
  if (!secret) throw new Error("JWT secret not configured");
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)$/.exec(header.trim());
  return m ? m[1] : null;
}

function headerValue(req, name) {
  const v = req.headers[name];
  return v == null ? "" : String(v).trim();
}

function normaliseRoles(roles) {
  return Array.isArray(roles)
    ? roles.map((role) => (typeof role === "string" ? role : role?.code)).filter(Boolean)
    : [];
}

function setIdempotencyKey(req) {
  const idempotencyKey = req.header("x-idempotency-key");
  if (idempotencyKey) req.ctx.idempotencyKey = idempotencyKey;
}

/**
 * Gateway-forwarded identity (x-jwt-verified / x-auth-source: gateway / x-user-*).
 *
 * The gateway does NOT sign the headers it forwards (no HMAC: trusted_headers.lua strips any
 * x-gateway-signature, and policy-middleware's validateGatewayRequest only checks presence and
 * shape). The headers are therefore only a claim. The gateway always forwards the original
 * ProjectShell JWT as Authorization, and every calling service forwards it with the headers, so the
 * identity is taken from that token, verified here (HS256, exp/nbf enforced). The headers must
 * agree with the verified claims; on agreement they are rewritten from the claims so downstream
 * consumers (PDP header path, outbound forwarding) only ever see verified values.
 * x-token-expires-at is never trusted: it is overwritten from the verified exp.
 *
 * Fails closed: no token, invalid/expired token, identity mismatch -> 401; tenant mismatch -> 403.
 */
function authenticateForwardedIdentity(req, next) {
  const validation = validateGatewayRequest(req);
  if (!validation.valid) {
    return next(AppError.unauthorized("Invalid gateway request", { tokenError: true, validationError: validation.reason }));
  }
  const token = bearerToken(req);
  if (!token) {
    return next(AppError.unauthorized("Verified user token required", { tokenError: true, code: "VERIFIED_TOKEN_REQUIRED" }));
  }
  let decoded;
  try {
    decoded = verifyUserJwt(token);
  } catch (e) {
    return next(AppError.unauthorized("Invalid or expired token", { tokenError: true, code: "INVALID_TOKEN", jwtError: e?.name }));
  }
  const tokenUserId = String(decoded?.id || decoded?.sub || "");
  const tokenTenantId = String(decoded?.tenantId || "");
  const tokenUserType = typeof decoded?.userType === "string" ? decoded.userType : "";
  if (!tokenUserId || !tokenTenantId) {
    return next(AppError.unauthorized("Invalid token: missing identity", { tokenError: true, code: "INVALID_TOKEN" }));
  }
  const fwdUserId = headerValue(req, "x-user-id");
  const fwdUserType = headerValue(req, "x-user-type");
  if (fwdUserId !== tokenUserId || (fwdUserType && fwdUserType !== tokenUserType)) {
    return next(AppError.unauthorized("Forwarded identity does not match the verified token", { tokenError: true, code: "IDENTITY_MISMATCH" }));
  }
  if (headerValue(req, "x-tenant-id") !== tokenTenantId) {
    return next(new AppError("Tenant context mismatch", 403, "TENANT_CONTEXT_MISMATCH"));
  }

  const roles = normaliseRoles(decoded.roles);
  const permissions = Array.isArray(decoded.permissions) ? decoded.permissions : [];
  const email = typeof decoded.email === "string" ? decoded.email : "";

  // Downstream consumers read these headers: make them the verified values.
  req.headers["x-user-id"] = tokenUserId;
  req.headers["x-tenant-id"] = tokenTenantId;
  req.headers["x-user-type"] = tokenUserType;
  req.headers["x-user-email"] = email;
  req.headers["x-user-roles"] = JSON.stringify(decoded.roles || []);
  req.headers["x-user-permissions"] = JSON.stringify(permissions);
  if (decoded.exp) req.headers["x-token-expires-at"] = String(decoded.exp * 1000);
  else delete req.headers["x-token-expires-at"];

  req.ctx = { tenantId: tokenTenantId, userId: tokenUserId, roles, permissions };
  setIdempotencyKey(req);
  req.user = { sub: tokenUserId, id: tokenUserId, tenantId: tokenTenantId, email, userType: tokenUserType || null, roles, permissions };
  req.userId = tokenUserId;
  req.tenantId = tokenTenantId;
  req.roles = roles;
  req.permissions = permissions;
  return next();
}

export async function ensureAuthenticated(req, res, next) {
  // 1) Gateway-forwarded identity: only with a verified original token that matches it.
  if (req.headers["x-jwt-verified"] === "true" && req.headers["x-auth-source"] === "gateway") {
    return authenticateForwardedIdentity(req, next);
  }
  // Any other forwarded-identity claim without the gateway marker is not an identity source.
  if (req.headers["x-jwt-verified"] != null) {
    return next(AppError.unauthorized("Invalid gateway request", { tokenError: true, validationError: "Unsupported auth source" }));
  }

  // 2) Bearer JWT (direct service calls forwarding the user's token)
  const token = bearerToken(req);
  if (token) {
    try {
      const decoded = verifyUserJwt(token);

      const tokenTenantId =
        decoded.tid ||
        decoded.tenantId ||
        decoded.tenantID ||
        decoded.tenant_id ||
        null;

      if (!tokenTenantId) {
        return next(
          AppError.badRequest("Invalid token: missing tenantId", {
            tokenError: true,
            missingTenantId: true,
          })
        );
      }

      const normalizedRoles = normaliseRoles(decoded.roles);

      req.ctx = {
        tenantId: tokenTenantId,
        userId: decoded.sub || decoded.id,
        roles: normalizedRoles,
        permissions: decoded.permissions || [],
      };
      setIdempotencyKey(req);
      req.user = decoded;
      req.userId = decoded.sub || decoded.id;
      req.tenantId = tokenTenantId;
      req.roles = normalizedRoles;
      req.permissions = decoded.permissions || [];
      return next();
    } catch (e) {
      console.error("JWT failed:", e.name);
      return next(
        AppError.unauthorized("Invalid token", {
          tokenError: true,
          jwtError: e.name,
        })
      );
    }
  }

  // The former Azure EasyAuth (x-ms-client-principal) and bare AAD access-token fallbacks took
  // tenant and user from unverified headers; they are removed. No other identity source exists.
  return next(
    AppError.unauthorized("Authorization header required", {
      tokenError: true,
      missingHeader: true,
    })
  );
}

// Tenant enforcement
export function requireTenant(req, res, next) {
  if (!req.ctx || !req.ctx.tenantId) {
    const authError = AppError.badRequest("Tenant context required", {
      authError: true,
      missingTenant: true,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        authError: authError.authError,
        missingTenant: authError.missingTenant,
      },
    });
  }
  return next();
}

export function withTenant(tenantId) {
  return { tenantId };
}

export function addTenantMatch(tenantId) {
  return { $match: { tenantId } };
}

// Alias to mirror other services
export const authenticate = ensureAuthenticated;

/**
 * Phase 1A canonical tenant-context guard — WARN MODE ONLY (non-blocking).
 *
 * Runs AFTER `ensureAuthenticated`, so it observes the tenant already
 * established on req.ctx/req.user/req.tenantId. In "warn" mode it re-pins
 * req.tenantId to that tenant and LOGS any caller-supplied (body/query/params)
 * tenantId that disagrees, as a non-blocking TenantContextMismatch event — it
 * never returns 403.
 *
 * SECURITY NOTE: WARN mode does NOT make any auth path trusted that was not already. The
 * unverified EasyAuth `x-ms-client-principal` path has been removed from `ensureAuthenticated`;
 * the forwarded-internal tenant source (x-internal-request) still rests on the network boundary.
 */
export const tenantContextWarn = tenantContextMiddleware();

/**
 * Smallest composed authenticated chain for adopting the WARN guard on a route:
 *   router.get("/x", ...ensureAuthenticatedWithTenantContext, requirePermission(...), handler)
 * Guarantees ordering: authenticate -> tenantContextWarn -> authorization/controller.
 * Use ONLY on routes that already establish a trusted user via `ensureAuthenticated`
 * — never on internal/S2S (`internalOrAuthenticated`/`forwardedInternalContext`) routes.
 */
export const ensureAuthenticatedWithTenantContext = [
  ensureAuthenticated,
  tenantContextWarn,
];
