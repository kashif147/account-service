# RabbitMQ Event Infrastructure

This service uses RabbitMQ for event-driven communication with standardized domain events.

## Architecture

### Exchange

- **Name**: `domain.events`
- **Type**: Topic
- **Durability**: Durable

### Queues

- `accounts.sync.members` - Member synchronization events
- `accounts.journal.processing` - Journal processing events
- `accounts.balance.updates` - Balance update events
- `accounts.report.generation` - Report generation events

## Event Types

### Journal Events

- `journal.created` - New journal entry created
- `journal.updated` - Journal entry updated
- `journal.deleted` - Journal entry deleted

### Balance Events

- `balance.updated` - Account balance updated
- `balance.recalculated` - Balance recalculation triggered

### Member Events

- `member.created` - New member created
- `member.updated` - Member updated
- `member.deleted` - Member deleted

### Invoice Events

- `invoice.created` - New invoice created
- `invoice.paid` - Invoice paid
- `invoice.cancelled` - Invoice cancelled

### Payment Events

- `payment.received` - Payment received
- `payment.refunded` - Payment refunded

### Report Events

- `report.generated` - Report generated
- `report.exported` - Report exported

## Usage

### Publishing Events

```javascript
import { publishDomainEvent, EVENT_TYPES } from "../infra/rabbit/events.js";

// Publish a domain event
await publishDomainEvent(
  EVENT_TYPES.JOURNAL_CREATED,
  {
    journalId: txn._id,
    docNo: txn.docNo,
    docType: txn.docType,
    // ... other data
  },
  {
    source: "journal.controller",
    operation: "postBalancedJournal",
  }
);
```

### Consuming Events

```javascript
import { createQueue, consumeQueue } from "../infra/rabbit/consumer.js";

// Create a queue and bind to routing patterns
await createQueue("my.queue", ["journal.*", "balance.*"]);

// Consume messages
await consumeQueue("my.queue", async (payload, routingKey, msg) => {
  // Process the message
  console.log("Processing:", routingKey, payload);
});
```

## Event Payload Structure

All domain events follow this structure:

```javascript
{
  eventId: "unique-event-id",
  eventType: "journal.created",
  timestamp: "2024-01-01T00:00:00.000Z",
  data: {
    // Event-specific data
  },
  metadata: {
    service: "account-service",
    version: "1.0",
    source: "controller-name",
    operation: "method-name"
  }
}
```

## Configuration

Set these environment variables:

```bash
RABBIT_URL=amqp://localhost:5672
RABBIT_OPTIONAL=true  # Allow service to start without RabbitMQ
```

## Health Checks

- `/health/events` - Check event system status

## Error Handling

- Failed publishes are logged but don't throw errors
- Failed consumes are logged and messages are rejected (not requeued)
- Connection failures trigger automatic reconnection
- Service can start without RabbitMQ if `RABBIT_OPTIONAL=true`

## Graceful Shutdown

The service handles SIGTERM and SIGINT signals to gracefully close RabbitMQ connections.
