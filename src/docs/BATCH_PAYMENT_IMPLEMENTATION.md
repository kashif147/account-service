# Batch Payment Processing Implementation Guide

## Overview

This guide provides step-by-step instructions for implementing batch payment processing for standing orders and salary deductions. The system must handle:

- **1 to 5,000 payments per batch**
- **Multiple batches running simultaneously**
- **Integration with existing payment/journal system**
- **Resource management via global DB limiter**

## Money Handling Standards

**IMPORTANT**: Money follows strict standards to avoid rounding bugs and audit issues:

- **Backend storage**: MongoDB stores money as **Number (integers in minor units)** - e.g., 32600 for €326.00
- **API transfer**: Money is transferred as **minor units (integers)** - e.g., 32600 cents for €326.00
- **Frontend**: Performs integer math only
- **Formatting**: Happens only at the UI layer (convert cents to euros for display)
- **No conversions in backend**: Never divide or multiply by 100 in the backend - amounts are always stored and processed as integer cents
- **Display only**: Conversion to euros (divide by 100) happens only in API responses for display purposes

## Requirements

### Functional Requirements

1. Process payments in batches (standing orders, salary deductions)
2. Create GLTransaction receipts directly (no Payment documents)
3. Handle amounts as integers (minor units) - no currency conversions
4. Handle errors gracefully (continue processing on individual failures)
5. Return detailed results (successful, failed, errors)

### Non-Functional Requirements

1. Use global DB limiter to prevent connection pool exhaustion
2. Process in chunks to avoid memory issues
3. Support concurrent batch processing
4. Provide progress logging
5. Idempotent operations (retry-safe)

## Architecture

### Flow

```
Batch Payment Request
  ↓
Validate & Parse Batch
  ↓
Process in Chunks (100 payments/chunk)
  ↓
For each payment:
  - Generate deterministic docNo
  - Check for existing receipt (idempotency)
  - Create GLTransaction receipt directly
  - Update MaterializedBalance
  ↓
Return Results (successful, failed, errors)
```

### Components

1. **Controller**: `journal.controller.js` - API endpoint handler
2. **Service**: `batch.payments.service.js` - Business logic (creates GLTransaction receipts directly)
3. **Existing**: `journal.controller.js` - `postBalancedJournal` function
4. **Limiter**: `globalLimiter.js` - Resource management

## Implementation Steps

### Step 1: Create Batch Payment Service

Create `src/services/batch.payments.service.js`:

```javascript
import { globalDBLimiter } from "../config/globalLimiter.js";
import { postBalancedJournal } from "../controllers/journal.controller.js";
import GLTransaction from "../models/glTransaction.model.js";
import logger from "../config/logger.js";

// Chunk size for processing (configurable)
const CHUNK_SIZE = parseInt(process.env.BATCH_PAYMENT_CHUNK_SIZE || "100", 10);

// Map batch type to clearing code
const BATCH_TYPE_TO_CLEARING = {
  "standing-order": "1240", // Standing Order Clearing
  "salary-deduction": "1230", // Salary Deduction Clearing
  "direct-debit": "1250", // Direct Debit Clearing
};

/**
 * Generate deterministic, unique docNo for receipt
 * @param {string} batchId - Batch identifier
 * @param {Object} paymentData - Payment data
 * @param {number} paymentIndex - Payment index in batch
 * @returns {string} Unique docNo
 */
function generateDocNo(batchId, paymentData, paymentIndex) {
  // Option 1: Use externalRef if provided (most reliable for idempotency)
  if (paymentData.externalRef) {
    return `RCP-${batchId}-${paymentData.externalRef}`;
  }

  // Option 2: Use memberId/applicationId + amount (integer) + date (deterministic)
  // Amount is already in minor units (integer), no conversion needed
  const identifier = paymentData.memberId || paymentData.applicationId;
  const date = paymentData.date || new Date().toISOString().split("T")[0];
  const amount = paymentData.amount; // Integer in minor units (e.g., 32600)
  return `RCP-${batchId}-${identifier}-${amount}-${date}`;

  // Option 3: Fallback to timestamp + index (less ideal, but unique)
  // return `RCP-${batchId}-${Date.now()}-${paymentIndex}`;
}

/**
 * Process a batch of payments (creates GLTransaction receipts directly)
 * @param {string} batchId - Unique batch identifier
 * @param {string} batchType - "standing-order" | "salary-deduction" | "direct-debit"
 * @param {Array} payments - Array of payment data objects
 * @param {Object} ctx - Context { tenantId, userId }
 * @returns {Promise<Object>} Results with successful, failed, errors
 */
export async function processBatchPayments(batchId, batchType, payments, ctx) {
  const startTime = Date.now();
  const clearingCode = BATCH_TYPE_TO_CLEARING[batchType];

  if (!clearingCode) {
    throw new Error(`Invalid batch type: ${batchType}`);
  }

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error("Payments array is required and must not be empty");
  }

  logger.info(
    {
      batchId,
      batchType,
      clearingCode,
      totalPayments: payments.length,
      globalLimit: globalDBLimiter.activeCount,
    },
    "Starting batch payment processing (GLTransaction receipts)"
  );

  const results = {
    batchId,
    total: payments.length,
    successful: 0,
    failed: 0,
    errors: [],
  };

  // Process in chunks to avoid memory issues
  for (let i = 0; i < payments.length; i += CHUNK_SIZE) {
    const chunk = payments.slice(i, i + CHUNK_SIZE);
    const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(payments.length / CHUNK_SIZE);

    logger.info(
      {
        batchId,
        chunkNumber,
        totalChunks,
        chunkSize: chunk.length,
        globalActive: globalDBLimiter.activeCount,
        globalPending: globalDBLimiter.pendingCount,
      },
      `Processing chunk ${chunkNumber}/${totalChunks}`
    );

    // Process chunk using GLOBAL limiter (shared across all batches)
    const chunkPromises = chunk.map((paymentData, index) =>
      globalDBLimiter(async () => {
        const paymentIndex = i + index;
        try {
          // Validate payment data
          if (!paymentData.memberId && !paymentData.applicationId) {
            throw new Error("memberId or applicationId required");
          }
          if (!paymentData.amount || paymentData.amount <= 0) {
            throw new Error("amount must be greater than 0");
          }

          // Amount must be an integer (minor units - e.g., cents)
          // API receives amounts as integers, no conversion needed
          if (!Number.isInteger(paymentData.amount)) {
            throw new Error("amount must be an integer (minor units)");
          }

          const amount = paymentData.amount; // Already in minor units (e.g., 32600 for €326.00)

          // Generate deterministic docNo
          const docNo = generateDocNo(batchId, paymentData, paymentIndex);

          // RACE CONDITION FIX: Check for existing receipt before creating
          const existingReceipt = await GLTransaction.findOne({ docNo }).lean();
          if (existingReceipt) {
            logger.info(
              {
                batchId,
                docNo,
                existingId: existingReceipt._id,
                paymentIndex,
              },
              "Receipt already exists - skipping (idempotency)"
            );
            results.successful++;
            return {
              success: true,
              docNo,
              paymentIndex,
              skipped: true,
            };
          }

          // Build receipt lines (amount is already in minor units)
          const entry2020 = {
            accountCode: "2020",
            dc: "C",
            amount: amount, // Integer in minor units (e.g., 32600)
            periodBucket: paymentData.bucket || "current",
          };

          // Prioritize applicationId over memberId
          if (paymentData.applicationId) {
            entry2020.applicationId = paymentData.applicationId;
          } else if (paymentData.memberId) {
            entry2020.memberId = paymentData.memberId;
          }

          const lines = [
            { accountCode: clearingCode, dc: "D", amount: amount }, // Integer in minor units
            entry2020, // Payment on Account - Member credits (2020)
          ];

          // Create receipt memo
          const memo = paymentData.applicationId
            ? `Receipt (app ${paymentData.applicationId}) - ${batchType}`
            : paymentData.memberId
            ? `Receipt (member ${paymentData.memberId}) - ${batchType}`
            : `Receipt - ${batchType}`;

          // Create receipt via postBalancedJournal
          // This function handles duplicate key errors (E11000) internally
          const receipt = await postBalancedJournal({
            date: paymentData.date || new Date().toISOString().split("T")[0],
            docType: "Receipt",
            docNo,
            memo,
            lines,
            settlement: null, // Batch payments don't have settlement
          });

          results.successful++;
          return {
            success: true,
            docNo: receipt.docNo,
            paymentIndex,
          };
        } catch (error) {
          results.failed++;
          const errorInfo = {
            paymentIndex,
            error: error.message,
            paymentData: {
              memberId: paymentData.memberId,
              applicationId: paymentData.applicationId,
              amount: paymentData.amount,
              externalRef: paymentData.externalRef,
            },
          };
          results.errors.push(errorInfo);

          logger.error(
            { batchId, ...errorInfo },
            "Failed to process payment in batch"
          );

          return { success: false, error: error.message, paymentIndex };
        }
      })
    );

    await Promise.all(chunkPromises);

    // Log progress
    logger.info(
      {
        batchId,
        chunkNumber,
        totalChunks,
        progress: `${results.successful + results.failed}/${results.total}`,
        globalActive: globalDBLimiter.activeCount,
        globalPending: globalDBLimiter.pendingCount,
      },
      `Completed chunk ${chunkNumber}/${totalChunks}`
    );
  }

  const duration = Date.now() - startTime;
  logger.info(
    {
      batchId,
      total: results.total,
      successful: results.successful,
      failed: results.failed,
      duration: `${duration}ms`,
      avgTimePerPayment: `${Math.round(duration / results.total)}ms`,
    },
    "Batch payment processing completed"
  );

  return results;
}
```

### Step 2: Fix postBalancedJournal Race Condition

Update `src/controllers/journal.controller.js` - `postBalancedJournal` function to handle duplicate key errors:

```javascript
// Around line 128, wrap GLTransaction.create in try-catch:
try {
  // strip helper and persist
  const entries = enriched.map(({ _a, ...rest }) => rest);
  const txn = await GLTransaction.create({
    date,
    docType,
    docNo,
    memo,
    entries,
    ...(settlement && { settlement }),
  });

  const { year, totals } = rollupMemberBalances({ date, entries });
  if (totals.size) {
    const ops = [];
    for (const [key, amount] of totals.entries()) {
      const [memberId, accountCode, bucket] = key.split("|");
      ops.push({
        updateOne: {
          filter: { memberId, accountCode, bucket, year },
          update: {
            $inc: { amount },
            $set: { updatedAt: new Date() },
          },
          upsert: true,
        },
      });
    }
    await MaterializedBalance.bulkWrite(ops, { ordered: false });
  }

  // Publish journal created event
  await publishDomainEvent(
    EVENT_TYPES.JOURNAL_CREATED,
    {
      journalId: txn._id,
      docNo: txn.docNo,
      docType: txn.docType,
      date: txn.date,
      memo: txn.memo,
      entries: txn.entries,
      totalDebit: deb,
      totalCredit: cre,
    },
    {
      source: "journal.controller",
      operation: "postBalancedJournal",
    }
  );

  // add a friendly label in the response
  const obj = txn.toObject();
  obj.entries = obj.entries.map((e) => ({
    ...e,
    accountLabel: `${e.accountCode} (${e.accountName})`,
  }));
  return obj;
} catch (error) {
  // Handle duplicate key error (E11000) - race condition protection
  if (error.code === 11000 && error.keyPattern?.docNo) {
    // Another process created this docNo - fetch and return it
    const existing = await GLTransaction.findOne({ docNo }).lean();
    if (existing) {
      logger.info(
        { docNo, existingId: existing._id },
        "Duplicate docNo detected (race condition) - returning existing transaction"
      );

      // Still update MaterializedBalance to ensure consistency
      // (in case the other process didn't complete balance update)
      const { year, totals } = rollupMemberBalances({ date, entries });
      if (totals.size) {
        const ops = [];
        for (const [key, amount] of totals.entries()) {
          const [memberId, accountCode, bucket] = key.split("|");
          ops.push({
            updateOne: {
              filter: { memberId, accountCode, bucket, year },
              update: {
                $inc: { amount },
                $set: { updatedAt: new Date() },
              },
              upsert: true,
            },
          });
        }
        await MaterializedBalance.bulkWrite(ops, { ordered: false });
      }

      // Return existing transaction with enriched entries
      const existingEnriched = await enrichLines(existing.entries);
      const obj = existing.toObject();
      obj.entries = existingEnriched.map((e) => ({
        ...e,
        accountLabel: `${e.accountCode} (${e.accountName})`,
      }));
      return obj;
    }
  }
  throw error;
}
```

### Step 3: Create Controller Endpoint

Add to `src/controllers/journal.controller.js` (or create separate batch controller):

```javascript
import { processBatchPayments } from "../services/batch.payments.service.js";

/**
 * Process batch payments (standing orders, salary deductions)
 * Creates GLTransaction receipts directly (no Payment documents)
 * POST /api/journal/batch-receipts
 * Body: {
 *   batchId: string (required),
 *   batchType: "standing-order" | "salary-deduction" | "direct-debit" (required),
 *   payments: Array<{
 *     memberId?: string,
 *     applicationId?: string,
 *     amount: number (integer, minor units - e.g., 32600 for €326.00),
 *     date?: string (ISO date, default: today),
 *     bucket?: string (default: "current"),
 *     externalRef?: string (recommended for idempotency),
 *     metadata?: object
 *   }> (required, 1-5000 items)
 * }
 */
export async function processBatchReceiptsController(req, res, next) {
  try {
    const { batchId, batchType, payments } = req.body || {};

    // Validation
    if (!batchId || typeof batchId !== "string") {
      return res.appError(AppError.badRequest("batchId (string) is required"));
    }

    if (
      !batchType ||
      !["standing-order", "salary-deduction", "direct-debit"].includes(
        batchType
      )
    ) {
      return res.appError(
        AppError.badRequest(
          'batchType must be one of: "standing-order", "salary-deduction", "direct-debit"'
        )
      );
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      return res.appError(
        AppError.badRequest("payments array is required and must not be empty")
      );
    }

    if (payments.length > 5000) {
      return res.appError(
        AppError.badRequest("Maximum 5000 payments per batch")
      );
    }

    // Process batch
    const results = await processBatchPayments(
      batchId,
      batchType,
      payments,
      req.ctx
    );

    res.success(results);
  } catch (e) {
    next(e);
  }
}
```

### Step 3: Add Route

Add to `src/routes/payment.routes.js` (or create if doesn't exist):

```javascript
import {
  processBatchReceiptsController,
  // ... other imports
} from "../controllers/journal.controller.js";

// Batch receipt processing
router.post(
  "/batch-receipts",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  processBatchReceiptsController
);
```

### Step 4: Add Validation Rules (Optional but Recommended)

Create validation in `src/validators/journal.validator.js`:

```javascript
import { body } from "express-validator";

export const batchPaymentRules = [
  body("batchId")
    .notEmpty()
    .withMessage("batchId is required")
    .isString()
    .withMessage("batchId must be a string")
    .trim(),

  body("batchType")
    .notEmpty()
    .withMessage("batchType is required")
    .isIn(["standing-order", "salary-deduction", "direct-debit"])
    .withMessage(
      'batchType must be one of: "standing-order", "salary-deduction", "direct-debit"'
    ),

  body("payments")
    .isArray({ min: 1, max: 5000 })
    .withMessage("payments must be an array with 1-5000 items"),

  body("payments.*.amount")
    .isInt({ min: 1 })
    .withMessage(
      "amount must be a positive integer (minor units, e.g., 32600 for €326.00)"
    ),

  body("payments.*.memberId")
    .optional()
    .isString()
    .withMessage("memberId must be a string"),

  body("payments.*.applicationId")
    .optional()
    .isString()
    .withMessage("applicationId must be a string"),

  body("payments.*").custom((payment) => {
    if (!payment.memberId && !payment.applicationId) {
      throw new Error("Either memberId or applicationId is required");
    }
    return true;
  }),
];
```

Then use in route:

```javascript
router.post(
  "/batch",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.payments", "create"),
  batchPaymentRules,
  validate,
  processBatchPaymentsController
);
```

## Environment Variables

Add to `.env` files:

```bash
# Batch Payment Processing
BATCH_PAYMENT_CHUNK_SIZE=100  # Payments per chunk (default: 100)

# Global DB Limiter (already configured)
GLOBAL_DB_OPERATIONS_LIMIT=120  # Max concurrent operations
```

## API Usage Examples

### Example 1: Standing Order Batch (100 payments)

```bash
POST /api/journal/batch-receipts
Content-Type: application/json
Authorization: Bearer <token>
x-tenant-id: <tenant-id>

{
  "batchId": "SO-2026-001",
  "batchType": "standing-order",
  "payments": [
    {
      "memberId": "B00001",
      "amount": 32600,
      "date": "2026-01-15",
      "externalRef": "SO-REF-001"
    },
    {
      "memberId": "B00002",
      "amount": 32600,
      "date": "2026-01-15",
      "externalRef": "SO-REF-002"
    }
    // ... up to 5000 payments
  ]
}
```

**Note**: `amount` is in minor units (integers). 32600 = €326.00. `externalRef` is recommended for idempotency.

### Example 2: Salary Deduction Batch

```bash
POST /api/journal/batch-receipts
{
  "batchId": "SD-2026-001",
  "batchType": "salary-deduction",
  "payments": [
    {
      "memberId": "B00010",
      "amount": 8150,
      "date": "2026-01-15",
      "externalRef": "SD-REF-001"
    }
    // ... more payments
  ]
}
```

**Note**: 8150 = €81.50 (3 months fee)

### Example 3: Application Payments (Before Approval)

```bash
POST /api/journal/batch-receipts
{
  "batchId": "APP-2026-001",
  "batchType": "standing-order",
  "payments": [
    {
      "applicationId": "42f3b6e8-e502-4bf4-872b-746e6a5b17fc",
      "amount": 8150,
      "date": "2026-01-15"
    }
  ]
}
```

**Note**: If `externalRef` is not provided, system generates docNo from `applicationId + amount + date`.

## Response Format

```json
{
  "status": "success",
  "data": {
    "batchId": "SO-2026-001",
    "total": 100,
    "successful": 98,
    "failed": 2,
    "errors": [
      {
        "paymentIndex": 45,
        "error": "memberId or applicationId required",
        "paymentData": {
          "amount": 32600,
          "externalRef": "SO-REF-045"
        }
      },
      {
        "paymentIndex": 67,
        "error": "amount must be a positive integer",
        "paymentData": {
          "memberId": "B00067",
          "amount": 0
        }
      }
    ]
  }
}
```

## Error Handling

### Individual Payment Failures

- **Continue processing**: Individual payment failures don't stop the batch
- **Log errors**: Each error is logged and included in response
- **Return results**: Response includes successful count, failed count, and error details

### Batch-Level Failures

- **Invalid batch type**: Returns 400 Bad Request
- **Empty payments array**: Returns 400 Bad Request
- **Too many payments**: Returns 400 Bad Request (max 5000)
- **Missing batchId**: Returns 400 Bad Request

## Race Condition Protection

### Idempotency via docNo

The system uses deterministic `docNo` generation to ensure idempotency:

1. **Primary**: Uses `externalRef` if provided: `RCP-{batchId}-{externalRef}`
2. **Fallback**: Uses `memberId/applicationId + amount (integer) + date`: `RCP-{batchId}-{identifier}-{amount}-{date}`
3. **Database**: `docNo` has unique constraint in GLTransaction model

### Duplicate Prevention Layers

1. **Pre-check**: Before creating, check if `docNo` already exists
2. **Database constraint**: MongoDB unique index on `docNo` prevents duplicates
3. **Error handling**: Catch E11000 (duplicate key) errors in `postBalancedJournal` and return existing transaction
4. **Balance consistency**: Update MaterializedBalance even when returning existing transaction

### Concurrent Batch Processing

- Multiple batches can run simultaneously
- Each batch uses global DB limiter (shared 120-operation limit)
- `docNo` uniqueness ensures no duplicate receipts
- MaterializedBalance updates are atomic (`$inc` operations)

## Testing

### Unit Tests

```javascript
// tests/services/batch.payments.service.test.js
import { processBatchPayments } from "../../src/services/batch.payments.service.js";

describe("processBatchPayments", () => {
  it("should process batch of 10 payments successfully", async () => {
    const payments = Array.from({ length: 10 }, (_, i) => ({
      memberId: `B0000${i}`,
      amount: 32600, // Minor units (€326.00)
    }));

    const results = await processBatchPayments(
      "TEST-001",
      "standing-order",
      payments,
      { tenantId: "test-tenant" }
    );

    expect(results.successful).toBe(10);
    expect(results.failed).toBe(0);
  });
});
```

### Integration Tests

```javascript
// tests/integration/batch-payments.test.js
import request from "supertest";
import app from "../../bin/account-service.js";

describe("POST /api/journal/batch-receipts", () => {
  it("should process batch receipts", async () => {
    const response = await request(app)
      .post("/api/journal/batch-receipts")
      .set("Authorization", `Bearer ${token}`)
      .set("x-tenant-id", "test-tenant")
      .send({
        batchId: "TEST-001",
        batchType: "standing-order",
        payments: [{ memberId: "B00001", amount: 32600 }], // Minor units
      });

    expect(response.status).toBe(200);
    expect(response.body.data.successful).toBe(1);
  });
});
```

## Monitoring

### Logs to Monitor

- Batch start/completion
- Chunk processing progress
- Global limiter status (active/pending)
- Individual payment failures
- Processing duration

### Metrics to Track

- Batch processing time
- Average time per payment
- Success/failure rates
- Global limiter utilization
- Database connection pool usage

## Performance Considerations

### Chunk Size

- **Default**: 100 payments per chunk
- **Adjust based on**: Payment complexity, database performance
- **Too large**: Memory issues, long-running transactions
- **Too small**: Overhead from chunk management

### Concurrent Batches

- **Global limiter**: Automatically manages concurrent operations
- **Multiple batches**: Share the same 120-operation limit
- **Fair distribution**: All batches progress concurrently

### Database Operations

- **Per payment**: ~5-6 DB operations
- **With limiter**: Max 120 concurrent operations
- **Connection pool**: 150 connections (120 for account-service)

## Troubleshooting

### Issue: Slow Processing

- **Check**: Global limiter status (active/pending)
- **Check**: Database connection pool usage
- **Solution**: Increase `GLOBAL_DB_OPERATIONS_LIMIT` if MongoDB can handle it

### Issue: Memory Errors

- **Check**: Chunk size
- **Solution**: Reduce `BATCH_PAYMENT_CHUNK_SIZE`

### Issue: Connection Pool Exhaustion

- **Check**: Other services consuming connections
- **Solution**: Verify `GLOBAL_DB_OPERATIONS_LIMIT` < `MONGODB_MAX_POOL_SIZE`

### Issue: Duplicate Payments

- **Check**: Idempotency (batchId + externalRef)
- **Solution**: Ensure unique batchId and externalRef per payment

## Best Practices

1. **Always provide batchId**: Use unique, traceable identifiers
2. **Include externalRef**: For reconciliation with external systems
3. **Validate before processing**: Catch errors early
4. **Log extensively**: For debugging and audit trails
5. **Handle errors gracefully**: Continue processing on individual failures
6. **Monitor limiter status**: During heavy batch processing
7. **Test with realistic data**: Use production-like volumes in staging

## Next Steps

1. Implement the service (`batch.payments.service.js`)
2. Update `postJournalForPayment` clearing code logic
3. Add controller endpoint
4. Add route and validation
5. Write unit and integration tests
6. Test with small batches (10-100 payments)
7. Test with large batches (1000-5000 payments)
8. Test concurrent batches
9. Monitor performance and adjust chunk size if needed
10. Deploy to staging and verify

## Questions?

Contact the team lead or refer to:

- `src/docs/GLOBAL_LIMITER.md` - Global limiter documentation
- `src/services/payments.service.js` - Existing payment service
- `src/controllers/journal.controller.js` - Journal entry creation
