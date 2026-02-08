// Global concurrency limiter for all account-service database operations
// This ensures total concurrent operations don't exceed MongoDB connection pool
// and prevents resource contention when multiple heavy operations run simultaneously

import pLimit from "p-limit";
import logger from "./logger.js";

// Global limiter for ALL account-service database operations
// Reserve some connections for other services and operations
// Default: 120 (80% of typical 150 connection pool)
const GLOBAL_DB_OPERATIONS_LIMIT = parseInt(
  process.env.GLOBAL_DB_OPERATIONS_LIMIT || "120",
  10
);

// Single shared limiter for all account-service operations
// This ensures that:
// - Application approvals (batch of 500)
// - Payment batch processing (batch of 5000)
// - Individual payment processing
// - Other concurrent operations
// All share the same resource pool
export const globalDBLimiter = pLimit(GLOBAL_DB_OPERATIONS_LIMIT);

// Log limiter configuration on module load
logger.info(
  {
    limit: GLOBAL_DB_OPERATIONS_LIMIT,
    description:
      "Global DB operations limiter initialized - shared across all account-service operations",
  },
  "Global DB limiter configured"
);

// Helper function to get current limiter status (for monitoring)
export function getLimiterStatus() {
  return {
    limit: GLOBAL_DB_OPERATIONS_LIMIT,
    active: globalDBLimiter.activeCount,
    pending: globalDBLimiter.pendingCount,
  };
}

// Helper to wrap any async DB operation with global limit
export async function withGlobalLimit(fn) {
  return globalDBLimiter(fn);
}
