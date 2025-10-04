import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";

function decodeBase64Json(value) {
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractFromClientPrincipal(clientPrincipal) {
  if (!clientPrincipal || typeof clientPrincipal !== "object") return null;

  const claims = Array.isArray(clientPrincipal.claims)
    ? clientPrincipal.claims
    : [];

  const claimMap = new Map();
  for (const c of claims) {
    if (c && c.typ) claimMap.set(c.typ, c.val);
  }

  const roleTypes = new Set(
    [
      clientPrincipal.role_typ,
      "roles",
      "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
    ].filter(Boolean)
  );

  const roles = claims
    .filter((c) => c && roleTypes.has(c.typ))
    .map((c) => c.val)
    .filter(Boolean);

  const tenantId =
    claimMap.get("http://schemas.microsoft.com/identity/claims/tenantid") ||
    claimMap.get("tid") ||
    claimMap.get("tenantId") ||
    null;

  const userId =
    claimMap.get(
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
    ) ||
    claimMap.get("oid") ||
    claimMap.get("sub") ||
    claimMap.get(
      "http://schemas.microsoft.com/identity/claims/objectidentifier"
    ) ||
    null;

  return {
    tenantId,
    userId,
    roles,
    permissions: [],
    raw: clientPrincipal,
  };
}

export async function ensureAuthenticated(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;

  // 1) Standard Bearer JWT flow
  if (header?.startsWith("Bearer ")) {
    const token = header.split(" ")[1];
    try {
      const secret =
        process.env.JWT_SECRET ||
        process.env.ACCESS_TOKEN_SECRET ||
        process.env.ACCESS_TOEKN_SECRET; // tolerate legacy typo
      const decoded = jwt.verify(token, secret);

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

      const normalizedRoles = Array.isArray(decoded.roles)
        ? decoded.roles
            .map((role) => (typeof role === "string" ? role : role?.code))
            .filter(Boolean)
        : [];

      req.ctx = {
        tenantId: tokenTenantId,
        userId: decoded.sub || decoded.id,
        roles: normalizedRoles,
        permissions: decoded.permissions || [],
      };

      // Handle idempotency key from headers
      const idempotencyKey = req.header("x-idempotency-key");
      if (idempotencyKey) {
        req.ctx.idempotencyKey = idempotencyKey;
      }
      req.user = decoded;
      req.userId = decoded.sub || decoded.id;
      req.tenantId = tokenTenantId;
      req.roles = normalizedRoles;
      req.permissions = decoded.permissions || [];
      return next();
    } catch (e) {
      console.error("JWT failed:", e.message);
      return next(
        AppError.badRequest("Invalid token", {
          tokenError: true,
          jwtError: e.message,
        })
      );
    }
  }

  // 2) Azure App Service EasyAuth compatibility
  const clientPrincipalB64 =
    req.headers["x-ms-client-principal"] ||
    req.headers["X-MS-CLIENT-PRINCIPAL"];
  const aadAccessToken =
    req.headers["x-ms-token-aad-access-token"] ||
    req.headers["X-MS-TOKEN-AAD-ACCESS-TOKEN"];

  if (clientPrincipalB64) {
    const principal = decodeBase64Json(clientPrincipalB64);
    const extracted = extractFromClientPrincipal(principal);
    if (extracted && extracted.tenantId) {
      // Populate context
      req.ctx = {
        tenantId: extracted.tenantId,
        userId: extracted.userId,
        roles: extracted.roles,
        permissions: extracted.permissions,
      };

      // Handle idempotency key from headers
      const idempotencyKey = req.header("x-idempotency-key");
      if (idempotencyKey) {
        req.ctx.idempotencyKey = idempotencyKey;
      }
      req.user = principal;
      req.userId = extracted.userId;
      req.tenantId = extracted.tenantId;
      req.roles = extracted.roles;
      req.permissions = extracted.permissions;

      // If upstream provided an AAD token, make it available for downstream policy checks
      if (!header && aadAccessToken) {
        req.headers.authorization = `Bearer ${aadAccessToken}`;
      }
      return next();
    }
  }

  // 3) Fallback: if AAD access token exists, surface it as Authorization for downstream
  if (aadAccessToken) {
    req.headers.authorization = `Bearer ${aadAccessToken}`;
    // Do not verify here; allow downstream policy middleware to evaluate permissions
    return next();
  }

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
