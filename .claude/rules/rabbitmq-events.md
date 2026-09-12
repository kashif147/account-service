# RabbitMQ / Event system

Uses the shared `@projectShell/rabbitmq-middleware` package (GitHub: `kashif147/rabbitmq-middleware#main`).
Initialized on startup in `src/rabbitMQ/index.js` — skipped entirely if `RABBIT_URL`/`RABBITMQ_URL`
is unset, same as every other service in this platform.

## Consumed queues

| Queue | Exchange | Routing keys |
|-------|----------|-------------|
| `accounts.user.events` | `user.events` | `user.crm.created.v1`, `user.crm.updated.v1` |
| `accounts.application.events` | `application.events` | `applications.review.processed.v1` |
| `accounts.product.events` | `product.events` | `product.*.*.v1`, `pricing.*.v1` |
| `accounts.membership.events` | `membership.events` | `members.subscription.current.updated.v1` |
| `accounts.batch.process` | `batch.events` | batch process trigger/completion events |
| `accounts.events.events` | `events.events` (owned by events-service, asserted not declared) | `events.event.cancelled.v1` |

`events.event.cancelled.v1` drives `services/eventCancellationRefund.service.js`'s
`processEventCancellationRefunds()` — automatic, no-approval-gate refunds when events-service
cancels a whole event. Deliberately does **not** reuse `payments.service.js`'s `createRefund()`/
`assertRefundWithinCredit()` (that caps refunds against a member's credit balance — unrelated to
reimbursing a real captured payment on the organizer's decision) or its `postJournalForRefund()`
(membership-oriented debit lines — events/courses payments post to a different segregated set of
accounts, see `handlers/eventRegistration.approval.listener.js`). See the finance-domain doc.

## Publishing

Publish via `publishDomainEvent(eventType, data, metadata)` from `src/rabbitMQ/index.js`. Routing
keys here are raw string literals, not the package's `EVENT_TYPES` constants — follow that existing
convention for new event types rather than introducing `EVENT_TYPES` usage inconsistently.
