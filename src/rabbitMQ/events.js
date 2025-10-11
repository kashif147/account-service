import { publishEvent } from "./publisher.js";
import {
  initConsumer,
  createQueue,
  consumeQueue,
  stopAllConsumers,
} from "./consumer.js";
import logger from "../config/logger.js";

// Import event types and handlers from separate event files
import { APPLICATION_EVENTS, handleApplicationEvent } from "./events/index.js";

// Re-export for convenience
export { APPLICATION_EVENTS };

// Export EVENT_TYPES as alias for APPLICATION_EVENTS (for backward compatibility)
export const EVENT_TYPES = APPLICATION_EVENTS;

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
    logger.info("Setting up RabbitMQ consumers...");

    // TODO: Configure consumers when account-service needs to consume events from other services
    // Example:
    // await createQueue("account-service.portal.events", "portal.events", ["portal.event.*"]);
    // await consumeQueue("account-service.portal.events", handlePortalEvent);

    logger.info("All consumers set up successfully (none configured yet)");
  } catch (error) {
    logger.error({ error: error.message }, "Failed to set up consumers");
    throw error;
  }
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
