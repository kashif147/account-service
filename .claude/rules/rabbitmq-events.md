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

## Publishing

Publish via `publishDomainEvent(eventType, data, metadata)` from `src/rabbitMQ/index.js`. Routing
keys here are raw string literals, not the package's `EVENT_TYPES` constants — follow that existing
convention for new event types rather than introducing `EVENT_TYPES` usage inconsistently.
