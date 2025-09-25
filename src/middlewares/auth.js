import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";

export async function ensureAuthenticated(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(
      AppError.unauthorized("Authorization header required", {
        tokenError: true,
        missingHeader: true,
      })
    );
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Validate tenantId is present in token
    if (!decoded.tid) {
      return next(
        AppError.badRequest("Invalid token: missing tenantId", {
          tokenError: true,
          missingTenantId: true,
        })
      );
    }

    // Normalize roles to codes if token carries role objects
    const normalizedRoles = Array.isArray(decoded.roles)
      ? decoded.roles
          .map((role) => (typeof role === "string" ? role : role?.code))
          .filter(Boolean)
      : [];

    // Set request context with tenant isolation
    req.ctx = {
      tenantId: decoded.tid,
      userId: decoded.sub || decoded.id,
      roles: normalizedRoles,
      permissions: decoded.permissions || [],
    };

    // Attach user info to request for backward compatibility
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = decoded.tid;
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
