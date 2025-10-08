import { publishEvent } from "./publisher.js";
import {
  initConsumer,
  createQueue,
  consumeQueue,
  stopAllConsumers,
} from "./consumer.js";
import logger from "../config/logger.js";

// Import event types and handlers from separate event files
import {
  EVENT_TYPES,
  QUEUES,
  handleJournalEvent,
  handleBalanceEvent,
  handleMemberEvent,
  handleReportEvent,
} from "./events/index.js";

// Re-export for convenience
export { EVENT_TYPES, QUEUES };

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

// Event handlers are now imported from individual event files
// This keeps the main events.js file clean and focused on system management

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
