# Authentication & Authorization System

## Overview

The account service uses JWT-based authentication with role-based authorization. All authentication errors use the AppError standard for consistent error responses.

## Role Hierarchy

```javascript
const ROLES_LIST = {
  Admin: 3, // Highest privileges
  Editor: 2, // Can modify data
  User: 1, // Basic access
};
```

## Middleware Functions

### Authentication

- `ensureAuthenticated` - Verifies JWT token and sets `req.user` and `req.tenantId`

### Authorization

- `authorizeMin(role)` - Requires minimum role level (inclusive)
- `authorizeAny(...roles)` - Requires any of the specified roles
- `requireRole(role)` - Requires exact role match

### Utility Functions

- `hasRole(user, role)` - Check if user has specific role
- `hasMinRole(user, minRole)` - Check if user has minimum role
- `getUserRoleLevel(user)` - Get user's role level number

## Usage Examples

### Route Protection

```javascript
import {
  ensureAuthenticated,
  authorizeMin,
  authorizeAny,
  requireRole,
} from "../middlewares/auth.js";

// Minimum role required
router.get("/data", ensureAuthenticated, authorizeMin("User"), controller);

// Exact role required
router.get("/admin", ensureAuthenticated, requireRole("Admin"), controller);

// Multiple roles accepted
router.get(
  "/reports",
  ensureAuthenticated,
  authorizeAny("Editor", "Admin"),
  controller
);
```

### Controller-Level Checks

```javascript
import { hasRole, hasMinRole } from "../middlewares/auth.js";

export async function someController(req, res, next) {
  // Check specific role
  if (!hasRole(req.user, "Admin")) {
    throw AppError.badRequest("Admin access required");
  }

  // Check minimum role
  if (!hasMinRole(req.user, "Editor")) {
    throw AppError.badRequest("Editor or higher required");
  }
}
```

## Error Responses

All auth errors return structured responses:

```json
{
  "error": {
    "message": "Insufficient permissions",
    "code": "BAD_REQUEST",
    "status": 400,
    "forbidden": true,
    "userRole": "User",
    "requiredRoles": ["Editor", "Admin"]
  }
}
```

## JWT Token Format

```javascript
{
  "id": "user_id",
  "role": "Admin", // or "Editor", "User"
  "tenantId": "tenant_id"
}
```

## Security Notes

- All routes require authentication unless explicitly public
- Role checks happen after authentication
- Tenant isolation via `req.tenantId`
- JWT tokens validated on every request
