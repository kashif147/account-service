import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";
import {
  ROLE_HIERARCHY,
  getHighestRoleLevel,
  hasMinimumRole,
  isSuperUser,
} from "../config/roleHierarchy.js";

export async function ensureAuthenticated(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header?.startsWith("Bearer ")) {
    const authError = AppError.badRequest("Authorization header required", {
      tokenError: true,
      missingHeader: true,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        tokenError: authError.tokenError,
        missingHeader: authError.missingHeader,
      },
    });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Validate tenantId is present in token
    if (!decoded.tid) {
      const authError = AppError.badRequest("Invalid token: missing tenantId", {
        tokenError: true,
        missingTenantId: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          missingTenantId: authError.missingTenantId,
        },
      });
    }

    // Set request context with tenant isolation
    req.ctx = {
      tenantId: decoded.tid,
      userId: decoded.sub || decoded.id,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };

    // Attach user info to request for backward compatibility
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = decoded.tid;
    req.roles = decoded.roles || [];
    req.permissions = decoded.permissions || [];

    return next();
  } catch (e) {
    console.error("JWT failed:", e.message);
    const authError = AppError.badRequest("Invalid token", {
      tokenError: true,
      jwtError: e.message,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        tokenError: authError.tokenError,
        jwtError: authError.jwtError,
      },
    });
  }
}

// Helper function to check if user has any of the specified roles
function hasAnyRole(userRoles, requiredRoles) {
  if (!userRoles || !Array.isArray(userRoles)) return false;
  return requiredRoles.some((role) => userRoles.includes(role));
}

// Helper function to check if user has specific role is provided below as an exported utility

// Helper function to check if user has Super User role (full access)
// Note: isSuperUser is now imported from roleHierarchy.js

export function authorizeAny(...roles) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.roles) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingRoles: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingRoles: authError.missingRoles,
        },
      });
    }

    // Super User has access to everything
    if (isSuperUser(req.ctx.roles)) {
      return next();
    }

    if (hasAnyRole(req.ctx.roles, roles)) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userRoles: req.ctx.roles,
      requiredRoles: roles,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userRoles: forbiddenError.userRoles,
        requiredRoles: forbiddenError.requiredRoles,
      },
    });
  };
}

// Role hierarchy is now imported from ../config/roleHierarchy.js

export function authorizeMin(minRole) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.roles) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingRoles: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingRoles: authError.missingRoles,
        },
      });
    }

    // Super User has access to everything
    if (isSuperUser(req.ctx.roles)) {
      return next();
    }

    if (hasMinimumRole(req.ctx.roles, minRole)) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userRoles: req.ctx.roles,
      minimumRole: minRole,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userRoles: forbiddenError.userRoles,
        minimumRole: forbiddenError.minimumRole,
      },
    });
  };
}

// Permission-based authorization middleware
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.permissions) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingPermissions: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingPermissions: authError.missingPermissions,
        },
      });
    }

    // Super User has all permissions
    if (isSuperUser(req.ctx.roles)) {
      return next();
    }

    // Check if user has the required permission
    if (
      req.ctx.permissions.includes(permission) ||
      req.ctx.permissions.includes("*")
    ) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userPermissions: req.ctx.permissions,
      requiredPermission: permission,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userPermissions: forbiddenError.userPermissions,
        requiredPermission: forbiddenError.requiredPermission,
      },
    });
  };
}

// Middleware to require any of the specified permissions
export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.permissions) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingPermissions: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingPermissions: authError.missingPermissions,
        },
      });
    }

    // Super User has all permissions
    if (isSuperUser(req.ctx.roles)) {
      return next();
    }

    // Check if user has any of the required permissions
    const hasPermission = permissions.some(
      (permission) =>
        req.ctx.permissions.includes(permission) ||
        req.ctx.permissions.includes("*")
    );

    if (hasPermission) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userPermissions: req.ctx.permissions,
      requiredPermissions: permissions,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userPermissions: forbiddenError.userPermissions,
        requiredPermissions: forbiddenError.requiredPermissions,
      },
    });
  };
}

// Middleware to require specific role (exact match)
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.roles) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingRoles: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingRoles: authError.missingRoles,
        },
      });
    }

    if (hasRole(req.ctx.roles, role)) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userRoles: req.ctx.roles,
      requiredRole: role,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userRoles: forbiddenError.userRoles,
        requiredRole: forbiddenError.requiredRole,
      },
    });
  };
}

// Utility function to check if user has specific role
export function hasRole(userRoles, requiredRole) {
  if (!userRoles || !Array.isArray(userRoles)) return false;
  return userRoles.includes(requiredRole);
}

// Utility function to check if user has minimum role level
export function hasMinRole(userRoles, minRole) {
  return hasMinimumRole(userRoles, minRole);
}

// Utility function to get user's highest role level
export function getUserRoleLevel(userRoles) {
  return getHighestRoleLevel(userRoles);
}

// Utility function to check if user has permission
export function hasPermission(userPermissions, permission) {
  if (!userPermissions || !Array.isArray(userPermissions)) return false;
  return userPermissions.includes(permission) || userPermissions.includes("*");
}
