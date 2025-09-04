import jwt from "jsonwebtoken";
import ROLES_LIST from "../config/roles.js";
import { AppError } from "../errors/AppError.js";

export async function ensureAuthenticated(req, res, next) {
  const token = req.headers.authorization;
  if (!token) {
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

  try {
    const decoded = jwt.verify(
      token.replace("Bearer ", ""),
      process.env.JWT_SECRET
    );
    req.user = {
      id: decoded.id,
      role: decoded.role,
      tenantId: decoded.tenantId,
    }; // adjust per issuer
    req.tenantId = decoded.tenantId;
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

function val(role) {
  if (typeof role === "number") return role;
  return ROLES_LIST[role] ?? -1;
}

export function authorizeAny(...roles) {
  const allowed = roles.map(val).filter((v) => v >= 0);
  return (req, res, next) => {
    if (!req.user) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingUser: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingUser: authError.missingUser,
        },
      });
    }

    if (allowed.includes(val(req.user?.role))) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userRole: req.user?.role,
      requiredRoles: roles,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userRole: forbiddenError.userRole,
        requiredRoles: forbiddenError.requiredRoles,
      },
    });
  };
}

export function authorizeMin(minRole) {
  const min = val(minRole);
  return (req, res, next) => {
    if (!req.user) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingUser: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingUser: authError.missingUser,
        },
      });
    }

    if (val(req.user?.role) >= min) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userRole: req.user?.role,
      minimumRole: minRole,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userRole: forbiddenError.userRole,
        minimumRole: forbiddenError.minimumRole,
      },
    });
  };
}

// Utility function to check if user has specific role
export function hasRole(user, role) {
  return val(user?.role) === val(role);
}

// Utility function to check if user has minimum role
export function hasMinRole(user, minRole) {
  return val(user?.role) >= val(minRole);
}

// Utility function to get user's role level
export function getUserRoleLevel(user) {
  return val(user?.role);
}

// Middleware to require specific role (exact match)
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingUser: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingUser: authError.missingUser,
        },
      });
    }

    if (hasRole(req.user, role)) {
      return next();
    }

    const forbiddenError = AppError.badRequest("Insufficient permissions", {
      forbidden: true,
      userRole: req.user?.role,
      requiredRole: role,
    });
    return res.status(forbiddenError.status).json({
      error: {
        message: forbiddenError.message,
        code: forbiddenError.code,
        status: forbiddenError.status,
        forbidden: forbiddenError.forbidden,
        userRole: forbiddenError.userRole,
        requiredRole: forbiddenError.requiredRole,
      },
    });
  };
}
