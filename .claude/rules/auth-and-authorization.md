# Authentication / authorization

Two independent layers, both applied per-route — there is no single global auth middleware for
`/api/*`, so a new route needs both added explicitly, not inherited.

## 1. Identity — `ensureAuthenticated` (`src/middlewares/auth.js`)

Tried in order:

- Gateway-verified JWT: `x-jwt-verified: true` + `x-auth-source: gateway`, validated via
  `validateGatewayRequest` from `@membership/policy-middleware/security`, with identity/roles/
  permissions read from `x-user-id`, `x-tenant-id`, `x-user-email`, `x-user-type`, `x-user-roles`,
  `x-user-permissions`. This is the normal path for requests arriving via the gateway.
- Legacy `Authorization: Bearer <jwt>` verified locally with `JWT_SECRET`/`ACCESS_TOKEN_SECRET`.
- Azure App Service EasyAuth (`x-ms-client-principal` / `x-ms-token-aad-access-token`) as a final
  fallback.

All three paths populate `req.ctx`, `req.user`, `req.userId`, `req.tenantId`, `req.roles`,
`req.permissions`.

## 2. Authorization — `defaultPolicyMiddleware.requirePermission(resource, action)`

`src/middlewares/policy.middleware.js` wraps `@membership/policy-middleware` and calls out to
`POLICY_SERVICE_URL` (user-service's `/policy/evaluate`). Applied per-route, e.g.
`requirePermission("accounts.journals", "create"|"read"|"write")`. Sensitive finance mutations
additionally go through `requireFinanceRead`/`requireFinanceWrite`
(`src/middlewares/financePermission.middleware.js`), which require an Accounts Manager/Deputy
Accounts Manager role plus a `payments`/`accounts.admin`/`accounts.journals` write permission.

## Cross-service calls forward identity — never a shared API key

The platform rule: forward the original caller's `Authorization` and gateway headers
(`x-jwt-verified`/`x-auth-source`, `x-tenant-id`, `x-user-*`) to any downstream service call, and use
`x-internal-request: true` only for genuine service-to-service calls with no originating user. Don't
add a new `*_API_KEY` env var or `x-api-key` header for a new outbound client — build it the way
`profileUpstream.client.js`, `directDebitUpstream.client.js`, and `tenant.service.client.js` already
do (pass `req` in, forward its headers). See the `cross-service-auth` skill for the full
`buildHeaders()` pattern.

Routes like `/internal/*`, `journal.routes.js`'s `/events/manual-payment`, and `payment.routes.js`
(every route under `/api/payments/*`) use an `internalAuth` guard for this: if `Authorization` or
`x-jwt-verified` is present, delegate to `ensureAuthenticated`; otherwise require
`x-internal-request: true` and use `forwardedInternalContext` (`src/middlewares/context.js`), which
trusts forwarded `x-tenant-id`/`x-user-id`/`x-user-roles`/`x-user-permissions` headers without
re-verifying a token. There is no remaining route in this service using a static shared-secret
`x-api-key`/`*_API_KEY` check — `payment.routes.js` was the last one and now uses this same
`internalAuth` pattern instead of the old default-export `context()` middleware (removed).

When working from the full `projectShell` checkout (not a standalone clone of just this repo), both
of the rules above are additionally mechanically enforced by
`.claude/hooks/enforce-hard-rules.mjs` (root-level `PreToolUse` hook on `Write`/`Edit`): it blocks
`mongoose.createConnection(...)` and cross-service Mongo URIs (this service has no reason to open one
— see the `no-cross-db-mongo` skill), and it blocks the literal header key `x-api-key` and any new
`<PREFIX>_API_KEY` env var outside a known external-provider allowlist (Stripe/SendGrid/Twilio/etc.).
