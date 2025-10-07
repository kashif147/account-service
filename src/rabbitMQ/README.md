# RabbitMQ Integration

This directory contains the RabbitMQ integration for the account service, providing event-driven messaging capabilities.

## Structure

```
rabbitMQ/
├── index.js          # Main exports
├── events.js         # Event system management and domain event publishing
├── publisher.js      # Message publishing functionality
├── consumer.js       # Message consumption functionality
├── events/           # Individual event type definitions
│   ├── index.js      # Combined exports from all event files
│   ├── application.events.js  # Application-related events
│   ├── balance.events.js      # Balance-related events
│   ├── invoice.events.js      # Invoice-related events
│   ├── journal.events.js      # Journal-related events
│   ├── member.events.js       # Member-related events
│   ├── payment.events.js      # Payment-related events
│   └── report.events.js       # Report-related events
└── listeners/        # Event listeners (future use)
```

## Usage

### Publishing Events

#### Using Individual Event Types (Recommended)

```javascript
import { publishDomainEvent } from "../rabbitMQ/events.js";
import { APPLICATION_EVENTS } from "../rabbitMQ/events/application.events.js";

await publishDomainEvent(
  APPLICATION_EVENTS.STATUS_UPDATED,
  {
    applicationId: "app_123",
    status: "submitted",
    paymentIntentId: "pi_123",
    tenantId: "tenant_456",
  },
  {
    source: "stripe-webhook",
    eventId: "evt_789",
  }
);
```

#### Using Combined Event Types (Backward Compatibility)

```javascript
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";

await publishDomainEvent(
  EVENT_TYPES.APPLICATION_STATUS_UPDATED,
  {
    applicationId: "app_123",
    status: "submitted",
    paymentIntentId: "pi_123",
    tenantId: "tenant_456",
  },
  {
    source: "stripe-webhook",
    eventId: "evt_789",
  }
);
```

### Event Types

#### Individual Event Files

- **Application Events**: `APPLICATION_EVENTS.STATUS_UPDATED`
- **Balance Events**: `BALANCE_EVENTS.UPDATED`, `BALANCE_EVENTS.RECALCULATED`
- **Invoice Events**: `INVOICE_EVENTS.CREATED`, `INVOICE_EVENTS.PAID`, `INVOICE_EVENTS.CANCELLED`
- **Journal Events**: `JOURNAL_EVENTS.CREATED`, `JOURNAL_EVENTS.UPDATED`, `JOURNAL_EVENTS.DELETED`
- **Member Events**: `MEMBER_EVENTS.CREATED`, `MEMBER_EVENTS.UPDATED`, `MEMBER_EVENTS.DELETED`
- **Payment Events**: `PAYMENT_EVENTS.RECEIVED`, `PAYMENT_EVENTS.REFUNDED`
- **Report Events**: `REPORT_EVENTS.GENERATED`, `REPORT_EVENTS.EXPORTED`

#### Combined Event Types (Backward Compatibility)

- `JOURNAL_CREATED`, `JOURNAL_UPDATED`, `JOURNAL_DELETED`
- `BALANCE_UPDATED`, `BALANCE_RECALCULATED`
- `MEMBER_CREATED`, `MEMBER_UPDATED`, `MEMBER_DELETED`
- `INVOICE_CREATED`, `INVOICE_PAID`, `INVOICE_CANCELLED`
- `PAYMENT_RECEIVED`, `PAYMENT_REFUNDED`
- `APPLICATION_STATUS_UPDATED`
- `REPORT_GENERATED`, `REPORT_EXPORTED`

### Queue Management

The system automatically sets up the following queues:

- `accounts.sync.members` - Member synchronization
- `accounts.journal.processing` - Journal processing
- `accounts.balance.updates` - Balance updates
- `accounts.report.generation` - Report generation

## Configuration

Set the following environment variables:

```bash
RABBIT_URL=amqp://localhost:5672  # RabbitMQ connection URL
```

## Event System Lifecycle

The event system is automatically initialized in `app.js`:

1. **Initialization**: `initEventSystem()` - Sets up RabbitMQ connection
2. **Consumer Setup**: `setupConsumers()` - Creates queues and starts consumers
3. **Graceful Shutdown**: `shutdownEventSystem()` - Stops consumers and closes connections

## Error Handling

- Failed event publishing is logged but doesn't interrupt application flow
- Consumer errors are logged and messages are not requeued
- Connection failures trigger automatic reconnection attempts

## Migration from infra/rabbit

The RabbitMQ functionality has been moved from `src/infra/rabbit/` to `src/rabbitMQ/` for better organization. All imports have been updated automatically.
