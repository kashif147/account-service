/**
 * Centralized RBAC Policy Middleware
 * Uses shared policy middleware package
 */

import { createDefaultPolicyMiddleware } from "@membership/policy-middleware";

const policyServiceUrl =
  process.env.POLICY_SERVICE_URL || "http://localhost:3000";

// Warn if using default localhost URL in non-development environments
if (!process.env.POLICY_SERVICE_URL && process.env.NODE_ENV !== "development") {
  console.warn(
    "⚠️  WARNING: POLICY_SERVICE_URL not set. Using default localhost URL.",
    "This will cause policy evaluation to fail in Azure/staging environments.",
    "Please set POLICY_SERVICE_URL in your Azure App Service Application Settings."
  );
} else {
  console.log(`✅ Policy service URL configured: ${policyServiceUrl}`);
}

// Create default policy middleware instance
const defaultPolicyMiddleware = createDefaultPolicyMiddleware(
  policyServiceUrl,
  {
    timeout: 15000, // Increased timeout for Azure
    retries: 5, // More retries for Azure
    cacheTimeout: 300000, // 5 minutes
    retryDelay: 2000, // Base delay between retries
  }
);

export default defaultPolicyMiddleware;
export { defaultPolicyMiddleware };
