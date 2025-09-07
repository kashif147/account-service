# Authorization System Documentation

## Overview

The account service uses a comprehensive role-based and permission-based authorization system that integrates with the user service's JWT tokens. The system supports both role hierarchy and granular permissions for fine-grained access control.

## Token Structure

The JWT token from the user service contains the following claims:

- `tid`: Tenant ID for multi-tenancy
- `sub` or `id`: User ID
- `roles`: Array of role codes (e.g., `["AM", "MO"]`)
- `permissions`: Array of permissions (e.g., `["financial:read", "admin:write"]`)

## Role Hierarchy

The authorization system uses a role hierarchy defined in `/src/config/roleHierarchy.js`. This file can be shared across services for consistent authorization logic.

### Importing Role Hierarchy

```javascript
import {
  ROLE_HIERARCHY,
  getRoleLevel,
  getHighestRoleLevel,
  hasMinimumRole,
  isSuperUser,
} from "../config/roleHierarchy.js";
```

### Available Functions

- `getRoleLevel(roleCode)` - Get privilege level for a role
- `getHighestRoleLevel(roles)` - Get highest level from array of roles
- `hasMinimumRole(userRoles, minRole)` - Check if user meets minimum requirement
- `isSuperUser(userRoles)` - Check if user has Super User privileges
- `getRolesAtOrAbove(minLevel)` - Get all roles at or above a level
- `getRoleHierarchySorted()` - Get sorted hierarchy array

### Role Levels (Higher number = Higher privilege)

1. **SU (Super User)** - Level 100 - Full system access
2. **GS (General Secretary)** - Level 90
3. **DGS (Deputy General Secretary)** - Level 85
4. **DIR (Director of Industrial Relations)** - Level 80
5. **DPRS (Director of Professional and Regulatory Services)** - Level 80
6. **ADIR (Assistant Director Industrial Relations)** - Level 75
7. **AM (Accounts Manager)** - Level 70
8. **DAM (Deputy Accounts Manager)** - Level 65
9. **MO (Membership Officer)** - Level 60
10. **AMO (Assistant Membership Officer)** - Level 55
11. **IRE (Industrial Relation Executive)** - Level 50
12. **IRO (Industrial Relations Officers)** - Level 45
13. **RO (Regional Officer)** - Level 40
14. **BO (Branch Officer)** - Level 35
15. **IO (Information Officer)** - Level 30
16. **HLS (Head of Library Services)** - Level 25
17. **CC (Course Coordinator)** - Level 20
18. **ACC (Assistant Course Coordinator)** - Level 15
19. **LS (Librarian)** - Level 10
20. **LA (Library Assistant)** - Level 5
21. **AA (Accounts Assistant)** - Level 5
22. **AI (AI Agent)** - Level 2 - Read-only access for automated systems
23. **REO (Read Only)** - Level 1
24. **MEMBER** - Level 1 - Portal access for online payments
25. **NON-MEMBER** - Level 0

## Authorization Middleware

### Authentication Middleware

```javascript
import { ensureAuthenticated } from "../middlewares/auth.js";

// Ensures user is authenticated and extracts token data
router.get("/protected", ensureAuthenticated, handler);
```

### Role-Based Authorization

#### `authorizeMin(minRole)`

Allows users with minimum role level or higher:

```javascript
import { authorizeMin } from "../middlewares/auth.js";

// Requires Accounts Manager or higher
router.get("/financial-data", ensureAuthenticated, authorizeMin("AM"), handler);
```

#### `authorizeAny(...roles)`

Allows users with any of the specified roles:

```javascript
import { authorizeAny } from "../middlewares/auth.js";

// Requires Accounts Manager OR General Secretary
router.get(
  "/admin-data",
  ensureAuthenticated,
  authorizeAny("AM", "GS"),
  handler
);
```

#### `requireRole(role)`

Requires exact role match:

```javascript
import { requireRole } from "../middlewares/auth.js";

// Requires Super User only
router.get("/system-config", ensureAuthenticated, requireRole("SU"), handler);
```

### Permission-Based Authorization

#### `requirePermission(permission)`

Requires specific permission:

```javascript
import { requirePermission } from "../middlewares/auth.js";

// Requires financial:read permission
router.get(
  "/reports",
  ensureAuthenticated,
  requirePermission("financial:read"),
  handler
);
```

#### `requireAnyPermission(...permissions)`

Requires any of the specified permissions:

```javascript
import { requireAnyPermission } from "../middlewares/auth.js";

// Requires any of these permissions
router.get(
  "/sensitive-data",
  ensureAuthenticated,
  requireAnyPermission("admin:read", "financial:read", "audit:read"),
  handler
);
```

## Role-Specific Permissions

### AI Agent (AI) - Level 2

- **Read-only access** to journals and Chart of Accounts
- **No write permissions** - cannot create, update, or delete records
- **Automated system access** - designed for AI/ML systems and bots
- **Accessible endpoints**:
  - `GET /journal/` - View journal entries
  - `GET /admin/coa/readonly` - Read-only Chart of Accounts

### Member (MEMBER) - Level 1

- **Portal access** for online payments
- **Can make payments** through the portal
- **Limited read access** to their own records
- **Accessible endpoints**:
  - `GET /journal/` - View journal entries
  - `POST /journal/online-payment` - Make online payments

### Read Only (REO) - Level 1

- **Read-only access** to all data
- **No write permissions**
- **Staff-level read access**
- **Accessible endpoints**:
  - `GET /journal/` - View journal entries
  - `GET /admin/coa/readonly` - Read-only Chart of Accounts

## Usage Examples

### Basic Route Protection

```javascript
import express from "express";
import {
  ensureAuthenticated,
  authorizeMin,
  requirePermission,
} from "../middlewares/auth.js";

const router = express.Router();

// Public route
router.get("/public", (req, res) => {
  res.success({ message: "Public data" });
});

// Authenticated route
router.get("/user-data", ensureAuthenticated, (req, res) => {
  res.success({
    message: "User data",
    userId: req.ctx.userId,
    tenantId: req.ctx.tenantId,
  });
});

// Role-based protection
router.get(
  "/financial-reports",
  ensureAuthenticated,
  authorizeMin("AM"), // Accounts Manager or higher
  (req, res) => {
    res.success({ message: "Financial reports" });
  }
);

// Permission-based protection
router.post(
  "/create-invoice",
  ensureAuthenticated,
  requirePermission("financial:write"),
  (req, res) => {
    res.success({ message: "Invoice created" });
  }
);
```

### Combining Authorization Methods

```javascript
// Multiple authorization layers
router.put(
  "/sensitive-operation",
  ensureAuthenticated,
  authorizeMin("AM"), // Minimum role level
  requirePermission("admin:write"), // Specific permission
  idempotency(), // Additional middleware
  handler
);
```

## Request Context

After authentication, the request object contains:

### `req.ctx` (Primary context)

- `tenantId`: Tenant ID for data isolation
- `userId`: User ID
- `roles`: Array of user roles
- `permissions`: Array of user permissions

### `req.user` (Backward compatibility)

- Full JWT payload
- `req.userId`: User ID
- `req.tenantId`: Tenant ID
- `req.roles`: Array of roles
- `req.permissions`: Array of permissions

## Error Handling

Authorization failures return structured error responses:

```json
{
  "error": {
    "message": "Insufficient permissions",
    "code": "BAD_REQUEST",
    "status": 400,
    "forbidden": true,
    "userRoles": ["AA", "MO"],
    "requiredRoles": ["AM"]
  }
}
```

## Best Practices

1. **Use Role Hierarchy**: For broad access control, use `authorizeMin()` with role hierarchy
2. **Use Permissions**: For specific operations, use permission-based authorization
3. **Combine Methods**: Use both roles and permissions for comprehensive security
4. **Super User Access**: Super User (SU) automatically bypasses all authorization checks
5. **Tenant Isolation**: Always use `req.ctx.tenantId` for data queries
6. **Idempotency**: Use idempotency middleware for state-changing operations

## Migration from Old System

The new system maintains backward compatibility while providing enhanced features:

- Old `req.user.role` → New `req.ctx.roles` (array)
- Old role hierarchy → New hierarchical system with defined levels
- Added permission-based authorization
- Enhanced error messages with context
- Improved tenant isolation

## Sharing Role Hierarchy Across Services

The `roleHierarchy.js` file is designed to be shared across multiple services for consistent authorization logic:

### Copy to Other Services

1. Copy `/src/config/roleHierarchy.js` to other services
2. Import the functions you need:

```javascript
// In other services
import {
  ROLE_HIERARCHY,
  hasMinimumRole,
  isSuperUser,
} from "../config/roleHierarchy.js";

// Use in your authorization middleware
if (isSuperUser(userRoles)) {
  return next();
}

if (hasMinimumRole(userRoles, "AM")) {
  return next();
}
```

### Benefits of Shared Hierarchy

- **Consistent Authorization**: Same role levels across all services
- **Easy Maintenance**: Update hierarchy in one place per service
- **Type Safety**: Well-defined functions with clear parameters
- **Reusability**: Import only what you need

### Service-Specific Customization

Each service can:

- Import the base hierarchy
- Extend it with service-specific roles
- Override specific role levels if needed

```javascript
// Service-specific extension
import { ROLE_HIERARCHY } from "../config/roleHierarchy.js";

const SERVICE_ROLE_HIERARCHY = {
  ...ROLE_HIERARCHY,
  SERVICE_ADMIN: 95, // Service-specific role
};
```

## Security Considerations

1. **Token Validation**: All tokens are validated against JWT_SECRET
2. **Tenant Isolation**: Requests are automatically scoped to tenant
3. **Role Escalation**: Super User role provides full access
4. **Permission Granularity**: Fine-grained permissions for specific operations
5. **Audit Trail**: All authorization decisions are logged
6. **Consistent Hierarchy**: Shared role hierarchy ensures consistent authorization across services
