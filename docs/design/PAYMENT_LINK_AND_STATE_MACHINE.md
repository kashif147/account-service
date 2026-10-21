# Deferred payment links and the payment state machine

Status: **design, for review** (2026-10-21). **Superseded where it differs by
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)** (approved decisions: card-only full or
first-instalment payment, no legacy `application.status.updated` for link payments,
`capture_before`-based expiry warnings, full permission matrix). Nothing here is implemented or deployed; active
payment processing is unchanged. Branch `feature/payment-link-design` (account-service).

Approved architecture:

- **profile-service** owns the application lifecycle.
- **account-service** owns payments and verified Stripe events.
- **communication-service** delivers email.
- Portal, CRM and MembersHub use **one shared workflow**.

---

## 1. Stripe investigation (read-only findings)

Read with the Stripe CLI (the test-mode account), no writes:

| Item | Finding |
|---|---|
| Enabled webhook endpoint | **one**: `https://<dev-vm-host>:8443/account-service/api/webhook/stripe` (DEV gateway, `livemode: false`) |
| Endpoint API version | **`2018-02-28`** - the SDK pins `2024-06-20` (`src/lib/stripe.js`) |
| Subscribed events | `payment_intent.{amount_capturable_updated,succeeded,payment_failed,canceled,requires_action}` - **no** `checkout.session.*`, **no** `charge.refunded` / `refund.*` |
| Second endpoint | legacy Azure App Service URL, `disabled` |
| Delivery | `pending_webhooks = 0` on all of the last 100 events: Stripe considers every event delivered |

Last 100 events, grouped per PaymentIntent (application ids hashed):

- Every confirmed card was **authorised immediately** (`amount_capturable_updated` at +0.0h).
  No `payment_intent.requires_action` event at all: no 3-D Secure in these flows.
- **5 authorised intents were auto-cancelled at exactly +168h** (`cancellation_reason:
  automatic`): Stripe releases an uncaptured card authorisation after 7 days. These were never
  captured, so they never became `succeeded`.
- 4 intents were cancelled within 0-0.3h of authorisation - superseded retry attempts for the
  same application (one application has 6 cancelled intents before one `requires_capture`).
- 5 intents were created and never confirmed. They show as `requires_source` (the 2018 name for
  `requires_payment_method`) and stay `requires_action` in our Payment collection - this is
  the domain status for *every* new intent (`mapStripeStatusToDomain`), not a 3DS state.
- Only one `payment_intent.succeeded` in the window, on an automatic-capture intent without
  tenant metadata.

### Diagnosis of "stuck at action_required, never succeeded"

1. `requires_action` on a Payment means "created, not yet confirmed by the payer". If the
   payer abandons or the client never confirms, it stays there - nothing will ever move it.
2. Application payments use **manual capture** (`payments.service.js:421`). A healthy payment
   goes `requires_action -> requires_capture` within seconds and only becomes `succeeded` when
   CRM approval captures it (`profileApproval.controller.js` -> account `POST
   /intents/:id/capture`). If approval does not happen within 7 days, Stripe cancels the
   authorisation and the payment ends `authorization_expired`.
3. portal-service submits the application on `requires_capture` (its listener's
   `PAYMENT_CAPTURED_STATUSES`), so "not loading in CRM" means one of: the payer never
   confirmed (case 1); the webhook reached account-service but `reconcileStripeEvent` rejected
   it (`unknown_payment_intent` / `tenant_mismatch` - the handler still answers **200**,
   `webhook.controller.js:46-48`, so Stripe shows it delivered); or the
   `application.status.updated` publish / portal listener failed.

**To confirm on DEV (read-only):** for one stuck application, compare the Stripe PI status with
`payments.findOne({ "stripe.paymentIntentId": … }, { status: 1, webhookEventIds: 1, auditTrail: 1 })`,
and grep `dev-account-service` logs for `Stripe event rejected`, `Missing tenantId in Stripe
event metadata`, `Failed to publish application payment update event`.

### Defects found (not fixed - active payment processing is frozen)

| # | Where | Defect | Impact |
|---|---|---|---|
| D1 | `payments.service.js:1257` `resolveWebhookStatus` | Only 3 regressions are guarded. A late/retried `requires_action` (or `processing`) overwrites `requires_capture` / `succeeded`, and `publishApplicationPaymentUpdate` re-publishes the regressed status | Status regression; downstream sees a paid application go back to unpaid |
| D2 | `webhook.controller.js:46` | Returns 200 on **every** processing error, including transient ones (DB down, RabbitMQ down) | Stripe never retries; event lost silently |
| D3 | Stripe endpoint config | API version `2018-02-28` vs SDK `2024-06-20`: webhook payloads use old names (`requires_source`, `requires_source_action`), no `latest_charge` | Today mostly harmless (domain status is derived from the event type, `charges.data[0]` fallback exists) but any code reading `pi.status` from a webhook body is wrong |
| D4 | Stripe endpoint config | No `checkout.session.*`, `charge.refunded`, `refund.*` subscriptions | Existing `useCheckout` path can never complete (it stores only `checkoutSessionId`, webhook looks up by `paymentIntentId`); Stripe-dashboard refunds never reach the ledger |
| D5 | Payment lifecycle | Authorisations expire after 7 days; nothing alerts CRM before that | Approved-late applications fail capture (`approveApplication` -> 409) |
| D6 | `profileApproval.controller.js` | Capture is an external side effect inside the approval transaction retry loop; if the commit then fails, the payment is captured but the application is not approved | Needs reconciliation path (capture is idempotent on retry, so re-running approval is safe) |

---

## 2. Payment state machine (account-service)

One authority for `Payment.status`, applied identically by webhooks, the read-time Stripe
refresh, capture/cancel calls and the new checkout flow.

### States

| State | Rank | Meaning | Stripe source |
|---|---|---|---|
| `created` | 0 | Payment row exists, no Stripe object yet | - |
| `requires_action` | 10 | Awaiting payer (unconfirmed, or 3DS) | PI `requires_payment_method` / `requires_confirmation` / `requires_action` (+ 2018 names `requires_source`, `requires_source_action`) |
| `processing` | 20 | Async confirmation in flight | PI `processing` |
| `failed` | 15 | Last attempt declined; payer may retry on the same PI | `payment_intent.payment_failed` |
| `requires_capture` | 30 | **Authorised**, funds held | PI `requires_capture`, `amount_capturable_updated` |
| `succeeded` | 40 | Captured | PI `succeeded` |
| `partially_refunded` | 50 | `0 < amount_refunded < amount_received` | `charge.refunded`, `refund.updated` |
| `refunded` | 60 | Fully refunded | same |
| `canceled` | T | Cancelled before capture (ours or superseded) | PI `canceled`, reason not automatic |
| `authorization_expired` | T | Stripe released an uncaptured hold | PI `canceled`, reason `automatic` / `abandoned` / `expired` |
| `payment_required` | 5 | Existing: a domain payment is due but no Stripe attempt yet | - (set by account-service) |
| `manual_review` / `refund_required` | H | Existing operational holds: finance must act. Stripe events are recorded but **never** move a held payment automatically (generalises today's `succeeded` guard); finance releases the hold to the Stripe-derived state | - |

All of these values already exist in the `Payment.status` enum (`src/models/payment.model.js`);
the change is the transition rules, not the vocabulary.

### Rules

1. **Monotonic.** An incoming status is applied only if `rank(incoming) > rank(current)`, or it
   is an allowed lateral move: `failed <-> requires_action/processing` (payer retrying),
   `requires_action/processing/failed/requires_capture -> canceled|authorization_expired`.
2. **Terminal.** `canceled`, `authorization_expired`, `refunded` accept nothing further except
   an identical re-delivery. `succeeded` only moves to `partially_refunded` / `refunded`.
3. **Stale or conflicting event -> ask Stripe.** If an event would be a regression or an
   impossible move, `paymentIntents.retrieve` (SDK version) and apply the *current* PI status
   through the same rules. Record the ignored event in `auditTrail` with `applied: false`.
4. **Idempotent.** A Stripe `event.id` already in `webhookEventIds` is a no-op (existing). A
   transition to the state the payment is already in is a no-op and publishes nothing.
5. **Publish on transition only**, with a deterministic event id
   `pay:${paymentId}:${toState}` (refunds: `pay:${paymentId}:refund:${refundId}`), via a
   transactional outbox written in the same Mongo transaction as the status update, so a
   webhook retry can neither lose nor duplicate downstream events.
6. **Webhook response.** 2xx only after the transition (or a deliberate permanent rejection:
   bad signature is 400; unknown PI / tenant mismatch is 200 + `stripeEventRejections` record +
   alert). Transient failures return **500 so Stripe retries** (fixes D2).
7. **Refunds** derive from `charge.amount_refunded` vs `amount_received`, never from counting
   events.

```
created ─▶ requires_action ◀─▶ failed
              │    ▲
              ▼    │
           processing
              │
              ▼
       requires_capture ──(capture)──▶ succeeded ─▶ partially_refunded ─▶ refunded
              │
              ├─(our cancel / superseded)─▶ canceled
              └─(7-day release)───────────▶ authorization_expired
```

Implementation lives in one pure module (`src/services/paymentStateMachine.js`:
`nextStatus(current, incoming, ctx) -> { status, applied, needsStripeRefresh }`) used by
`reconcileStripeEvent`, `refreshPaymentFromStripe`, capture/cancel, and the checkout handlers.

---

## 3. Deferred payment link

### 3.1 Flow

```
Portal / CRM / MembersHub
   │ POST /api/applications/:applicationId/payment-link        (profile-service)
   ▼
profile-service ── applications.payment-link.requested.v1 ──▶ account-service
                                                               │ price (server-side catalogue)
                                                               │ Stripe Checkout Session
                                                               │   capture_method=manual
                                                               │   expires_at=+24h
   ◀── payments.payment-link.issued.v1 ────────────────────────┘
   │ application.payment.status = LINK_ISSUED
   │ applications.payment-link.email.requested.v1 ─▶ communication-service ─▶ email
   │
payer opens link ─▶ Stripe Checkout ─▶ webhooks ─▶ account-service (state machine)
   ◀── payments.application-payment.status-changed.v1 (AUTHORISED / EXPIRED / FAILED / CAPTURED)
   │ application.payment.status updated; CRM review queue shows AUTHORISED applications
   │
CRM approval ─ capture (existing HTTP call) ─▶ CAPTURED ─▶ existing post-approval events
```

Why Stripe-hosted Checkout URLs, not our own redirect token: a session's `expires_at` can be at
most 24 h after creation (Stripe API reference), which is exactly the requirement, and it needs no
new unauthenticated route on the gateways (a gateway change is out of scope). A token-redirect
(`/pay/:token`) remains an option later if links must outlive 24 h or show our branding first.

### 3.2 API contracts

All routes are behind the gateway. Tenant and user always come from the trusted context, and request
bodies never carry `tenantId`, amounts or prices.

**profile-service: `POST /api/applications/:applicationId/payment-link`**

```json
// request
{ "reason": "INITIAL" | "RESEND" | "REPLACE", "channel": "PORTAL" | "CRM" | "MEMBERSHUB" }
// headers: Idempotency-Key: <uuid>  (required)
// 202 Accepted
{ "status": "success", "data": {
    "applicationId": "…", "linkVersion": 2, "payment": { "status": "LINK_REQUESTED" } } }
```

- Portal caller: only for their own application (`personalDetails.userId === caller`).
  Staff: any application in the tenant.
- `409 PAYMENT_NOT_REQUIRED`: the payment type isn't card, or no fee is due.
- `409 ALREADY_AUTHORISED`: a payment for this application is already `requires_capture` or `succeeded`.
- `409 APPLICATION_CLOSED`: the application is `processed` or `rejected`.
- `RESEND` re-sends the email for the current unexpired link (no new session). `INITIAL` /
  `REPLACE` bump `linkVersion` and supersede the previous link.
- Same `Idempotency-Key` + same body within 24 h returns the original response (persisted,
  not the in-memory `middlewares/idempotency.js`).

**profile-service: `GET /api/applications/:applicationId/payment`**: the application's payment
view for all three clients:

```json
{ "status": "success", "data": {
  "mode": "LINK" | "INLINE" | "NOT_REQUIRED",
  "status": "LINK_REQUESTED" | "LINK_ISSUED" | "AUTHORISED" | "CAPTURED" | "EXPIRED" | "FAILED" | "CANCELED",
  "linkVersion": 2, "expiresAt": "2026-10-22T14:03:00Z", "checkoutUrl": "https://checkout.stripe.com/…",
  "amount": 29900, "currency": "eur", "updatedAt": "…" } }
```

`checkoutUrl` is returned only to the application's own portal user and to staff, so
MembersHub can show "pay now" on the device as an alternative to the email.

**account-service: no new user-facing route.** Link issuance is event-driven. For support, add
an internal-only `GET /api/internal/payment-links?applicationId=` (`x-internal-request`, tenant
from the header).

### 3.3 Event contracts

Every event uses the standard `@projectShell/rabbitmq-middleware` envelope (`eventId`,
`eventType`, `tenantId`, `correlationId`, `timestamp`, `data`). **Each routing key must be added
to `rabbitmq-middleware/src/publisher.js` `exchangeMapping` first** (own repo, own commit), or it
silently lands on `application.events`.

| Routing key | Exchange | Producer -> consumer | Idempotency key |
|---|---|---|---|
| `applications.payment-link.requested.v1` | `application.events` | profile -> account | `link:${tenantId}:${applicationId}:v${linkVersion}` |
| `payments.payment-link.issued.v1` | `payment.events` | account -> profile | same |
| `payments.payment-link.failed.v1` | `payment.events` | account -> profile | same + `:failed` |
| `applications.payment-link.email.requested.v1` | `application.events` | profile -> communication | same + `:email:${sendSeq}` |
| `payments.application-payment.status-changed.v1` | `payment.events` | account -> profile (and portal, during migration) | `pay:${paymentId}:${toState}` |

```jsonc
// applications.payment-link.requested.v1
{ "applicationId": "…", "linkVersion": 2, "reason": "REPLACE",
  "pricing": { "membershipCategory": "…", "paymentType": "Credit Card", "paymentFrequency": "Annually" },
  "requestedBy": { "userId": "…", "userType": "CRM", "channel": "MEMBERSHUB" },
  "previousLinkVersion": 1 }
// pricing carries the *inputs*; account-service computes the amount itself.

// payments.payment-link.issued.v1
{ "applicationId": "…", "linkVersion": 2, "paymentLinkId": "…", "paymentId": "…",
  "checkoutSessionId": "cs_…", "checkoutUrl": "https://checkout.stripe.com/…",
  "expiresAt": "…", "amount": 29900, "currency": "eur",
  "pricingBasis": { "membershipCategory": "…", "annualFee": 29900, "rule": "CREDIT_CARD_ANNUAL", "catalogueVersion": "…" } }

// payments.payment-link.failed.v1
{ "applicationId": "…", "linkVersion": 2, "reason": "PRICE_UNAVAILABLE" | "ALREADY_AUTHORISED" | "STRIPE_ERROR", "retryable": false }

// applications.payment-link.email.requested.v1   (recipient resolved by profile, the data owner)
{ "applicationId": "…", "linkVersion": 2, "dedupeKey": "link:…:v2:email:1",
  "recipient": { "email": "…", "name": "…" }, "checkoutUrl": "…", "expiresAt": "…",
  "amount": 29900, "currency": "eur", "templateCode": "APPLICATION_PAYMENT_LINK" }

// payments.application-payment.status-changed.v1
{ "applicationId": "…", "paymentId": "…", "paymentIntentId": "pi_…", "linkVersion": 2,
  "from": "requires_action", "to": "requires_capture", "amount": 29900, "currency": "eur",
  "occurredAt": "…", "stripeEventId": "evt_…" }
```

The recipient is the application's correspondence email: `contactInfo.preferredEmail`
(`personal`/`work`) selects `personalEmail`/`workEmail`. account-service never holds member contact
data.

### 3.4 Server-side price determination

account-service computes the amount when it consumes `…requested.v1`, reusing what the portal
guard already enforces (`paymentIntentGuard.service.js`):

- annual fee = `getMembershipPricing({ tenantId, membershipCategory })` (synced catalogue,
  same resolver the approval listener uses);
- `paymentType === "Credit Card"` -> annual fee; any other type -> no link
  (`PAYMENT_NOT_REQUIRED`: payroll / DD / standing order are collected differently, per
  `PAYMENT_FREQUENCY_RULE.md`). Pending business confirmation: whether non-card applicants
  may still pay the first instalment by link (`Math.round(annual / 4)`, as the portal allows).
- The amount, currency and rule are frozen on the `PaymentLink` (`pricingBasis`). A catalogue
  change after issue does not alter an open link; `REPLACE` re-prices.
- The pricing inputs come from profile-service's own application record in the event, never
  from a client. CRM callers, which today bypass `assertIntentAuthorized`, get the same
  server-side price on this path.

### 3.5 Link replacement

account-service handles `…requested.v1` for `linkVersion = n`:

1. If a `PaymentLink` with this `(tenantId, applicationId, linkVersion)` exists, re-publish its
   outcome (redelivery). Done.
2. If any payment for the application is `requires_capture`/`succeeded`, publish
   `…failed.v1 { reason: ALREADY_AUTHORISED }`.
3. For each earlier link still `ISSUED`: `checkout.sessions.expire(id)`. If Stripe says the
   session already completed, stop and treat it as step 2. Otherwise mark it `REPLACED`.
4. Create the session (Stripe idempotency key = the link idempotency key), insert
   `PaymentLink{status: ISSUED}` + `Payment{status: requires_action, paymentLinkId}`, and write
   `…issued.v1` to the outbox in one transaction.

Race (old session completes between steps 3 and 4, or two sessions both authorise): the state
machine sees a second `requires_capture` for an application whose other payment is already
authorised, **cancels the newer uncaptured PI** (manual capture means no refund is needed), and
records `canceled (superseded)`.

### 3.6 Retries and idempotency (no duplicate application, no double processing)

| Risk | Guard |
|---|---|
| Client double-submit | `Idempotency-Key` persisted per `(tenantId, applicationId, key)` |
| Event redelivery profile -> account | unique `(tenantId, applicationId, linkVersion)` on `PaymentLink`; Stripe idempotency key from the same tuple |
| Stripe webhook retry | `webhookEventIds` (existing) + monotonic state machine + outbox with deterministic ids |
| Event redelivery account -> profile | `processedEvents` unique on `eventId` in profile-service + conditional update (`payment.status` rank must increase) |
| Duplicate application | Link payments **never create** applications: the application exists in profile-service before the link is requested. The legacy portal path (`profile.application.create`) already upserts by `applicationId` |
| Lost publish after DB commit | transactional outbox in account- and profile-service, relay with retry/backoff |
| Expired hold before approval | `authorization_expired` -> profile sets `EXPIRED` and surfaces "reissue link" to CRM; optional reminder at day 5 (D5) |

### 3.7 Data model changes

**account-service**
- New `PaymentLink`: `tenantId, applicationId, linkVersion, status (ISSUED|COMPLETED|EXPIRED|REPLACED|FAILED), checkoutSessionId, checkoutUrl, expiresAt, paymentId, amount, currency, pricingBasis, requestedBy {userId,userType,channel}, requestEventId, createdAt`. Indexes: unique `{tenantId, applicationId, linkVersion}`; partial unique `{tenantId, applicationId}` where `status: "ISSUED"`; `{checkoutSessionId}` unique.
- `Payment`: add `paymentLinkId` and `auditTrail[].applied` (the status enum already has every state above; rank is derived in code, not stored).
- New `outboxEvents` (`eventId` unique, `routingKey`, `payload`, `status`, `attempts`, `nextAttemptAt`) and `stripeEventRejections`.

**profile-service** (`personalDetails` = the application)
- `payment: { mode: "INLINE"|"LINK"|"NOT_REQUIRED", status, linkVersion, paymentId, checkoutUrl, expiresAt, amount, currency, lastEventId, updatedAt }`, set only by the payment-link service and listeners. The Joi create/update schemas keep rejecting it.
- New `processedEvents` (unique `eventId`, TTL 30 days), `outboxEvents`, `idempotencyKeys` (TTL 24 h).

**communication-service**
- Template `APPLICATION_PAYMENT_LINK` (email) per tenant. Dedupe through the existing
  `idempotencyKey` on the comms log (same pattern as `gapLetterComms.service.js`).

### 3.8 Affected repositories

| Repo | Change |
|---|---|
| `rabbitmq-middleware` | 5 `exchangeMapping` entries (first, own commit). Note: `members.gap-letter.requested.v1` is also unmapped today and lands on `application.events` by default |
| `account-service` | state machine, webhook handlers (`checkout.session.completed/expired`, `charge.refunded`, `refund.updated`), `PaymentLink`, consumer for `…requested.v1`, outbox |
| `profile-service` | payment-link endpoints, `payment` sub-document, listeners for `issued`/`failed`/`status-changed`, email request, CRM review filter on `payment.status` |
| `communication-service` | listener + template |
| `portal-service` | phase 3 only (see 3.10) |
| Frontends (portal, CRM, MembersHub) | "send payment link" / "pay now" / payment status badge |
| `user-service` | permission seed (section 4) - owned by the other session, proposal only |
| Stripe config | endpoint at API version `2024-06-20` with the added events (new endpoint, new secret) - change-controlled |

### 3.9 Permission / grant plan (proposal only - do not run)

| Resource:action | Route | Grant to |
|---|---|---|
| `application-payment-links:write` | `POST /applications/:id/payment-link` (staff) | roles that register members: IRO, BO, RO (+ CRM membership-processing roles) |
| `application-payment-links:read` | `GET /applications/:id/payment` (staff) | same + CRM reviewers |
| `portal:write` / `portal:read` (existing) | same routes, portal caller, own application only | MEMBER / NON-MEMBER (already held) |

No new account-service or communication-service permissions are needed: they are event-driven
and internal. Seed using a `grant-application-payment-links-permissions-to-roles.js` script
modelled on `grant-issues-permissions-to-roles.js`, granted **by role code** (the `category`
field is unreliable - see that script's header).

### 3.10 Compatibility strategy

- **Phase 1 - CRM + MembersHub.** Their applications already live in profile-service. The link
  flow is additive. The existing portal inline PaymentIntent flow and its
  `application.status.updated` -> portal-service path stay unchanged.
- **Phase 2 - state machine.** Shadow mode first: compute `nextStatus` alongside
  `resolveWebhookStatus`, log disagreements, then switch. Stand up a new Stripe endpoint
  (version `2024-06-20`, with the added events and its own secret) next to the old one. Accept both
  secrets during the cut-over, then disable the old endpoint.
- **Phase 3 - portal "pay later".** portal-service forwards a submitted card application to
  profile-service *before* payment (`payment.mode: LINK`), then uses the same endpoints. Inline
  portal payment keeps working behind a flag until retired.
- Event consumers ignore unknown fields; all new routing keys are `.v1`.

### 3.11 Tests

- **State machine (pure unit):** the full transition table, out-of-order delivery (requires_action after
  requires_capture), duplicate events, 2018-name statuses, refunds partial -> full, the
  superseded-authorisation cancel.
- **Webhook:** transient error -> 500, permanent rejection -> 200 + rejection record,
  `checkout.session.completed` links the session to its PI and applies the PI status.
- **Link issuance:** price from catalogue, never from the request; redelivery of `…requested.v1`
  returns the same link; replacement expires the old session; replacement after authorisation
  -> `ALREADY_AUTHORISED`; Stripe idempotency key reused on retry.
- **Tenant isolation (A/B)** at every hop: profile endpoint, account consumer (tenant from the
  envelope, checked against the persisted application/payment), webhook (persisted payment
  tenant wins), profile listener, communication dedupe.
- **profile-service:** portal-own-application only; staff any application in the tenant; idempotent
  POST; listener ordering (status-changed before issued); no application creation from
  payment events.
- **Contract tests** for each event payload (JSON schema), shared via fixtures.
- **Stripe test-mode E2E** (manual, DEV): issue -> pay with `4242…` -> AUTHORISED -> approve ->
  CAPTURED; let a link expire; replace a link; decline card `4000 0000 0000 0002`.

### 3.12 Implementation order

1. `rabbitmq-middleware`: `exchangeMapping` entries.
2. account-service: `paymentStateMachine` + tests, wired in shadow mode (logs only).
3. account-service: webhook 500-on-transient, rejection records, new event handlers (inert
   until the new endpoint subscribes them).
4. account-service: `PaymentLink`, outbox, `…requested.v1` consumer, `…issued/failed/status-changed` publishers.
5. profile-service: `payment` sub-document, endpoints, listeners, email request, outbox.
6. communication-service: listener + template.
7. user-service permission seed (owner: auth session) and Stripe endpoint (change-controlled).
8. Frontends: MembersHub, CRM, then portal (phase 3).
9. Switch the state machine from shadow to authoritative; disable the 2018 endpoint.

Each step is a feature branch with tests. Nothing is merged or deployed without explicit approval.
