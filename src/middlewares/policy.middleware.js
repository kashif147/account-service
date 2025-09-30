/**
 * Centralized RBAC Policy Middleware (ESM)
 * Delegates authorization to user-service PDP similar to portal-service
 */

import PolicyClient from "../utils/policyClient.js";
import { AppError } from "../errors/AppError.js";

class PolicyMiddleware {
  constructor(baseURL, options = {}) {
    this.policyClient = new PolicyClient(baseURL, options);
  }

  requirePermission(resource, action) {
    return async (req, res, next) => {
      try {
        let authHeader = req.headers.authorization || req.headers.Authorization;
        const aadAccessToken =
          req.headers["x-ms-token-aad-access-token"] ||
          req.headers["X-MS-TOKEN-AAD-ACCESS-TOKEN"];

        if (!authHeader && aadAccessToken) {
          authHeader = `Bearer ${aadAccessToken}`;
          req.headers.authorization = authHeader;
        }

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return next(
            AppError.unauthorized("Authorization header required", {
              tokenError: true,
              missingHeader: true,
            })
          );
        }

        const token = authHeader.substring(7);

        const context = {
          userId: req.ctx?.userId || req.user?.id || req.userId,
          tenantId: req.ctx?.tenantId || req.user?.tenantId || req.tenantId,
          userRoles: req.ctx?.roles || req.user?.roles || req.roles || [],
          userPermissions:
            req.ctx?.permissions ||
            req.user?.permissions ||
            req.permissions ||
            [],
          ...req.body,
          ...req.query,
          ...req.params,
        };

        const result = await this.policyClient.evaluatePolicy(
          token,
          resource,
          action,
          context
        );

        if (result.success && result.decision === "PERMIT") {
          req.policyContext = result;
          if (result.user) {
            req.user = result.user;
            req.userId = result.user.id;
            req.tenantId = result.user.tenantId;
            req.roles = result.user.roles || [];
            req.permissions = result.user.permissions || [];
          }
          return next();
        }

        return next(
          AppError.forbidden("Insufficient permissions", {
            reason: result.reason || "PERMISSION_DENIED",
            resource,
            action,
          })
        );
      } catch (error) {
        return next(
          AppError.serviceUnavailable("Authorization service error", {
            error: error.message,
            code: "POLICY_SERVICE_ERROR",
          })
        );
      }
    };
  }

  async hasPermission(token, resource, action, context = {}) {
    try {
      const result = await this.policyClient.evaluatePolicy(
        token,
        resource,
        action,
        context
      );
      return result.success && result.decision === "PERMIT";
    } catch {
      return false;
    }
  }

  async getPermissions(token, resource) {
    return this.policyClient.getPermissions(token, resource);
  }

  clearCache() {
    this.policyClient.clearCache();
  }

  getCacheStats() {
    return this.policyClient.getCacheStats();
  }
}

const defaultPolicyMiddleware = new PolicyMiddleware(
  process.env.POLICY_SERVICE_URL || "http://localhost:3000",
  {
    timeout: 15000,
    retries: 5,
    cacheTimeout: 300000,
    retryDelay: 2000,
  }
);

export default PolicyMiddleware;
export { defaultPolicyMiddleware };
