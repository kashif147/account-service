/**
 * Core Policy Client for Centralized RBAC Policy Evaluation (ESM)
 */

import { AppError } from "../errors/AppError.js";

class PolicyClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeout = options.timeout || 10000;
    this.retries = options.retries || 5;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 300000; // 5 minutes
    this.retryDelay = options.retryDelay || 1000; // ms
  }

  async evaluate(token, resource, action, context = {}) {
    const cacheKey = this.getCacheKey(token, resource, action, context);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.result;
    }

    try {
      const response = await this.makeRequest("/policy/evaluate", {
        method: "POST",
        body: JSON.stringify({ token, resource, action, context }),
        headers: { "Content-Type": "application/json" },
      });

      const normalized = {
        success: response.authorized || response.success || false,
        decision: response.decision,
        reason: response.reason,
        user: response.user,
        resource: response.resource,
        action: response.action,
        timestamp: response.timestamp,
        policyVersion: response.policyVersion,
        ...response,
      };

      if (normalized.success) {
        this.cache.set(cacheKey, { result: normalized, timestamp: Date.now() });
      }
      return normalized;
    } catch (error) {
      return {
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
        resource,
        action,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async evaluatePolicy(token, resource, action, context = {}) {
    return this.evaluate(token, resource, action, context);
  }

  async evaluateBatch(requests) {
    try {
      const response = await this.makeRequest("/policy/evaluate-batch", {
        method: "POST",
        body: JSON.stringify({ requests }),
        headers: { "Content-Type": "application/json" },
      });
      return response.results || [];
    } catch (error) {
      return requests.map(() => ({
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
      }));
    }
  }

  async check(token, resource, action, context = {}) {
    try {
      const queryParams = new URLSearchParams(context);
      const response = await this.makeRequest(
        `/policy/check/${resource}/${action}?${queryParams}`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      return response.success;
    } catch {
      return false;
    }
  }

  middleware(resource, action) {
    return async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return next(
            AppError.unauthorized("Authorization header required", {
              tokenError: true,
              missingHeader: true,
            })
          );
        }
        const token = authHeader.substring(7);
        const result = await this.evaluate(token, resource, action, req.query);
        if (result.success) {
          req.user = result.user;
          req.tenantId = result.user?.tenantId;
          return next();
        }
        return next(
          AppError.forbidden("Access denied", { reason: result.reason })
        );
      } catch (error) {
        return next(
          AppError.serviceUnavailable("Authorization check failed", {
            error: error.message,
          })
        );
      }
    };
  }

  async getPermissions(token, resource) {
    try {
      const response = await this.makeRequest(
        `/policy/permissions/${resource}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheStats() {
    return { size: this.cache.size, timeout: this.cacheTimeout };
  }

  async makeRequest(endpoint, options) {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError;
    for (let i = 0; i < this.retries; i++) {
      try {
        if (typeof fetch !== "undefined") {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.timeout);
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            const errorText = await response.text();
            throw (
              AppError.internalServerError?.(
                `HTTP ${response.status}: ${response.statusText} - ${errorText}`
              ) ||
              new Error(
                `HTTP ${response.status}: ${response.statusText} - ${errorText}`
              )
            );
          }
          return await response.json();
        }
        return await this.makeNodeRequest(url, options);
      } catch (error) {
        lastError = error;
        if (i < this.retries - 1) {
          const delay = this.retryDelay * Math.pow(2, i);
          await this.delay(delay);
        }
      }
    }
    throw lastError;
  }

  async makeNodeRequest(url, options) {
    return new Promise((resolve, reject) => {
      const urlModule = require("url");
      const parsedUrl = new urlModule.URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const httpModule = isHttps ? require("https") : require("http");

      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: this.timeout,
      };

      const req = httpModule.request(requestOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          } catch (err) {
            reject(new Error("Invalid JSON response"));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  getCacheKey(token, resource, action, context) {
    const tokenHash = this.hashToken(token);
    return `${tokenHash}:${resource}:${action}:${JSON.stringify(context)}`;
  }

  hashToken(token) {
    return token.substring(0, 8);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default PolicyClient;
export { PolicyClient };
