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

## 3. Caller class / object ownership — `src/middlewares/callerScope.middleware.js` (P5)

`accounts.reports:read` (and `payments:*`) are also held by the portal MEMBER role, so the PDP
alone does not keep portal members out of tenant-wide finance data. Caller class comes from the
verified identity only: internal = `req.ctx.internalRequest === true`; CRM / PORTAL =
`req.user.userType`; anything else is denied. `requireCrmUser` (403 `CRM_ONLY`, placed before
the PDP) guards every `/reports/*` route except a member's own `statement` / `net-balance`
(`requireCrmOrOwnMember`: PORTAL callers only for the membership number / profileId that
profile-service `my-profile` returns for the verified principal, else 403 `NOT_OWNER`) and the
`/batch-details` reads. On `/journal/*`, `requireCrmUser` also runs before the PDP on the
journal/credit-note reads (`GET /`, `/stripe-payments`, `/credit-notes`, `/credit-notes/:docNo`
— CRM finance screens only) and on `POST /online-payment` (no caller anywhere; CRM finance only,
a PORTAL token is denied whatever permissions it carries, and a bare `x-internal-request` is a
401). `requireFinanceRead` (DD runs, reconciliation, journal adjustments,
`GET /payments/refunds`) is CRM + a literal `payments:read`/`accounts.admin:read` claim, with no
empty-claims bypass and no `accounts.reports:read` alias. On `/payments/*`: capture/cancel,
`applications/:id/latest`, `batch` and the `/journal/events/manual-payment*` routes are
internal or CRM; `attach-registration` / `by-stripe` also admit a PORTAL caller for a Payment it
created (`audit.createdBy`); `record-external` / `associate-member` need CRM finance write (or
internal for record-external); `POST /intents` stays open (bound by `paymentIntentGuard`).
`ensureAuthenticated`'s gateway path falls back to the `userType` of a Bearer token that verifies
with this service's secret and names the same user + tenant, because profile-, reporting- and
audit-service clients forward gateway headers without `x-user-type`.

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
re-verifying a token. Because that path grants identity from headers, sensitive routes behind it
add `requireInternalOrFinanceWrite` / `requireInternalOrFinanceRead`
(`financePermission.middleware.js`): a genuine internal call (`req.ctx.internalRequest === true`,
only ever set by `forwardedInternalContext`) passes, while any user JWT/gateway caller needs finance
write (role + permission) or a strict finance read permission (no empty-claims bypass, never
PORTAL). Used on `POST /payments/reconcile` and all `/internal/members/*` routes. There is no remaining route in this service using a static shared-secret
`x-api-key`/`*_API_KEY` check — `payment.routes.js` was the last one and now uses this same
`internalAuth` pattern instead of the old default-export `context()` middleware (removed).

When working from the full `projectShell` checkout (not a standalone clone of just this repo), both
of the rules above are additionally mechanically enforced by
`.claude/hooks/enforce-hard-rules.mjs` (root-level `PreToolUse` hook on `Write`/`Edit`): it blocks
`mongoose.createConnection(...)` and cross-service Mongo URIs (this service has no reason to open one
— see the `no-cross-db-mongo` skill), and it blocks the literal header key `x-api-key` and any new
`<PREFIX>_API_KEY` env var outside a known external-provider allowlist (Stripe/SendGrid/Twilio/etc.).

**`POST /reports/creditors-list`** is also registered twice (same pattern as the other
`trustedInternalOnly` pairs): first `trustedInternalOnly, creditorsList` for reporting-service
`scripts/sync-member-creditors.js` (tenant = the 24-hex `x-tenant-id` header only, response
`{ memberId, amountCents }` rows only), then the unchanged CRM chain (`requireCrmUser` → PDP
`accounts.reports:read`). A request without `asOf` / `year`+`month` / `dateTo` is 400. Matrix:
`src/tests/creditorsList.internal.http.test.mjs` (node:test). Keep this route off the public
gateway path: the gateway strips `x-internal-request`, so only in-network callers reach branch 1.
