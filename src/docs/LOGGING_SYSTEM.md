# Logging System

## Overview

The logging system provides comprehensive request/response logging and utility functions for application-level logging. It integrates with Pino for structured logging and includes request correlation via request IDs.

## Components

### 1. Logger Middleware (`logger.mw.js`)

Automatically logs all HTTP requests and responses with detailed information.

### 2. Utility Functions

Convenient logging functions for manual logging throughout the application.

## Logger Middleware Features

### Request Logging

- **Method & URL**: HTTP method and full URL
- **Query Parameters**: Request query string
- **Request Body**: Sanitized body for POST/PUT/PATCH requests
- **User Agent**: Client browser/application
- **IP Address**: Client IP address
- **Request ID**: Correlation ID from requestId middleware
- **User ID**: Authenticated user (if available)
- **Tenant ID**: Multi-tenant context (if available)

### Response Logging

- **Status Code**: HTTP response status
- **Duration**: Request processing time
- **Request ID**: Correlation ID
- **User ID**: Authenticated user
- **Tenant ID**: Multi-tenant context

### Data Sanitization

Automatically redacts sensitive fields:

- `password`
- `token`
- `secret`
- `key`
- `authorization`

## Usage

### Automatic Logging

The middleware automatically logs all requests and responses:

```javascript
// In app.js
app.use(loggerMiddleware);
```

### Manual Logging

Use utility functions for application-level logging:

```javascript
import {
  logInfo,
  logWarn,
  logError,
  logDebug,
} from "../middlewares/logger.mw.js";

// Info level
logInfo("User logged in", { userId: "123", method: "oauth" });

// Warning level
logWarn("Rate limit exceeded", { ip: "192.168.1.1", endpoint: "/api/login" });

// Error level
logError("Database connection failed", { error: err.message, retryCount: 3 });

// Debug level
logDebug("Processing invoice", { docNo: "INV001", amount: 100.0 });
```

## Log Output Examples

### Request Log

```json
{
  "level": 30,
  "time": 1642234567890,
  "pid": 12345,
  "hostname": "server-01",
  "method": "POST",
  "url": "/api/journal/invoice",
  "path": "/api/journal/invoice",
  "query": {},
  "userAgent": "Mozilla/5.0...",
  "ip": "192.168.1.100",
  "requestId": "req-123456",
  "user": "user-789",
  "tenantId": "tenant-001",
  "body": {
    "docNo": "INV001",
    "memberId": "member-123",
    "annualFee": 1000.0,
    "password": "[REDACTED]"
  },
  "msg": "Incoming POST /api/journal/invoice"
}
```

### Response Log

```json
{
  "level": 30,
  "time": 1642234567950,
  "pid": 12345,
  "hostname": "server-01",
  "method": "POST",
  "url": "/api/journal/invoice",
  "statusCode": 201,
  "duration": "60ms",
  "requestId": "req-123456",
  "user": "user-789",
  "tenantId": "tenant-001",
  "msg": "Response 201 for POST /api/journal/invoice"
}
```

## Controller Integration

### Example: Journal Controller

```javascript
import { logInfo, logError } from "../middlewares/logger.mw.js";

export async function invoice(req, res, next) {
  try {
    const { docNo, memberId, annualFee } = req.body;

    logInfo("Creating invoice", { docNo, memberId, annualFee });

    const result = await createInvoice(req.body);

    res.created(result);
    logInfo("Invoice created successfully", { docNo, memberId });
  } catch (error) {
    logError("Invoice creation failed", {
      docNo,
      memberId,
      error: error.message,
    });
    next(error);
  }
}
```

### Example: Admin Controller

```javascript
import { logInfo, logWarn } from "../middlewares/logger.mw.js";

export async function listCoA(req, res, next) {
  try {
    logInfo("Listing Chart of Accounts");

    const accounts = await CoA.find({}).sort({ code: 1 });

    res.success({ count: accounts.length, items: accounts });
    logInfo("Chart of Accounts retrieved", { count: accounts.length });
  } catch (error) {
    logError("Failed to retrieve Chart of Accounts", { error: error.message });
    next(error);
  }
}
```

## Configuration

### Log Levels

- **Info**: General application flow
- **Warn**: Potential issues or unusual behavior
- **Error**: Errors that need attention
- **Debug**: Detailed debugging information

### Environment Variables

```bash
# Log level (default: info)
LOG_LEVEL=info

# Pretty print in development
NODE_ENV=development
```

## Best Practices

### 1. Structured Logging

Always include relevant context:

```javascript
// Good
logInfo("User action", { userId: "123", action: "login", method: "oauth" });

// Avoid
logInfo("User logged in");
```

### 2. Error Logging

Include error details and context:

```javascript
logError("Database operation failed", {
  operation: "create",
  table: "users",
  userId: "123",
  error: error.message,
  stack: error.stack,
});
```

### 3. Performance Logging

Log slow operations:

```javascript
const startTime = Date.now();
// ... operation
const duration = Date.now() - startTime;
if (duration > 1000) {
  logWarn("Slow operation detected", {
    operation: "invoice_creation",
    duration: `${duration}ms`,
  });
}
```

### 4. Security Logging

Log security-related events:

```javascript
logWarn("Failed login attempt", {
  ip: req.ip,
  email: req.body.email,
  userAgent: req.get("User-Agent"),
});
```

## Monitoring & Alerting

### Key Metrics to Monitor

- **Error Rate**: Percentage of 4xx/5xx responses
- **Response Time**: Average request duration
- **Request Volume**: Requests per minute
- **User Activity**: Active users and actions

### Alerting Rules

- Error rate > 5%
- Response time > 2 seconds
- Authentication failures > 10 per minute
- Database connection failures

## Integration with External Tools

### Log Aggregation

- **ELK Stack**: Elasticsearch, Logstash, Kibana
- **Splunk**: Enterprise log management
- **CloudWatch**: AWS logging service

### APM Integration

- **New Relic**: Application performance monitoring
- **DataDog**: Infrastructure monitoring
- **AppDynamics**: Application monitoring
