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
401). `GET /payments/attempts` (CRM Online Payments grid: every persisted Payment attempt,
read-only) carries the identical `/journal/stripe-payments` chain plus `validate`, and is
registered in `payment.routes.js` BEFORE `router.use(internalAuth)` so it has no S2S path. `requireFinanceRead` (DD runs, reconciliation, journal adjustments,
`GET /payments/refunds`) is CRM + a literal `payments:read`/`accounts.admin:read` claim, with no
empty-claims bypass and no `accounts.reports:read` alias. PDP P3: on the DD-run routes bank data is
separate (`helpers/bankDataAccess.js`): plaintext creditor/debtor IBAN+BIC in run/item responses (reads and
writes), `download-pain008`, `generate-pain008` and `prepare` need a literal `payments.bank:read` or `*`
claim on a CRM token (never `payments:*`/`admin`, never via the PDP); without it reads are masked
(first4****last4, BIC and PAIN.008 blob URL removed) and those three routes 403
`BANK_DATA_PERMISSION_REQUIRED`. `payments.bank:read` is a READ grant only: it never substitutes for
`requireFinanceWrite` (generate / prepare need finance write AND the bank grant; every other DD-run mutation needs
finance write only). The whole DD-run router is CRM-staff only (`requireCrmStaff`, 403 `CRM_ONLY`) - the write
routes too. Exact matrix: `src/tests/directDebitBankData.p3.test.mjs`. On `/payments/*`: capture/cancel,
`applications/:id/latest`, `batch` and the `/journal/events/manual-payment*` routes are
internal or CRM; `attach-registration` / `by-stripe` also admit a PORTAL caller for a Payment it
created (`payer.userId`, or `audit.createdBy` on a legacy row without `payer`);
`record-external` / `associate-member` need CRM finance write (or internal for
record-external); `POST /intents` stays open (bound by `paymentIntentGuard`).

Payer binding (P5, event/course intents): `POST /intents` stores `payer` (verified creator;
`userId: null, userType: "INTERNAL"` for a genuine S2S call) and `target` (`event`/`course`
from top-level `entityId` or the portal's `metadata.eventId`/`courseId`; `registration` for
intents events-service creates with a `registrationId`). A portal-like caller may not send a
`registrationId` (400 `REGISTRATION_ID_NOT_ALLOWED`) and every reuse/dedupe lookup it triggers
is scoped to its own payer + target, so it can never receive or supersede another payer's
intent/clientSecret. `attach-registration` is a single atomic bind: user callers (CRM too)
only on their own intent (403 `NOT_OWNER`); body must assert the registration's
`entityType`/`entityId`/`purpose`/`amount`/`currency`, compared with the row (and live Stripe
amount/currency); `profileId`/`memberId` in the body -> 400 `FIELD_NOT_ALLOWED`; a
registration that already has a Payment -> 409 `REGISTRATION_ALREADY_HAS_PAYMENT`; a
different registration on an attached intent -> 409 `ALREADY_ATTACHED`; same one -> 200
idempotent. Matrix: `src/tests/payerBinding.p5.test.mjs` (node:test, throwaway mongod).
Active registration binding (P5 batch 5): `Payment.registrationBinding` (= registrationId,
unique per tenant via a partial index) marks the ONE Stripe Payment that holds a registration.
It is claimed in the same update as attach (so two different intents racing onto one
registration: one 200, the rest 409, nothing written for the losers) and at `Payment.create`
for a registration-backed intent (a concurrent loser's PaymentIntent is cancelled, 409). The
only hand-over is the named `REPLACE_RELEASED_BINDING` transition: the holder is released by a
conditional update only when it can no longer take money (terminal unpaid status, or a
superseded attempt holding no funds); a funds-held holder (authorised/processing/captured)
makes a replacement 409 `REGISTRATION_PAYMENT_HELD` before Stripe is called. Attach of a dead
intent -> 409 `INTENT_NOT_ACTIVE`. Legacy rows and manual payments carry no binding; the
existing any-other-Payment read still refuses those.
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
