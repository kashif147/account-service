// Use middleware instead of legacy publisher/consumer
import {
  init,
  publisher,
  consumer,
  EVENT_TYPES as MIDDLEWARE_EVENT_TYPES,
  shutdown,
} from "@projectShell/rabbitmq-middleware";
import logger from "../config/logger.js";

// Import event types and handlers from separate event files
import { APPLICATION_EVENTS, handleApplicationEvent } from "./events/index.js";

// Re-export for convenience
export { APPLICATION_EVENTS };

// Export EVENT_TYPES as alias for APPLICATION_EVENTS (for backward compatibility)
export const EVENT_TYPES = APPLICATION_EVENTS;

// Initialize event system using middleware
export async function initEventSystem() {
  try {
    await init({
      url: process.env.RABBIT_URL,
      logger: logger,
      prefetch: 10,
      connectionName: "account-service",
      serviceName: "account-service",
    });
    logger.info("Event system initialized with middleware");
  } catch (error) {
    logger.error({ error: error.message }, "Failed to initialize event system");
    throw error;
  }
}

// Publish events with standardized payload structure using middleware
export async function publishDomainEvent(eventType, data, metadata = {}) {
  const result = await publisher.publish(eventType, data, {
    tenantId: metadata.tenantId,
    correlationId: metadata.correlationId || generateEventId(),
    metadata: {
      service: "account-service",
      version: "1.0",
      ...metadata,
    },
  });

  if (result.success) {
    logger.info(
      { eventType, eventId: result.eventId },
      "Domain event published"
    );
  } else {
    logger.error(
      { eventType, error: result.error },
      "Failed to publish domain event"
    );
  }

  return result.success;
}

// Set up consumers for different event types using middleware
export async function setupConsumers() {
  try {
    logger.info("Setting up RabbitMQ consumers...");

    // TODO: Configure consumers when account-service needs to consume events from other services
    // Example using middleware:
    // const QUEUE = "account-service.portal.events";
    // await consumer.createQueue(QUEUE, { durable: true });
    // await consumer.bindQueue(QUEUE, "portal.events", ["portal.event.*"]);
    // consumer.registerHandler("portal.event.*", handlePortalEvent);
    // await consumer.consume(QUEUE, { prefetch: 10 });

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

// Graceful shutdown using middleware
export async function shutdownEventSystem() {
  try {
    await shutdown();
    logger.info("Event system shutdown complete");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error during event system shutdown"
    );
  }
}

// Export middleware components for advanced usage
export { init, publisher, consumer, shutdown };
