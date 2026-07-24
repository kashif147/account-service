# Request pipeline and route structure

## Middleware order (`src/app.js`, in order)

1. `pino-http` logging (`/health` and `/health/*` excluded from autologging)
2. `securityHeaders` + `helmet.crossOriginResourcePolicy`
3. `correlationIdMiddleware` (from `@projectShell/logging-lib`)
4. Raw body capture for `/api/webhook/stripe` (before compression — Stripe needs the raw buffer for
   signature verification)
5. Compression (skipped for any `/api/webhook/*` path)
6. Webhook routes mounted at `/api/webhook` (before the JSON parser, so raw body survives)
7. `bodyParser.json` (1mb limit) for everything else
8. `createSystemLogsRouter(bizLogger)` from `@projectShell/logging-lib`, mounted at `/api`
9. `requestId` middleware (adds `x-request-id` correlation header)
10. `loggerMiddleware`, `responseMiddleware` (adds `res.success`/`res.appError`/etc. helpers)
11. Global rate limiter (`limiterGeneral`)
12. Health routes: `/health`, `/ready`, `/health/idempotency` (GET+POST clear), `/health/logging`,
    `/health/events`, `/health/rabbitmq`
13. `/api/docs` (Swagger)
14. `/api/create-batch` — a one-off route (not under `src/routes/`) requiring `ensureAuthenticated`, a
    CRM-userType check, `defaultPolicyMiddleware.requirePermission("accounts.journals","create")`,
    and a `multer` memory upload (25MB limit, field `file`) before hitting `createBatchDetail`
15. `/api` → `src/routes/index.js`
16. `notFound` → `logErrorMiddleware(bizLogger)` → `errorHandler`

If a request needs the raw Stripe webhook body or the create-batch upload, check its position in this
list before assuming standard JSON-body/auth middleware applies to it — both are handled before the
usual `/api` mount.

## Route structure (`src/routes/index.js`)

```
/api
  /admin              → admin.routes.js
  /journal            → journal.routes.js       (invoices, receipts, credit notes, write-offs, category
                                                   changes, member credit apply/reverse, payment
                                                   reassignment, deduction batches, event manual-payment
                                                   posting)
  /reports            → reports.routes.js
  /payments           → payment.routes.js        (Stripe intents, checkout, reconcile, refunds,
                                                   record-external)
  /batch-details      → batch.detail.routes.js
  /internal           → internal.routes.js       (reminder eligibility, internal write-off —
                                                   service-to-service only)
  /finance            → finance.routes.js         (journal adjustments, reconciliation
                                                   dashboard/import/match/suspense, profile-merge
                                                   account reassignment)
  /direct-debit-runs  → directDebitRun.routes.js  (SEPA DD run lifecycle)
  /templates          → grid.filter.template.routes.js (saved grid filter/column templates —
                                                   `template.model.js`; account-service is the owning
                                                   service for finance-grid Save View templates, see
                                                   `TEMPLATE_IMPLEMENTATION_PLAYBOOK.md` at the repo
                                                   root of the full projectShell checkout)
/api/webhook/stripe   → webhook.routes.js → webhook.controller.js
```

## Response helpers and error handling

Use `res.success(data)`, `res.created(data)`, `res.appError(err)`, `res.fail(msg)`, etc. (added by
`response.mw.js`) instead of raw `res.json()` — they produce the platform-standard `{ status,
message, data, timestamp }` envelope.

Throw or return `AppError` instances for all domain errors — static factories: `AppError.notFound()`,
`AppError.badRequest()`, `AppError.unauthorized()`, `AppError.conflict()`, `AppError.forbidden()`,
`AppError.internalServerError()`. The `errorHandler` middleware catches these and calls
`res.appError()`.

Wrap every async route handler with `asyncHandler` from `src/helpers/asyncHandler.js` rather than a
manual try/catch — unwrapped async handlers that throw will bypass `errorHandler`.
