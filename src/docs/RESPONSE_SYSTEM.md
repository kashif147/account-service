# Response Middleware System

## Overview

The response middleware provides consistent API response formatting across all endpoints. It extends the Express response object with convenient methods for standardized success and error responses.

## Response Methods

### Success Responses

#### `res.success(data, message)`

- **Status**: 200 OK
- **Use**: General successful responses

```javascript
res.success({ items: data }, "Data retrieved successfully");
```

#### `res.created(data, message)`

- **Status**: 201 Created
- **Use**: Resource creation responses

```javascript
res.created({ id: newId }, "Invoice created successfully");
```

#### `res.accepted(data, message)`

- **Status**: 202 Accepted
- **Use**: Async processing responses

```javascript
res.accepted({ jobId: "job123" }, "Processing started");
```

### Error Responses

#### `res.fail(message, status, details)`

- **Status**: 400 Bad Request (default)
- **Use**: General error responses

```javascript
res.fail("Invalid input", 400, { field: "email" });
```

#### `res.notFound(message, details)`

- **Status**: 404 Not Found
- **Use**: Resource not found

```javascript
res.notFound("Member not found", { memberId: "123" });
```

#### `res.unauthorized(message, details)`

- **Status**: 401 Unauthorized
- **Use**: Authentication errors

```javascript
res.unauthorized("Invalid credentials");
```

#### `res.forbidden(message, details)`

- **Status**: 403 Forbidden
- **Use**: Authorization errors

```javascript
res.forbidden("Insufficient permissions");
```

#### `res.conflict(message, details)`

- **Status**: 409 Conflict
- **Use**: Duplicate/conflict errors

```javascript
res.conflict("Document already exists");
```

#### `res.validationError(message, details)`

- **Status**: 422 Unprocessable Entity
- **Use**: Validation errors

```javascript
res.validationError("Validation failed", { errors: [...] });
```

#### `res.serverError(message, details)`

- **Status**: 500 Internal Server Error
- **Use**: Server errors

```javascript
res.serverError("Database connection failed");
```

#### `res.appError(error)`

- **Status**: Based on AppError instance
- **Use**: AppError integration

```javascript
res.appError(AppError.badRequest("Invalid input"));
```

## Response Format

### Success Response

```json
{
  "status": "success",
  "message": "Data retrieved successfully",
  "data": { ... },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Error Response

```json
{
  "status": "fail",
  "message": "Validation failed",
  "details": { ... },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Usage Examples

### Controller Implementation

```javascript
export async function createInvoice(req, res, next) {
  try {
    const invoice = await Invoice.create(req.body);
    res.created(invoice, "Invoice created successfully");
  } catch (error) {
    if (error.code === 11000) {
      res.conflict("Invoice number already exists");
    } else {
      next(error);
    }
  }
}

export async function getMember(req, res, next) {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) {
      return res.notFound("Member not found", { memberId: req.params.id });
    }
    res.success(member, "Member retrieved successfully");
  } catch (error) {
    next(error);
  }
}
```

### Route Implementation

```javascript
router.get("/health", (req, res) => {
  res.success({ status: "healthy" });
});

router.post("/data", (req, res) => {
  if (!req.body.required) {
    return res.validationError("Required field missing");
  }
  res.created({ id: "new-id" });
});
```

## Integration with AppError

The middleware seamlessly integrates with the AppError system:

```javascript
// In error handler
if (err instanceof AppError) {
  return res.appError(err);
}

// In controllers
if (!user) {
  throw AppError.notFound("User not found");
}
// Error handler will automatically use res.appError()
```

## Benefits

1. **Consistency**: All responses follow the same format
2. **Convenience**: Simple method calls instead of manual JSON construction
3. **Timestamps**: Automatic timestamp inclusion
4. **Status Codes**: Appropriate HTTP status codes
5. **Error Integration**: Seamless AppError integration
6. **Maintainability**: Centralized response logic

## Migration Guide

### Before (Manual JSON)

```javascript
res.status(201).json({
  id: newId,
  message: "Created",
});
```

### After (Response Middleware)

```javascript
res.created({ id: newId }, "Created successfully");
```

### Before (Error Response)

```javascript
res.status(400).json({
  error: "Bad request",
  details: { field: "email" },
});
```

### After (Response Middleware)

```javascript
res.fail("Bad request", 400, { field: "email" });
```
