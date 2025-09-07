# Authorization System Migration Checklist

## Quick Copy Commands

```bash
# Make the migration script executable (if not already)
chmod +x migrate-auth.sh

# Run the migration script
./migrate-auth.sh /path/to/other-service

# Example:
./migrate-auth.sh ../user-service
./migrate-auth.sh ../payment-service
./migrate-auth.sh ../notification-service
```

## Manual Copy (Alternative)

If you prefer to copy files manually:

```bash
# Copy core authorization files
cp src/config/roleHierarchy.js /path/to/other-service/src/config/
cp src/middlewares/auth.js /path/to/other-service/src/middlewares/
cp src/middlewares/verifyRoles.js /path/to/other-service/src/middlewares/
cp src/errors/AppError.js /path/to/other-service/src/errors/

# Copy documentation
cp src/docs/AUTHORIZATION_SYSTEM.md /path/to/other-service/src/docs/
cp src/docs/AUTHORIZATION_MIGRATION_GUIDE.md /path/to/other-service/src/docs/
```

## Files to Copy

### ✅ Required Files

- [ ] `src/config/roleHierarchy.js` - Role hierarchy definitions
- [ ] `src/middlewares/auth.js` - Main authorization middleware
- [ ] `src/middlewares/verifyRoles.js` - Role verification middleware
- [ ] `src/errors/AppError.js` - Error handling class

### ✅ Optional Files

- [ ] `src/docs/AUTHORIZATION_SYSTEM.md` - System documentation
- [ ] `src/docs/AUTHORIZATION_MIGRATION_GUIDE.md` - Migration guide

## Post-Copy Steps

### 1. Install Dependencies

```bash
cd /path/to/other-service
npm install jsonwebtoken
```

### 2. Set Environment Variables

```bash
# Add to .env file
JWT_SECRET=your-jwt-secret-key
```

### 3. Update Route Files

```javascript
import {
  ensureAuthenticated,
  authorizeMin,
  authorizeAny,
  requireRole,
  requirePermission,
  requireAnyPermission,
} from "../middlewares/auth.js";

// Use in your routes
router.get("/protected", ensureAuthenticated, handler);
router.get("/admin", ensureAuthenticated, authorizeMin("AM"), handler);
```

### 4. Test Implementation

```javascript
// Test authentication
router.get("/test-auth", ensureAuthenticated, (req, res) => {
  res.json({ message: "Auth works!", user: req.ctx });
});
```

## Service-Specific Customizations

### Add Service-Specific Roles

```javascript
// In your service's config
import { ROLE_HIERARCHY } from "../config/roleHierarchy.js";

const SERVICE_ROLES = {
  ...ROLE_HIERARCHY,
  SERVICE_ADMIN: 95,
  SERVICE_USER: 10,
};
```

### Add Service-Specific Permissions

```javascript
// Define permissions for your service
const PERMISSIONS = {
  READ: "service:read",
  WRITE: "service:write",
  DELETE: "service:delete",
};
```

## Verification

- [ ] Files copied successfully
- [ ] Dependencies installed
- [ ] Environment variables set
- [ ] Routes updated with new middleware
- [ ] Authentication working
- [ ] Role authorization working
- [ ] Permission authorization working
- [ ] Error handling working

## Common Issues

### Import Path Errors

**Fix**: Update import paths in copied files to match your service structure

### Missing Dependencies

**Fix**: Copy AppError.js or install required packages

### JWT Secret Issues

**Fix**: Ensure all services use the same JWT_SECRET

### Token Structure Issues

**Fix**: Verify user service sends tokens with roles and permissions arrays

## Support

For detailed instructions, see:

- `src/docs/AUTHORIZATION_SYSTEM.md` - Complete system documentation
- `src/docs/AUTHORIZATION_MIGRATION_GUIDE.md` - Detailed migration guide
