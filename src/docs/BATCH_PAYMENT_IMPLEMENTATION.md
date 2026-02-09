# Batch Payment Processing Implementation Guide

## Overview

This guide provides step-by-step instructions for implementing batch payment processing for standing orders and salary deductions. The system must handle:

- **1 to 5,000 payments per batch**
- **Multiple batches running simultaneously**
- **Integration with existing payment/journal system**
- **Resource management via global DB limiter**

## Requirements

### Functional Requirements

1. Process payments in batches (standing orders, salary deductions)
2. Create payment documents for each entry
3. Generate journal entries (receipts) automatically
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
  - Create Payment document
  - Create Journal entry (Receipt)
  - Update MaterializedBalance
  ↓
Return Results (successful, failed, errors)
```

### Components

1. **Controller**: `payment.controller.js` - API endpoint handler
2. **Service**: `batch.payments.service.js` - Business logic
3. **Existing**: `payments.service.js` - `postJournalForPayment` function
4. **Limiter**: `globalLimiter.js` - Resource management

## Implementation Steps

### Step 1: Create Batch Payment Service

Create `src/services/batch.payments.service.js`:

```javascript
import { globalDBLimiter } from "../config/globalLimiter.js";
import Payment from "../models/payment.model.js";
import { postJournalForPayment } from "./payments.service.js";
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
 * Process a batch of payments
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
    "Starting batch payment processing"
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

          // Amount should be in cents
          const amountInCents = Math.round(
            typeof paymentData.amount === "number"
              ? paymentData.amount * 100
              : parseFloat(paymentData.amount) * 100
          );

          // Create payment document
          const payment = await Payment.create({
            tenantId: ctx.tenantId,
            purpose: paymentData.purpose || "subscriptionFee",
            amount: amountInCents, // Store in cents
            currency: paymentData.currency || "eur",
            status: "succeeded", // Batch payments are pre-approved
            mode: batchType, // "standing-order" or "salary-deduction"
            memberId: paymentData.memberId,
            applicationId: paymentData.applicationId,
            invoiceId: paymentData.invoiceId,
            external: {
              externalRef:
                paymentData.externalRef || `${batchId}-${paymentIndex}`,
              batchId: batchId,
            },
            metadata: {
              ...paymentData.metadata,
              batchId,
              batchType,
              paymentIndex,
              processedAt: new Date().toISOString(),
            },
          });

          // Create journal entry (receipt)
          // postJournalForPayment uses global limiter via postBalancedJournal
          await postJournalForPayment(payment, ctx);

          results.successful++;
          return {
            success: true,
            paymentId: payment._id.toString(),
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

### Step 2: Update postJournalForPayment to Handle Batch Types

Update `src/services/payments.service.js` - `postJournalForPayment` function:

```javascript
// Around line 1331, update clearing code logic:
const clearingCode =
  payment.mode === "stripe"
    ? "1220" // Card Gateway Clearing
    : payment.mode === "standing-order"
    ? "1240" // Standing Order Clearing
    : payment.mode === "salary-deduction"
    ? "1230" // Salary Deduction Clearing
    : payment.mode === "direct-debit"
    ? "1250" // Direct Debit Clearing
    : "1210"; // Default: Undeposited Cheques
```

### Step 3: Create Controller Endpoint

Add to `src/controllers/payment.controller.js`:

```javascript
import { processBatchPayments } from "../services/batch.payments.service.js";

/**
 * Process batch payments (standing orders, salary deductions)
 * POST /api/payments/batch
 * Body: {
 *   batchId: string (required),
 *   batchType: "standing-order" | "salary-deduction" | "direct-debit" (required),
 *   payments: Array<{
 *     memberId?: string,
 *     applicationId?: string,
 *     amount: number (in base currency, e.g., 326.00),
 *     currency?: string (default: "eur"),
 *     purpose?: string (default: "subscriptionFee"),
 *     invoiceId?: string,
 *     externalRef?: string,
 *     metadata?: object
 *   }> (required, 1-5000 items)
 * }
 */
export async function processBatchPaymentsController(req, res, next) {
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

### Step 4: Add Route

Add to `src/routes/payment.routes.js` (or create if doesn't exist):

```javascript
import {
  processBatchPaymentsController,
  // ... other imports
} from "../controllers/payment.controller.js";

// Batch payment processing
router.post(
  "/batch",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.payments", "create"),
  processBatchPaymentsController
);
```

### Step 5: Add Validation Rules (Optional but Recommended)

Create validation in `src/validators/payment.validator.js`:

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
    .isFloat({ min: 0.01 })
    .withMessage("amount must be a positive number"),

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
POST /api/payments/batch
Content-Type: application/json
Authorization: Bearer <token>
x-tenant-id: <tenant-id>

{
  "batchId": "SO-2026-001",
  "batchType": "standing-order",
  "payments": [
    {
      "memberId": "B00001",
      "amount": 326.00,
      "currency": "eur",
      "purpose": "subscriptionFee",
      "externalRef": "SO-REF-001"
    },
    {
      "memberId": "B00002",
      "amount": 326.00,
      "currency": "eur",
      "purpose": "subscriptionFee",
      "externalRef": "SO-REF-002"
    }
    // ... up to 5000 payments
  ]
}
```

### Example 2: Salary Deduction Batch

```bash
POST /api/payments/batch
{
  "batchId": "SD-2026-001",
  "batchType": "salary-deduction",
  "payments": [
    {
      "memberId": "B00010",
      "amount": 81.50,
      "currency": "eur",
      "purpose": "subscriptionFee",
      "externalRef": "SD-REF-001"
    }
    // ... more payments
  ]
}
```

### Example 3: Application Payments (Before Approval)

```bash
POST /api/payments/batch
{
  "batchId": "APP-2026-001",
  "batchType": "standing-order",
  "payments": [
    {
      "applicationId": "42f3b6e8-e502-4bf4-872b-746e6a5b17fc",
      "amount": 81.50,
      "currency": "eur",
      "purpose": "subscriptionFee"
    }
  ]
}
```

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
          "amount": 326.0,
          "externalRef": "SO-REF-045"
        }
      },
      {
        "paymentIndex": 67,
        "error": "amount must be greater than 0",
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

## Testing

### Unit Tests

```javascript
// tests/services/batch.payments.service.test.js
import { processBatchPayments } from "../../src/services/batch.payments.service.js";

describe("processBatchPayments", () => {
  it("should process batch of 10 payments successfully", async () => {
    const payments = Array.from({ length: 10 }, (_, i) => ({
      memberId: `B0000${i}`,
      amount: 326.0,
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

describe("POST /api/payments/batch", () => {
  it("should process batch payments", async () => {
    const response = await request(app)
      .post("/api/payments/batch")
      .set("Authorization", `Bearer ${token}`)
      .set("x-tenant-id", "test-tenant")
      .send({
        batchId: "TEST-001",
        batchType: "standing-order",
        payments: [{ memberId: "B00001", amount: 326.0 }],
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
