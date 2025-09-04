import { publishEvent } from "./publisher.js";
import {
  initConsumer,
  createQueue,
  consumeQueue,
  stopAllConsumers,
} from "./consumer.js";
import logger from "../../config/logger.js";

// Event types and routing keys
export const EVENT_TYPES = {
  // Journal events
  JOURNAL_CREATED: "journal.created",
  JOURNAL_UPDATED: "journal.updated",
  JOURNAL_DELETED: "journal.deleted",

  // Balance events
  BALANCE_UPDATED: "balance.updated",
  BALANCE_RECALCULATED: "balance.recalculated",

  // Member events
  MEMBER_CREATED: "member.created",
  MEMBER_UPDATED: "member.updated",
  MEMBER_DELETED: "member.deleted",

  // Invoice events
  INVOICE_CREATED: "invoice.created",
  INVOICE_PAID: "invoice.paid",
  INVOICE_CANCELLED: "invoice.cancelled",

  // Payment events
  PAYMENT_RECEIVED: "payment.received",
  PAYMENT_REFUNDED: "payment.refunded",

  // Report events
  REPORT_GENERATED: "report.generated",
  REPORT_EXPORTED: "report.exported",
};

// Queue names
export const QUEUES = {
  MEMBER_SYNC: "accounts.sync.members",
  JOURNAL_PROCESSING: "accounts.journal.processing",
  BALANCE_UPDATES: "accounts.balance.updates",
  REPORT_GENERATION: "accounts.report.generation",
};

// Initialize event system
export async function initEventSystem() {
  try {
    await initConsumer();
    logger.info("Event system initialized");
  } catch (error) {
    logger.error({ error: error.message }, "Failed to initialize event system");
    throw error;
  }
}

// Publish events with standardized payload structure
export async function publishDomainEvent(eventType, data, metadata = {}) {
  const payload = {
    eventId: generateEventId(),
    eventType,
    timestamp: new Date().toISOString(),
    data,
    metadata: {
      service: "account-service",
      version: "1.0",
      ...metadata,
    },
  };

  const success = await publishEvent(eventType, payload);

  if (success) {
    logger.info(
      { eventType, eventId: payload.eventId },
      "Domain event published"
    );
  } else {
    logger.error(
      { eventType, eventId: payload.eventId },
      "Failed to publish domain event"
    );
  }

  return success;
}

// Set up consumers for different event types
export async function setupConsumers() {
  try {
    // Member sync queue
    await createQueue(QUEUES.MEMBER_SYNC, ["member.*"]);
    await consumeQueue(QUEUES.MEMBER_SYNC, handleMemberEvent);

    // Journal processing queue
    await createQueue(QUEUES.JOURNAL_PROCESSING, ["journal.*"]);
    await consumeQueue(QUEUES.JOURNAL_PROCESSING, handleJournalEvent);

    // Balance updates queue
    await createQueue(QUEUES.BALANCE_UPDATES, ["balance.*"]);
    await consumeQueue(QUEUES.BALANCE_UPDATES, handleBalanceEvent);

    // Report generation queue
    await createQueue(QUEUES.REPORT_GENERATION, ["report.*"]);
    await consumeQueue(QUEUES.REPORT_GENERATION, handleReportEvent);

    logger.info("All consumers set up successfully");
  } catch (error) {
    logger.error({ error: error.message }, "Failed to set up consumers");
    throw error;
  }
}

// Event handlers
async function handleMemberEvent(payload, routingKey, msg) {
  logger.info(
    { routingKey, eventId: payload.eventId },
    "Processing member event"
  );

  // TODO: Implement member event handling logic
  // - Update member cache
  // - Trigger balance recalculations
  // - Update related records
}

async function handleJournalEvent(payload, routingKey, msg) {
  logger.info(
    { routingKey, eventId: payload.eventId },
    "Processing journal event"
  );

  // TODO: Implement journal event handling logic
  // - Update balances
  // - Trigger reports
  // - Send notifications
}

async function handleBalanceEvent(payload, routingKey, msg) {
  logger.info(
    { routingKey, eventId: payload.eventId },
    "Processing balance event"
  );

  // TODO: Implement balance event handling logic
  // - Update materialized views
  // - Trigger notifications
  // - Update caches
}

async function handleReportEvent(payload, routingKey, msg) {
  logger.info(
    { routingKey, eventId: payload.eventId },
    "Processing report event"
  );

  // TODO: Implement report event handling logic
  // - Generate reports
  // - Send notifications
  // - Update status
}

// Utility functions
function generateEventId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Graceful shutdown
export async function shutdownEventSystem() {
  try {
    await stopAllConsumers();
    logger.info("Event system shutdown complete");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error during event system shutdown"
    );
  }
}
