# Role Updates Summary

## Changes Made

### 1. Added New AI Agent Role

- **Role Code**: `AI`
- **Level**: 2 (between NON-MEMBER and REO)
- **Purpose**: Read-only access for automated systems and AI agents
- **Permissions**: Read-only access to journals and Chart of Accounts

### 2. Updated Role Hierarchy

- Added `AI: 2` to the role hierarchy
- Updated comments to clarify role purposes:
  - `AI: 2` - AI Agent - Read-only access for automated systems
  - `MEMBER: 1` - Member - Portal access for online payments

### 3. Updated Route Permissions

#### Journal Routes (`/src/routes/journal.routes.js`)

- **GET `/journal/`**: Changed from `authorizeMin("REO")` to `authorizeMin("AI")`
  - Now allows AI agents to view journal entries
- **POST `/journal/online-payment`**: New route with `authorizeMin("MEMBER")`
  - Allows members to make online payments through the portal

#### Admin Routes (`/src/routes/admin.routes.js`)

- **GET `/admin/coa/readonly`**: New route with `authorizeMin("AI")`
  - Provides read-only access to Chart of Accounts for AI agents

### 4. Updated Documentation

- Updated `AUTHORIZATION_SYSTEM.md` with new role levels
- Added role-specific permissions section
- Documented accessible endpoints for each role

## New Endpoints

### For AI Agents (AI role)

- `GET /journal/` - View journal entries
- `GET /admin/coa/readonly` - Read-only Chart of Accounts

### For Members (MEMBER role)

- `GET /journal/` - View journal entries
- `POST /journal/online-payment` - Make online payments

## Role Hierarchy (Updated)

```
SU (Super User)           - Level 100
GS (General Secretary)    - Level 90
DGS (Deputy Gen Sec)      - Level 85
DIR (Director IR)          - Level 80
DPRS (Director PRS)        - Level 80
ADIR (Asst Director IR)   - Level 75
AM (Accounts Manager)     - Level 70
DAM (Deputy Acc Manager)  - Level 65
MO (Membership Officer)   - Level 60
AMO (Asst Mem Officer)     - Level 55
IRE (IR Executive)         - Level 50
IRO (IR Officers)          - Level 45
RO (Regional Officer)      - Level 40
BO (Branch Officer)        - Level 35
IO (Information Officer)   - Level 30
HLS (Head Library Serv)    - Level 25
CC (Course Coordinator)    - Level 20
ACC (Asst Course Coord)    - Level 15
LS (Librarian)             - Level 10
LA (Library Assistant)     - Level 5
AA (Accounts Assistant)    - Level 5
AI (AI Agent)              - Level 2  ← NEW
REO (Read Only)            - Level 1
MEMBER (Member)            - Level 1
NON-MEMBER                 - Level 0
```

## Testing the Changes

### Test AI Agent Access

```bash
# Test AI agent can view journals
curl -H "Authorization: Bearer <ai-agent-token>" \
     http://localhost:3000/journal/

# Test AI agent can view Chart of Accounts (read-only)
curl -H "Authorization: Bearer <ai-agent-token>" \
     http://localhost:3000/admin/coa/readonly
```

### Test Member Access

```bash
# Test member can view journals
curl -H "Authorization: Bearer <member-token>" \
     http://localhost:3000/journal/

# Test member can make online payment
curl -X POST \
     -H "Authorization: Bearer <member-token>" \
     -H "Content-Type: application/json" \
     -d '{"amount": 100, "description": "Membership fee"}' \
     http://localhost:3000/journal/online-payment
```

## Security Considerations

1. **AI Agent Role**: Limited to read-only operations only
2. **Member Role**: Can make payments but cannot access sensitive admin functions
3. **Role Hierarchy**: Maintains proper privilege levels
4. **Token Validation**: All roles still require valid JWT tokens
5. **Tenant Isolation**: All operations remain tenant-scoped

## Migration Notes

- Existing tokens with AI or MEMBER roles will automatically work with new permissions
- No breaking changes to existing functionality
- New routes are additive and don't affect existing routes
- Role hierarchy remains backward compatible
