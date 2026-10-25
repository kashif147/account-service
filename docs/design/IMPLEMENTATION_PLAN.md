# Implementation-ready plan: payment lifecycle, payment links, drives, staff cases

Status: **plan for review** (2026-10-21). Builds on `PAYMENT_LINK_AND_STATE_MACHINE.md` (same
folder). Where the two differ, this document wins. Nothing here is implemented beyond the
feature-branch fixes in section 1.1. No merge, deployment, Stripe configuration change or
permission grant has been made.

## 0. Decisions and verified facts

**Decisions (2026-10-21).** Card only: full payment, or a first instalment (annual / 4) where the
membership product explicitly allows instalments. Amounts are server-side only. MembersHub cases are
IR-only, with `issues-own` scoping. Drive rules are kept as built. The timezone is read through an
authenticated, least-privilege route. D1-D6 come first. Payment links follow the event-driven
architecture with one current attempt per application.

**Verified from Stripe documentation (no test objects created):**

| Fact | Source | Design consequence |
|---|---|---|
| Checkout supports `payment_intent_data.capture_method=manual`; after completion the PI is `requires_capture` and `payment_intent.amount_capturable_updated` fires | "Place a hold on a payment method" | Link payments reuse the existing manual-capture approval flow unchanged |
| Session `expires_at`: 30 min - 24 h after creation; default 24 h | Checkout Session create API | The 24 h link is the Stripe session itself |
| Online card authorisations: 7 days for customer-initiated (Visa MIT 4 d 18 h); exact expiry on the charge as `payment_method_details.card.capture_before`; expiry -> PI `canceled` | same | The expiry warning uses `capture_before`, not a fixed 7 days |
| Checkout shows Dashboard-enabled methods unless restricted; manual capture only works with eligible methods | same + accept-a-payment | Always pass `payment_method_types: ["card"]` (the existing `useCheckout` code already does) |
| `checkout.session.completed` must be handled idempotently and can arrive concurrently; Checkout waits up to 10 s for the webhook response before redirecting | Checkout fulfilment guide | Acknowledge fast (outbox); key on session id |
| `payment_status` for a manual-capture session is not documented | - | Never branch on `payment_status`; re-read the session's PaymentIntent and use its `status` |

**Still to verify empirically** (needs approval: it creates test-mode objects and sends events to
the DEV webhook): one manual-capture Checkout Session paid with `4242…` and one with `4000 0025 0000 3155`
(3DS). Record the event order, `payment_status`, PI status and `capture_before`. The other
session should know first, because DEV account-service will log `unknown_payment_intent` rejections
for these (the payments won't exist in its DB).

**Portal compatibility (verified in code):**
- portal-service's `application.status.updated` listener returns early when it has no
  `PersonalDetails` for the application, so a CRM/MembersHub link payment can't make portal
  create or forward an application.
- Rule: **link-mode payments never publish the legacy `application.status.updated`**. They publish
  only `payments.application-payment.status-changed.v1`. The inline portal flow keeps the legacy event.
- profile-service's `profile.application.create` listener upserts by `applicationId`, so even a
  stray legacy event can't duplicate an application. It could overwrite staging data, which is
  why the rule above exists.

---

## 1. Feature-branch changes

### 1.1 Done on existing branches

| Branch | Commit | Change |
|---|---|---|
| profile-service `feature/membership-drive` | `0fc0aa7` | Timezone read **as the caller** from `GET /api/tenant/regional-settings`. The caller's `Authorization` is forwarded and `x-internal-request` removed. The service layer makes no network calls; answers about another tenant are ignored; 401/403 are never cached; Dublin fallback until the endpoint exists |
| issue-service `feature/staff-case-lists` | `5babc24` | Approved `issues-own` design, IR-only creation, handling of the team-write gap (docs) |

### 1.2 Still needed: profile-service

`feature/membership-drive`: nothing further. Its only open items are dependencies: the user-service
route and three grants.

New branch `feature/application-payment-link`:
- `personalDetails.payment` sub-document (section 4) plus the Joi guard (the create/update schemas
  already reject unknown keys; add a test).
- `POST /api/applications/:applicationId/payment-link` and `GET /api/applications/:applicationId/payment`.
- A persisted idempotency store (`idempotencyKeys`, TTL 24 h), **not** `middlewares/idempotency.js`
  (in-memory, explicitly not production-ready).
- Listeners for `payments.payment-link.issued.v1`, `payments.payment-link.failed.v1` and
  `payments.application-payment.status-changed.v1`, with a `processedEvents` dedupe store.
- Outbox (`outboxEvents`) and relay for `applications.payment-link.requested.v1` and
  `applications.payment-link.email.requested.v1`.
- CRM review-list filter on `payment.status = AUTHORISED`.
- Approval (`profileApproval.controller.js` **and** `bulkApproval.controller.js`, kept in sync):
  read the payment id from `personalDetails.payment.paymentId` when `mode = LINK`, else the
  current resolver. Capture code is unchanged.

### 1.3 Still needed: account-service

New branch `feature/payment-lifecycle` (D1-D6, section 5). Ships in shadow mode first:
- `src/services/paymentStateMachine.js` (pure) plus wiring in `reconcileStripeEvent`,
  `refreshPaymentFromStripe`, capture and cancel.
- Webhook: 500 on transient failure, a `stripeEventRejections` record for permanent ones,
  handlers for `checkout.session.completed/expired`, `charge.refunded`, `refund.updated`,
  `charge.refund.updated`. These stay inert until the new endpoint subscribes them.
- `outboxEvents` plus relay.
- An authorisation-expiry scheduler (single-instance assumption, the same pattern as
  subscription-service lifecycle jobs; document it).

New branch `feature/application-payment-link` (after lifecycle):
- `PaymentLink` model and the consumer for `applications.payment-link.requested.v1`.
- `computeApplicationAmount()` extracted from `paymentIntentGuard.service.js` so the portal guard
  and links share one rounding rule.
- Checkout creation, link replacement, and the `issued`/`failed`/`status-changed` publishers.
- Internal read `GET /api/internal/payment-links?applicationId=`.

### 1.4 Still needed: other repos

| Repo | Branch | Change |
|---|---|---|
| issue-service | `feature/staff-case-lists` (next commits) | `issues-own` routes per `docs/STAFF_CASE_ACCESS.md`; `/mine` gate -> `issues-own:read`; `POST /issues` team-write check (after the primary session confirms) |
| rabbitmq-middleware | `feature/payment-link-events` | 7 `exchangeMapping` entries (section 3), plus the pre-existing unmapped `members.gap-letter.requested.v1` |
| communication-service | `feature/payment-link-email` | listener plus `APPLICATION_PAYMENT_LINK` template; dedupe on `dedupeKey` (gap-letter pattern) |
| portal-service | phase 3 only | forward card applications to profile-service at submission when the member chooses "pay later" |
| user-service | **primary session** | `GET /api/tenant/regional-settings`; product `paymentOptions.allowFirstInstalment` (synced to account-service); grant scripts (section 6) |
| Frontends | later | MembersHub/CRM "send payment link" and status badge; portal "pay later" |

---

## 2. API contracts

All routes sit behind the gateway. Tenant and user come from the trusted context, and bodies never
carry tenant, amount or price.

### 2.1 profile-service: payment link

`POST /api/applications/:applicationId/payment-link`
- Headers: `Idempotency-Key` (required, ≤ 100 chars).
- Body: `{ "action": "ISSUE" | "RESEND" | "REPLACE", "paymentOption": "FULL" | "FIRST_INSTALMENT" }`.
  `paymentOption` is required for `ISSUE`/`REPLACE` and ignored for `RESEND`.
- 202: `{ "status":"success", "data": { "applicationId", "linkVersion", "payment": { "status": "LINK_REQUESTED" } } }`

| Error | When |
|---|---|
| 404 | application not in caller's tenant; portal caller not the applicant |
| 409 `PAYMENT_METHOD_NOT_SUPPORTED` | application `paymentType` isn't card |
| 409 `ALREADY_AUTHORISED` | a payment is `requires_capture`/`succeeded` |
| 409 `APPLICATION_CLOSED` | application `processed`/`rejected` |
| 409 `LINK_ACTIVE` | `ISSUE` while an unexpired link exists (use `RESEND`/`REPLACE`) |
| 409 `NO_ACTIVE_LINK` | `RESEND` with nothing current |
| 400 | body/header invalid |

`INSTALMENTS_NOT_ALLOWED` is decided by account-service (it owns the catalogue) and comes back
as `payments.payment-link.failed.v1`, so it shows on `GET …/payment` as `status: FAILED, reason`.

`GET /api/applications/:applicationId/payment`, 200:
```json
{ "mode": "LINK|INLINE|NOT_REQUIRED",
  "status": "NONE|LINK_REQUESTED|LINK_ISSUED|LINK_EXPIRED|AUTHORISED|AUTHORISATION_EXPIRING|AUTHORISATION_EXPIRED|CAPTURED|FAILED|CANCELED|REFUNDED|PARTIALLY_REFUNDED",
  "reason": null, "paymentOption": "FULL", "linkVersion": 2,
  "checkoutUrl": "https://checkout.stripe.com/…", "expiresAt": "…",
  "authorisationExpiresAt": null, "amount": 29900, "currency": "eur", "updatedAt": "…" }
```
`checkoutUrl` is returned only while `LINK_ISSUED` and only to the applicant or staff.

### 2.2 issue-service: `issues-own`
Defined in `issue-service/docs/STAFF_CASE_ACCESS.md`: `GET /issues/mine`, `GET /issues/mine/:id`,
`POST /issues/mine` (IR only), `PUT /issues/mine/:id`, `PUT /issues/mine/:id/status`,
`POST /issues/mine/:id/activities`.

### 2.3 user-service (primary session): `GET /api/tenant/regional-settings`
tenantScoped router (`authenticate` + `requireTenant`), gate `tenant-regional-settings:read`.
The tenant comes from the verified identity only.
`200 { "data": { "tenantId", "timezone", "locale", "currency", "dateFormat" } }`.

### 2.4 account-service
No new user-facing route. Internal: `GET /api/internal/payment-links?applicationId=` (tenant from
`x-tenant-id`, support/diagnostics only).

---

## 3. Event contracts

Each event uses the standard envelope (`eventId`, `eventType`, `tenantId`, `correlationId`,
`timestamp`, `data`). **The `exchangeMapping` entries go in first.** Consumers ignore unknown fields.

| Routing key | Exchange | From -> to | `eventId` (dedupe) |
|---|---|---|---|
| `applications.payment-link.requested.v1` | `application.events` | profile -> account | `link:{tenant}:{app}:v{n}:requested` |
| `payments.payment-link.issued.v1` | `payment.events` | account -> profile | `link:{tenant}:{app}:v{n}:issued` |
| `payments.payment-link.failed.v1` | `payment.events` | account -> profile | `link:{tenant}:{app}:v{n}:failed` |
| `payments.payment-link.expired.v1` | `payment.events` | account -> profile | `link:{tenant}:{app}:v{n}:expired` |
| `applications.payment-link.email.requested.v1` | `application.events` | profile -> communication | `link:{tenant}:{app}:v{n}:email:{seq}` |
| `payments.application-payment.status-changed.v1` | `payment.events` | account -> profile | `pay:{paymentId}:{toState}` (refunds: `pay:{paymentId}:refund:{refundId}:{refundStatus}`) |
| `payments.application-payment.authorisation-expiring.v1` | `payment.events` | account -> profile | `pay:{paymentId}:expiring` |

Payloads (`data`):

```jsonc
// applications.payment-link.requested.v1 (pricing INPUTS only; account computes the amount)
{ "applicationId": "…", "linkVersion": 2, "action": "REPLACE", "paymentOption": "FIRST_INSTALMENT",
  "pricing": { "membershipCategory": "…", "paymentType": "Credit Card" },
  "requestedBy": { "userId": "…", "userType": "CRM|PORTAL", "channel": "CRM|MEMBERSHUB|PORTAL" } }

// payments.payment-link.issued.v1
{ "applicationId": "…", "linkVersion": 2, "paymentLinkId": "…", "paymentId": "…",
  "checkoutSessionId": "cs_…", "checkoutUrl": "…", "expiresAt": "…",
  "amount": 7475, "currency": "eur", "paymentOption": "FIRST_INSTALMENT",
  "pricingBasis": { "productId": "…", "annualFee": 29900, "rule": "FIRST_INSTALMENT_ROUND_HALF_UP_QUARTER" } }

// payments.payment-link.failed.v1
{ "applicationId": "…", "linkVersion": 2,
  "reason": "INSTALMENTS_NOT_ALLOWED|PRICE_UNAVAILABLE|PAYMENT_METHOD_NOT_SUPPORTED|ALREADY_AUTHORISED|STRIPE_ERROR",
  "retryable": false }

// payments.payment-link.expired.v1 (checkout.session.expired for the CURRENT version only)
{ "applicationId": "…", "linkVersion": 2, "checkoutSessionId": "cs_…" }

// applications.payment-link.email.requested.v1 (recipient resolved by profile, the data owner)
{ "applicationId": "…", "linkVersion": 2, "dedupeKey": "…",
  "recipient": { "email": "…", "name": "…" },   // contactInfo.preferredEmail personal|work
  "checkoutUrl": "…", "expiresAt": "…", "amount": 7475, "currency": "eur",
  "paymentOption": "FIRST_INSTALMENT", "templateCode": "APPLICATION_PAYMENT_LINK" }

// payments.application-payment.status-changed.v1
{ "applicationId": "…", "paymentId": "…", "paymentIntentId": "pi_…", "linkVersion": 2,
  "from": "requires_action", "to": "requires_capture", "amount": 7475, "currency": "eur",
  "capturableUntil": "…",            // charge.payment_method_details.card.capture_before
  "refund": null,                    // { refundId, amount, status } for refund transitions
  "occurredAt": "…", "stripeEventId": "evt_…" }

// payments.application-payment.authorisation-expiring.v1
{ "applicationId": "…", "paymentId": "…", "capturableUntil": "…", "hoursLeft": 48 }
```

Price rule (one helper, shared with the portal guard):
- `FULL` = catalogue annual fee in cents.
- `FIRST_INSTALMENT` = `Math.round(annualCents / 4)`. That's the guard's current rule, half-up on
  cents; confirm it is the approved rounding. It is allowed only if the synced product has
  `paymentOptions.allowFirstInstalment === true`. **Fails closed** until that field exists.
- Prices are frozen on the `PaymentLink` at issue; `REPLACE` re-prices.

---

## 4. Data model changes

**account-service**
- `PaymentLink` { `tenantId`, `applicationId`, `linkVersion`, `status` (`ISSUED|COMPLETED|EXPIRED|REPLACED|FAILED`), `paymentOption`, `checkoutSessionId`, `checkoutUrl`, `expiresAt`, `paymentId`, `amount`, `currency`, `pricingBasis`, `requestedBy`, `requestEventId`, timestamps }.
  - Unique `{tenantId, applicationId, linkVersion}`.
  - Partial unique `{tenantId, applicationId}` where `status: "ISSUED"` (one current link).
  - Unique `{checkoutSessionId}`.
- `Payment`: `paymentLinkId`, `mode` (`INLINE|LINK`), `capturableUntil`, `expiryWarnedAt`, `auditTrail[].applied`.
  - Partial unique `{tenantId, applicationId}` where `isActiveAttempt: true` and `status ∈ {requires_action, processing, failed, requires_capture}` (one current attempt).
- `outboxEvents` { `eventId` unique, `routingKey`, `payload`, `status`, `attempts`, `nextAttemptAt` }; `stripeEventRejections`.

**profile-service** (`personalDetails` is the application)
- `payment` { `mode`, `status`, `reason`, `paymentOption`, `linkVersion`, `paymentId`, `checkoutUrl`, `expiresAt`, `authorisationExpiresAt`, `amount`, `currency`, `lastEventId`, `updatedAt` }.
- Already on the drive branch: `membershipDrive`.
- New `processedEvents` (`eventId` unique, TTL 30 d), `outboxEvents`, `idempotencyKeys` (unique `{tenantId, scope, key}`, TTL 24 h, stores response hash plus body).

**user-service** (primary session): `Product.paymentOptions.allowFirstInstalment` (default `false`), included in the product sync to account-service.

---

## 5. State-transition and retry rules

### 5.1 Payment (account-service, `Payment.status`)

| From \ event | `requires_action` | `processing` | `failed` | `requires_capture` | `succeeded` | `canceled` | `authorization_expired` | refund |
|---|---|---|---|---|---|---|---|---|
| `created`/`payment_required` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | - |
| `requires_action` | = | ✓ | ✓ | ✓ | ✓ | ✓ | - | - |
| `processing` | ↺ | = | ✓ | ✓ | ✓ | ✓ | - | - |
| `failed` | ✓ (retry) | ✓ | = | ✓ | ✓ | ✓ | - | - |
| `requires_capture` | ✗ (D1) | ✗ | ✗ | = | ✓ | ✓ | ✓ | - |
| `succeeded` | ✗ | ✗ | ✗ | ✗ | = | ✗ | ✗ | ✓ |
| `partially_refunded` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `canceled`/`authorization_expired`/`refunded` | ✗ | ✗ | ✗ | ✗ | ✗ | = | = | ✗ |
| `manual_review`/`refund_required` (holds) | rec | rec | rec | rec | rec | rec | rec | rec |

Key: ✓ apply · = idempotent no-op · ✗ ignore, record `applied:false` and **re-read the PI from Stripe** (apply its status through this table) · ↺ apply only if the event is newer than the last applied `occurredAt` · rec = record only, finance releases the hold.

- `canceled` is classified by `cancellation_reason`: `automatic`/`abandoned`/`expired` -> `authorization_expired`, anything else -> `canceled`.
- Refund state comes from `charge.amount_refunded` vs `amount_received`: `0 < x < received` -> `partially_refunded`, `x = received` -> `refunded`. A failed or canceled refund doesn't change payment state, but is recorded and published with the refund payload.
- Webhook payloads at API `2018-02-28` are normalised (`requires_source` -> `requires_payment_method`, `requires_source_action` -> `requires_action`) before the table.

### 5.2 Payment link (account-service, `PaymentLink.status`)
`ISSUED -> COMPLETED` (its PI reached `requires_capture`/`succeeded`) · `ISSUED -> EXPIRED` (`checkout.session.expired`) · `ISSUED -> REPLACED` (a newer version issued and `sessions.expire` succeeded) · `FAILED` (terminal for that version). Everything else is a no-op.

### 5.3 Application payment (profile-service, `personalDetails.payment.status`)
`NONE -> LINK_REQUESTED -> LINK_ISSUED -> AUTHORISED -> CAPTURED`, with these side branches:
- `LINK_ISSUED -> LINK_EXPIRED`
- `AUTHORISED -> AUTHORISATION_EXPIRING -> AUTHORISATION_EXPIRED`
- `CAPTURED -> PARTIALLY_REFUNDED/REFUNDED`
- `* -> FAILED|CANCELED`

A transition is applied only if the event's `linkVersion` equals the current `linkVersion` (events for replaced links are recorded and ignored) and the rank increases. `LINK_EXPIRED`, `AUTHORISATION_EXPIRED`, `FAILED` and `CANCELED` allow a new `REPLACE`.

### 5.4 Retry and idempotency

| Hop | Rule |
|---|---|
| Client -> profile | `Idempotency-Key` per `(tenant, application, key)`; same key and body -> stored response; same key with a different body -> 422 |
| profile -> account (event) | outbox relay retries with exponential backoff (1 s … 15 min, max 24 h, then alert); consumer dedupes on `(tenant, application, linkVersion)` |
| account -> Stripe | idempotency keys: session `link:{tenant}:{app}:v{n}`; capture/cancel (already present) |
| Stripe -> account (webhook) | verify signature -> dedupe `event.id` -> table -> write status, audit and outbox in **one transaction** -> 2xx. Transient error -> **500** (Stripe retries: up to 3 days in live mode, fewer attempts in test mode). Permanent (unknown PI, tenant mismatch) -> 200 plus rejection record plus alert. Target < 2 s (Checkout waits ≤ 10 s) |
| account -> profile / communication | outbox relay as above; consumers dedupe on `eventId` (`processedEvents` / comms `idempotencyKey`) and apply the conditional rank update |
| Replaced link completes late | second authorisation for the same application -> cancel the newer uncaptured PI, `canceled (superseded)` |
| Link expires (24 h) | `LINK_EXPIRED`; reissue is an explicit `REPLACE` (staff, or the applicant via portal); no automatic reissue |
| Authorisation expiring | scheduler: `requires_capture` with `capturableUntil - now ≤ 48 h` and `expiryWarnedAt` unset -> publish expiring, set `expiryWarnedAt`. profile flags the application in the CRM review queue (notification via the existing notification path) |
| Authorisation expired | `authorization_expired` -> `AUTHORISATION_EXPIRED`; approval is blocked with 409 `PAYMENT_AUTHORISATION_EXPIRED`; CRM issues a `REPLACE` link |

---

## 6. Permission matrix (proposal; no grant run, no base permission broadened)

Granted **by role code** (the `category` field is unreliable; see the header of
`grant-issues-permissions-to-roles.js`). Verify the role codes and current holdings in DEV first
(`db.roles.find({code:{$in:["IRO","BO","RO"]}},{code:1,permissions:1})`).

| Permission (resource:action) | IRO | BO | RO | CRM membership processing roles¹ | PORTAL member roles | Route(s) |
|---|---|---|---|---|---|---|
| `membership-drives:read` | ✓ | ✓ | ✓ | - | - | drive list/get/stats/registrations |
| `membership-drives:write` | ✓ | ✓ | ✓ | - | - | drive create/edit/status/delete, attribute |
| `tenant-regional-settings:read` | ✓ | ✓ | ✓ | as needed | - | user-service `GET /api/tenant/regional-settings` |
| `issues-own:read` | ✓ | ✓ | ✓ | - | - | `GET /issues/mine`, `/mine/:id` |
| `issues-own:write` | ✓ | ✓ | ✓ | - | - | `POST /issues/mine` (IR), `PUT /mine/:id`, `/status`, activities (owner rules) |
| `application-payment-links:write` | ✓ | ✓ | ✓ | ✓ | - | `POST /applications/:id/payment-link` (staff) |
| `application-payment-links:read` | ✓ | ✓ | ✓ | ✓ | - | `GET /applications/:id/payment` (staff) |
| `portal:write` / `portal:read` (existing) | - | - | - | - | already held | same two routes, applicant's own application only |

¹ The roles that process applications in CRM today. Confirm the codes with the business; they are
not inferred here.

Explicitly **not** granted: base `issues:read/write`, any `issues-<team>:*`, `tenant:read`, any
account-service or communication-service permission (those paths are event-driven/internal).

---

## 7. D1-D6 targeted plan

| Defect | Fix | Where | Test |
|---|---|---|---|
| D1 status regression | state machine (5.1) replaces `resolveWebhookStatus`; shadow mode logs disagreements for one release first | account `paymentStateMachine.js` | table-driven: every cell; out-of-order requires_action after requires_capture; 2018 names |
| D2 lost events | 500 on transient, 200 plus rejection record on permanent; status, audit and outbox in one transaction | `webhook.controller.js`, `reconcileStripeEvent` | DB/Rabbit down -> 500 and Stripe retry succeeds; duplicate `event.id` no-op |
| D3 API version | new endpoint pinned to **`2024-06-20`** (= SDK `apiVersion`); payload normaliser kept during the overlap | Stripe config (later), normaliser in code now | normaliser unit tests on recorded 2018 and 2024 payloads |
| D4 missing events | new endpoint subscribes: `payment_intent.{created,requires_action,processing,payment_failed,amount_capturable_updated,succeeded,canceled}`, `checkout.session.{completed,expired}`, `charge.refunded`, `charge.refund.updated`, `refund.{created,updated,failed}` | Stripe config (later) | replay fixtures for each type |
| D5 expiry | `capturableUntil` from `capture_before`; 48 h warning event; approval guard | account scheduler, profile listener and approval | clock-controlled scheduler tests; approval after expiry -> 409 |
| D6 capture vs approval | capture keeps its idempotency key; a profile listener on `status-changed(to: succeeded)` flags `captureWithoutApproval` when the application is not `processed` after 15 min; a daily reconciliation report lists both mismatch directions; re-running approval is safe (capture on an already-succeeded PI returns `succeeded`) | profile listener, account report | commit failure after capture -> re-approve succeeds without a second capture |

**Endpoint replacement procedure** (change-controlled, later):
1. Create the new endpoint (DEV, test mode) with version `2024-06-20` and the D4 list, plus its own secret.
2. account-service accepts **both** secrets (`STRIPE_WEBHOOK_SECRETS` list); dedupe by `event.id` prevents double processing, since both endpoints deliver the same events.
3. Validate: 48 h of identical outcomes, zero rejections caused by the version, `stripe events resend` for one of each type.
4. Disable the old endpoint, then remove its secret.

---

## 8. Test plan

1. **Pure unit:** state machine table (every cell), link state machine, price helper (full,
   first instalment rounding at .5 cents, `allowFirstInstalment` missing -> refuse, no-fee category -> 0
   -> `PAYMENT_NOT_REQUIRED`), 2018/2024 normaliser, `capture_before` extraction.
2. **account-service integration** (in-memory or mocked Stripe):
   - redelivered `requested.v1` returns the same link with no second session
   - `REPLACE` expires the old session
   - `REPLACE` after authorisation -> `ALREADY_AUTHORISED`
   - two concurrent authorisations -> the newer is cancelled
   - webhook transient -> 500; duplicate event -> no-op
   - link payment never publishes the legacy `application.status.updated`
3. **profile-service integration:**
   - endpoint rules: portal applicant only, staff in tenant, every 409
   - idempotency-key replay and mismatch
   - listeners: out-of-order (`status-changed` before `issued`), stale `linkVersion` ignored, duplicate `eventId` no-op
   - no application created from any payment event
   - approval uses the link payment and is blocked after authorisation expiry
   - bulk approval matches
4. **Tenant A/B at every hop:** endpoint, outbox payload tenant, account consumer (envelope tenant
   must match the persisted application and payment), webhook (persisted payment tenant wins),
   profile listener, communication dedupe key.
5. **issue-service `issues-own`:**
   - A/B matrix on every route
   - not owner -> read-only; another staff member's case -> 404
   - non-IR create -> 400
   - complaint-hide holds
   - base-write-only caller on `POST /issues` -> 403 after the team-write fix
6. **Drives (done):** 54 tests. Add one when the user-service route ships: a real 200 drives `today`.
7. **Contract tests:** JSON Schema per event under each repo's `tests/contracts/`, same fixtures
   in producer and consumer.
8. **Stripe test-mode E2E on DEV** (approval required):
   - full and first-instalment links paid with `4242…` -> AUTHORISED -> approve -> CAPTURED
   - 3DS card `4000 0025 0000 3155`
   - decline `4000 0000 0000 9995`
   - link expiry
   - replace
   - authorisation expiry (shortened in test via cancel with `abandoned`)
   - partial and full refund from the Dashboard

---

## 9. Minimal implementation order

1. **rabbitmq-middleware**: mapping entries (one small commit).
2. **account-service `feature/payment-lifecycle`**: normaliser plus state machine (shadow), webhook
   500/rejections, outbox, `capture_before` and the expiry scheduler. No behaviour change in shadow mode.
3. **Primary session**: `tenant-regional-settings` route; `allowFirstInstalment` product field and
   sync; grant scripts (review the matrix in section 6); confirm the `POST /issues` team-write fix.
4. **issue-service**: `issues-own` routes plus the team-write fix (on approval of step 3).
5. **account-service `feature/application-payment-link`**: price helper, `PaymentLink`, consumer, publishers.
6. **profile-service `feature/application-payment-link`**: endpoints, listeners, approval wiring.
7. **communication-service**: email listener and template.
8. **Stripe**: new endpoint (section 7 procedure); switch the state machine from shadow to authoritative.
9. **Frontends**: MembersHub -> CRM -> portal (phase 3: portal-service forwards "pay later" applications).

Each step is its own reviewed feature branch with the tests above, stopping before merge or deploy.

---

## 10. Dependencies on the primary UAT/security session

| # | Needed | Blocks |
|---|---|---|
| 1 | `GET /api/tenant/regional-settings` + `tenant-regional-settings:read` | org timezone for drives (Dublin until then) |
| 2 | Grants per section 6 (after review) | every drive route, `issues-own`, payment-link routes (403 until then) |
| 3 | Confirmation that IRO/BO/RO role codes and holdings match the grant script (DB read) | grant correctness |
| 4 | `Product.paymentOptions.allowFirstInstalment` + sync | first-instalment links (full payment works without it) |
| 5 | Decision on the `POST /issues` team-write fix (behaviour change for base-write roles) | issue-service step 4 |
| 6 | Stripe endpoint replacement window and secret handling (`STRIPE_WEBHOOK_SECRETS` env) | D3/D4 cut-over |
| 7 | Approval to run the Stripe test-mode E2E against DEV | empirical confirmation in section 0 |
| 8 | Whether a first instalment changes the subscription's `paymentFrequency`, and who collects instalments 2-4 (subscription-service) | first-instalment go-live |
| 9 | Awareness: the new consumers/publishers add `payment.events` bindings to profile-service and use the tenant envelope; they must pass `TENANT_CONTEXT_MODE=enforce` checks | all event work |
