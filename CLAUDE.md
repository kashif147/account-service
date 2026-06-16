# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # nodemon with auto-reload on src/ and bin/ changes
npm run start:dev        # NODE_ENV=development (no auto-reload)
npm run start:staging    # NODE_ENV=staging

# Testing
npm run unittest         # Run all Jest tests (requires --experimental-vm-modules)
npm run unittest -- --testPathPattern=payments  # Run a single test file by pattern
npm run test:rabbitmq    # Manual RabbitMQ event testing via scripts/

# Production
npm start                # node bin/account-service.js
```

Tests live in `src/tests/` and match `**/*.test.js`. The project uses ES modules with Jest's experimental VM modules flag.

## Architecture

**Runtime**: Node.js ES modules (`"type": "module"`) — all imports must use `.js` extensions.

**Entry point**: `bin/account-service.js` → `src/app.js` sets up Express, then starts the HTTP server.

### Request pipeline (in order)

1. `pino-http` logging (health routes excluded)
2. Security headers (`helmet`, `securityHeaders`)
3. Raw body capture for `/api/webhook/stripe` (before compression — Stripe needs raw buffer for signature verification)
4. Compression (skipped for `/api/webhook/*`)
5. Webhook routes mounted before JSON parser
6. `bodyParser.json` (1mb limit)
7. `requestId` middleware (adds `x-request-id` correlation header)
8. `loggerMiddleware`, `responseMiddleware` (adds helpers to `res`)
9. Global rate limiter
10. Health routes (`/health`, `/ready`, `/health/*`)
11. Swagger at `/api/docs`
12. API routes at `/api`

### Route structure

```
/api
  /admin      → admin.routes.js → admin.controller.js
  /journal    → journal.routes.js → journal.controller.js
  /reports    → reports.routes.js → reports.controller.js
  /payments   → payment.routes.js → payment.controller.js
/api/webhook/stripe  → webhook.routes.js → webhook.controller.js
```

### Authentication / context

All `/api/*` routes go through `context.js` middleware which:
- Requires `x-tenant-id` header → sets `req.ctx.tenantId`
- Requires `x-api-key` header matching `process.env.ACCOUNTS_API_KEY`
- Optionally captures `x-idempotency-key` → `req.ctx.idempotencyKey`

### Response helpers (added by `response.mw.js`)

Use `res.success(data)`, `res.created(data)`, `res.appError(err)`, `res.fail(msg)`, etc. rather than raw `res.json()`. These produce a consistent `{ status, message, data, timestamp }` envelope.

### Error handling

Throw or return `AppError` instances for all domain errors. Static factories: `AppError.notFound()`, `AppError.badRequest()`, `AppError.unauthorized()`, `AppError.conflict()`, `AppError.forbidden()`, `AppError.internalServerError()`. The `errorHandler` middleware catches these and calls `res.appError()`.

Wrap all async route handlers with `asyncHandler` from `src/helpers/asyncHandler.js`.

### Idempotency

In-memory cache (5-minute TTL). Applied via `idempotency()` middleware using the `Idempotency-Key` header (8–128 chars). The context middleware reads `x-idempotency-key` into `req.ctx`; the idempotency middleware reads `Idempotency-Key`. These are two separate header names — be aware when adding new endpoints.

### RabbitMQ / Event system

Uses shared `@projectShell/rabbitmq-middleware` package (GitHub: `kashif147/rabbitmq-middleware#gateway`). Initialized on startup in `src/rabbitMQ/index.js`.

Consumed queues and their exchanges:
| Queue | Exchange | Routing keys |
|-------|----------|-------------|
| `accounts.user.events` | `user.events` | `user.crm.created.v1`, `user.crm.updated.v1` |
| `accounts.application.events` | `application.events` | `applications.review.processed.v1` |
| `accounts.product.events` | `product.events` | `product.*.*.v1`, `pricing.*.v1` |
| `accounts.membership.events` | `membership.events` | `members.subscription.current.updated.v1` |

Publish events via `publishDomainEvent(eventType, data, metadata)` from `src/rabbitMQ/index.js`.

### Database concurrency

`src/config/globalLimiter.js` exports a `p-limit` instance (`globalDBLimiter`) shared across all DB operations. Default 120 concurrent ops (80% of 150-connection MongoDB pool). Use `withGlobalLimit(fn)` to wrap any heavy DB operation. This is critical for batch operations (application approvals up to 500, payment batch processing up to 5000).

### Key models

- `payment.model.js`, `refund.model.js` — Stripe payment tracking
- `journal.model.js`, `glTransaction.model.js`, `balance.model.js`, `materializedBalance.model.js` — double-entry accounting / GL
- `coa.model.js` — Chart of Accounts
- `user.model.js` — CRM user sync (from user.events)
- `product.model.js`, `productType.model.js`, `pricing.model.js` — synced from product-service via events
- `reportSnapshot.model.js` — pre-computed report snapshots

### Shared packages (GitHub dependencies)

- `@membership/policy-middleware` — `kashif147/policy-middleware#gateway`
- `@membership/shared-constants` — `kashif147/membership-shared-constants#v1.0.0`
- `@projectShell/rabbitmq-middleware` — `kashif147/rabbitmq-middleware#gateway`

After changing any of these in `package.json`, run `npm install` to re-fetch from GitHub.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | MongoDB connection string |
| `RABBIT_URL` | RabbitMQ connection URL (optional — service starts without it) |
| `ACCOUNTS_API_KEY` | Shared API key required on all `/api/*` requests |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `PORTAL_BASE_URL` | Base URL for Stripe checkout success/cancel redirects |
| `MONGODB_MAX_POOL_SIZE` | Max connections (default: 150) |
| `MONGODB_MIN_POOL_SIZE` | Min connections (default: 20) |
| `GLOBAL_DB_OPERATIONS_LIMIT` | Global p-limit concurrency (default: 120) |
| `APPLICATION_EVENTS_PREFETCH` | RabbitMQ prefetch for application queue (default: 50) |
| `MEMBERSHIP_EVENTS_PREFETCH` | RabbitMQ prefetch for membership queue (default: 50) |

Uses `dotenv-flow` — create `.env.development`, `.env.staging`, `.env.production` as needed.
