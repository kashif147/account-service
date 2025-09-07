# Authorization System Migration Guide

This guide explains how to implement the same authorization mechanism across other services.

## Files to Copy

### 1. Core Authorization Files

#### `/src/config/roleHierarchy.js`

**Copy as-is** - This is the shared role hierarchy that should be identical across all services.

#### `/src/middlewares/auth.js`

**Copy and adapt** - The main authorization middleware. You may need to adjust imports based on your service structure.

#### `/src/middlewares/verifyRoles.js`

**Copy as-is** - Simple role verification middleware.

### 2. Required Dependencies

#### `/src/errors/AppError.js`

**Copy as-is** - Standard error handling class used by authorization middleware.

## Step-by-Step Implementation

### Step 1: Copy Core Files

```bash
# Copy these files to your other service
cp src/config/roleHierarchy.js /path/to/other-service/src/config/
cp src/middlewares/auth.js /path/to/other-service/src/middlewares/
cp src/middlewares/verifyRoles.js /path/to/other-service/src/middlewares/
cp src/errors/AppError.js /path/to/other-service/src/errors/
```

### Step 2: Update Imports in auth.js

Update the import paths in the copied `auth.js` file to match your service structure:

```javascript
// Update these imports based on your service structure
import { AppError } from "../errors/AppError.js";
import {
  ROLE_HIERARCHY,
  getHighestRoleLevel,
  hasMinimumRole,
  isSuperUser,
} from "../config/roleHierarchy.js";
```

### Step 3: Install Required Dependencies

```bash
npm install jsonwebtoken
```

### Step 4: Environment Variables

Ensure your service has the required environment variables:

```env
JWT_SECRET=your-jwt-secret-key
```

### Step 5: Update Route Files

Update your route files to use the new authorization middleware:

```javascript
import express from "express";
import {
  ensureAuthenticated,
  authorizeMin,
  authorizeAny,
  requireRole,
  requirePermission,
  requireAnyPermission,
} from "../middlewares/auth.js";

const router = express.Router();

// Example routes with different authorization levels
router.get("/public", (req, res) => {
  res.json({ message: "Public data" });
});

router.get("/user-data", ensureAuthenticated, (req, res) => {
  res.json({
    message: "User data",
    userId: req.ctx.userId,
    tenantId: req.ctx.tenantId,
  });
});

router.get(
  "/admin-data",
  ensureAuthenticated,
  authorizeMin("AM"), // Accounts Manager or higher
  (req, res) => {
    res.json({ message: "Admin data" });
  }
);

router.post(
  "/sensitive-operation",
  ensureAuthenticated,
  requirePermission("admin:write"),
  (req, res) => {
    res.json({ message: "Operation completed" });
  }
);
```

## Service-Specific Customizations

### 1. Custom Role Hierarchy

If your service needs additional roles, extend the base hierarchy:

```javascript
// In your service's auth.js or separate config file
import { ROLE_HIERARCHY } from "../config/roleHierarchy.js";

const SERVICE_ROLE_HIERARCHY = {
  ...ROLE_HIERARCHY,
  // Add service-specific roles
  SERVICE_ADMIN: 95,
  SERVICE_MANAGER: 80,
  SERVICE_USER: 10,
};

// Update your authorization functions to use SERVICE_ROLE_HIERARCHY
```

### 2. Custom Permissions

Define service-specific permissions in your route files:

```javascript
// Service-specific permissions
const PERMISSIONS = {
  READ_DATA: "service:read",
  WRITE_DATA: "service:write",
  DELETE_DATA: "service:delete",
  ADMIN_ACCESS: "service:admin",
};

// Use in routes
router.get(
  "/data",
  ensureAuthenticated,
  requirePermission(PERMISSIONS.READ_DATA),
  handler
);
```

### 3. Service-Specific Authorization Logic

Create custom authorization middleware for service-specific needs:

```javascript
// Custom middleware for your service
export function requireServiceAdmin(req, res, next) {
  if (!req.ctx || !req.ctx.roles) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Check for service admin role or Super User
  if (req.ctx.roles.includes("SERVICE_ADMIN") || req.ctx.roles.includes("SU")) {
    return next();
  }

  return res.status(403).json({ error: "Service admin access required" });
}
```

## Testing the Implementation

### 1. Test Authentication

```javascript
// Test route
router.get("/test-auth", ensureAuthenticated, (req, res) => {
  res.json({
    message: "Authentication successful",
    user: req.ctx,
  });
});
```

### 2. Test Role Authorization

```javascript
// Test different role levels
router.get(
  "/test-roles",
  ensureAuthenticated,
  authorizeMin("MO"), // Membership Officer or higher
  (req, res) => {
    res.json({
      message: "Role authorization successful",
      userRoles: req.ctx.roles,
    });
  }
);
```

### 3. Test Permission Authorization

```javascript
// Test permission-based access
router.get(
  "/test-permissions",
  ensureAuthenticated,
  requirePermission("test:read"),
  (req, res) => {
    res.json({
      message: "Permission authorization successful",
      userPermissions: req.ctx.permissions,
    });
  }
);
```

## Common Issues and Solutions

### 1. Import Path Issues

**Problem**: Import paths don't match your service structure
**Solution**: Update import paths in copied files to match your directory structure

### 2. Missing Dependencies

**Problem**: `AppError` or other dependencies not found
**Solution**: Copy the required dependency files or install packages

### 3. JWT Secret Mismatch

**Problem**: JWT verification fails
**Solution**: Ensure all services use the same `JWT_SECRET` environment variable

### 4. Token Structure Differences

**Problem**: Token doesn't contain expected fields
**Solution**: Verify your user service is sending tokens with `roles` and `permissions` arrays

## Verification Checklist

- [ ] Copied `roleHierarchy.js` to `/src/config/`
- [ ] Copied `auth.js` to `/src/middlewares/`
- [ ] Copied `verifyRoles.js` to `/src/middlewares/`
- [ ] Copied `AppError.js` to `/src/errors/`
- [ ] Updated import paths in copied files
- [ ] Installed `jsonwebtoken` dependency
- [ ] Set `JWT_SECRET` environment variable
- [ ] Updated route files to use new middleware
- [ ] Tested authentication with valid token
- [ ] Tested role-based authorization
- [ ] Tested permission-based authorization
- [ ] Verified error handling works correctly

## Example Complete Implementation

Here's a minimal example of how to set up authorization in a new service:

```javascript
// src/middlewares/auth.js (copied and adapted)
import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";
import {
  ROLE_HIERARCHY,
  getHighestRoleLevel,
  hasMinimumRole,
  isSuperUser,
} from "../config/roleHierarchy.js";

// ... (rest of the auth.js content)

// src/routes/example.routes.js
import express from "express";
import {
  ensureAuthenticated,
  authorizeMin,
  requirePermission,
} from "../middlewares/auth.js";

const router = express.Router();

router.get("/", ensureAuthenticated, (req, res) => {
  res.json({ message: "Hello from service", user: req.ctx });
});

router.get("/admin", ensureAuthenticated, authorizeMin("AM"), (req, res) => {
  res.json({ message: "Admin access granted" });
});

export default router;
```

This implementation provides the same robust authorization system across all your services while allowing for service-specific customizations.
