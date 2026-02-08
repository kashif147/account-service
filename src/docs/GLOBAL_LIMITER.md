# Global Database Operations Limiter

## Overview

The global database operations limiter prevents connection pool exhaustion when multiple heavy operations run simultaneously. This is critical in a microservices architecture where all services share the same MongoDB instance.

## Problem

When multiple heavy operations run concurrently:
- **Batch application approvals** (500 applications) × 100 prefetch = 1,200 concurrent operations
- **Batch payment processing** (5,000 payments) × 100 concurrent = 600 concurrent operations
- **Total**: 1,800 concurrent operations competing for 150 MongoDB connections

This causes:
- Connection pool exhaustion
- Write lock contention
- Slow queries and timeouts
- Database server overload

## Solution

A single shared concurrency limiter (`globalDBLimiter`) that caps total concurrent database operations across all account-service operations.

### Implementation

```javascript
// account-service/src/config/globalLimiter.js
import pLimit from "p-limit";

const GLOBAL_DB_OPERATIONS_LIMIT = parseInt(
  process.env.GLOBAL_DB_OPERATIONS_LIMIT || "120",
  10
);

export const globalDBLimiter = pLimit(GLOBAL_DB_OPERATIONS_LIMIT);
```

### Usage

All database-intensive operations are wrapped in the global limiter:

1. **Journal Operations** (`postBalancedJournal`):
   ```javascript
   export async function postBalancedJournal({...}) {
     return globalDBLimiter(async () => {
       // All DB operations here
     });
   }
   ```

2. **Application Approval** (`handleMemberCreated`):
   ```javascript
   // Pricing lookup
   const { incomeCode, annualFee } = await globalDBLimiter(async () => {
     return await getMembershipPricing({...});
   });
   
   // Invoice creation
   await globalDBLimiter(async () => {
     return await invoice(...);
   });
   
   // Credit claim
   await globalDBLimiter(async () => {
     return await claimApplicationCredit(...);
   });
   ```

3. **Payment Processing** (`postJournalForPayment`):
   - Automatically limited via `postBalancedJournal` wrapper

## Resource Allocation

### Recommended Configuration

```bash
# MongoDB Connection Pool
MONGODB_MAX_POOL_SIZE=150              # Total MongoDB connections
MONGODB_MIN_POOL_SIZE=20               # Minimum connections
MONGODB_MAX_IDLE_TIME_MS=30000         # Idle timeout

# Global DB Operations Limiter
GLOBAL_DB_OPERATIONS_LIMIT=120        # 80% of pool (reserves 30 for other services)

# RabbitMQ Prefetch (reduced to work with limiter)
APPLICATION_EVENTS_PREFETCH=50         # Reduced from 100
MEMBERSHIP_EVENTS_PREFETCH=50          # Reduced from 100
```

### Allocation Strategy

- **Account-service operations**: 120 concurrent (80% of pool)
- **Other services**: 30 connections (20% reserve)
- **Total**: 150 connections

## Benefits

1. **Prevents Pool Exhaustion**: Total operations capped at 120
2. **Fair Resource Sharing**: All operations share the same limit
3. **Prevents Overload**: Protects MongoDB from excessive load
4. **Predictable Performance**: Controlled concurrency
5. **Graceful Degradation**: Operations queue instead of failing

## Monitoring

The limiter provides status information:

```javascript
import { getLimiterStatus } from "../config/globalLimiter.js";

const status = getLimiterStatus();
// {
//   limit: 120,
//   active: 45,    // Currently running operations
//   pending: 23   // Queued operations waiting
// }
```

## Scenarios

### Scenario 1: Batch Application Approval (500 applications)

- **Prefetch**: 50 applications
- **Per application**: ~10-12 DB operations
- **Concurrent operations**: 50 × 12 = 600 operations
- **With limiter**: Capped at 120, operations queue and process sequentially

### Scenario 2: Batch Payment Processing (5,000 payments)

- **Global limiter**: 120 concurrent operations
- **Per payment**: ~5-6 DB operations
- **Concurrent operations**: 120 (capped)
- **Processing**: Payments process in controlled batches

### Scenario 3: Both Running Simultaneously

- **Application approvals**: 50 prefetch × 12 ops = 600 (capped at 120)
- **Payment processing**: 120 concurrent operations
- **Total**: 120 concurrent operations (shared limit)
- **Result**: Fair resource sharing, no pool exhaustion

## Best Practices

1. **Wrap all DB-intensive operations** in the global limiter
2. **Monitor limiter status** during heavy operations
3. **Adjust limits** based on MongoDB server capacity
4. **Reserve connections** for other services (20% of pool)
5. **Reduce prefetch values** to work with limiter

## Troubleshooting

### High Pending Count

If `pending` count is consistently high:
- Increase `GLOBAL_DB_OPERATIONS_LIMIT` (if MongoDB can handle it)
- Increase `MONGODB_MAX_POOL_SIZE` (if server resources allow)
- Optimize slow queries

### Connection Pool Exhaustion

If still seeing connection errors:
- Verify `GLOBAL_DB_OPERATIONS_LIMIT` < `MONGODB_MAX_POOL_SIZE`
- Check other services aren't consuming too many connections
- Consider separate MongoDB instance for account-service

### Slow Performance

If operations are too slow:
- Check MongoDB server resources (CPU, memory, disk)
- Review query performance and indexes
- Consider read replicas for read-heavy operations
