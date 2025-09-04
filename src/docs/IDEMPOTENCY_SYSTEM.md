# Idempotency System

## Overview

The idempotency middleware ensures that duplicate requests with the same `Idempotency-Key` return the same response, preventing duplicate data creation or modifications.

## How It Works

### Request Flow

1. Client sends request with `Idempotency-Key` header
2. Middleware checks if key exists in cache
3. If cached: Returns cached response (200 status)
4. If not cached: Processes request and caches response
5. Cache expires after 5 minutes (300,000ms)

### Key Validation

- **Length**: 8-128 characters
- **Format**: Any valid string
- **Required**: Optional (if missing, request proceeds normally)

## Usage

### Client Request

```bash
curl -X POST /api/journal/invoice \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: inv-2024-001" \
  -H "Content-Type: application/json" \
  -d '{"date": "2024-01-15", "docNo": "INV001", ...}'
```

### Route Integration

```javascript
import { idempotency } from "../middlewares/idempotency.js";

// Apply to POST routes that create/modify data
router.post(
  "/invoice",
  ensureAuthenticated,
  authorizeMin("User"),
  idempotency(), // <-- Add here
  invoiceRules,
  validate,
  invoice
);
```

## Applied Routes

### Journal Operations (All POST routes)

- `/api/journal/invoice` - Create invoice
- `/api/journal/receipt` - Record receipt
- `/api/journal/credit-note` - Create credit note
- `/api/journal/writeoff` - Write off debt
- `/api/journal/change-category` - Change membership category
- `/api/journal/claim-credit` - Claim application credit

### Admin Operations

- `/api/admin/coa` - Create chart of accounts (example)

## Error Responses

### Invalid Key Format

```json
{
  "error": {
    "message": "Invalid Idempotency-Key format",
    "code": "BAD_REQUEST",
    "status": 400,
    "idempotencyError": true,
    "keyLength": 5,
    "expectedRange": "8-128 characters"
  }
}
```

## Best Practices

### Key Generation

- Use unique, deterministic keys
- Include timestamp and request identifier
- Examples:
  - `inv-2024-001-${memberId}`
  - `receipt-${date}-${memberId}-${amount}`
  - `credit-${docNo}-${timestamp}`

### Client Implementation

```javascript
// Generate idempotency key
const idempotencyKey = `invoice-${Date.now()}-${memberId}`;

// Make request
const response = await fetch("/api/journal/invoice", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": idempotencyKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(data),
});
```

## Utility Functions

### Clear Cache (Testing)

```javascript
import { clearIdempotencyCache } from "../middlewares/idempotency.js";

// Clear all cached responses
clearIdempotencyCache();
```

### Monitor Cache Size

```javascript
import { getIdempotencyCacheSize } from "../middlewares/idempotency.js";

// Get current cache size
const cacheSize = getIdempotencyCacheSize();
console.log(`Idempotency cache size: ${cacheSize}`);
```

## Security Considerations

- **Key Uniqueness**: Ensure keys are unique per operation
- **Key Exposure**: Don't expose sensitive data in keys
- **Cache Duration**: 5-minute TTL balances consistency vs memory usage
- **Memory Usage**: Monitor cache size in production

## Monitoring

### Cache Metrics

- Cache hit rate
- Cache size over time
- Memory usage
- Key collision rate

### Health Check Endpoint

```javascript
router.get("/health/idempotency", (req, res) => {
  res.json({
    cacheSize: getIdempotencyCacheSize(),
    status: "healthy",
  });
});
```
