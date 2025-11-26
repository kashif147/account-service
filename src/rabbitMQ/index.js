// Main RabbitMQ module exports - Now using shared middleware
import {
  init,
  publisher,
  consumer,
  EVENT_TYPES as MIDDLEWARE_EVENT_TYPES,
  shutdown,
} from "@projectShell/rabbitmq-middleware";

import logger from "../config/logger.js";

// Import local event definitions
import { APPLICATION_EVENTS, handleApplicationEvent } from "./events/index.js";
import {
  handleCrmUserCreated,
  handleCrmUserUpdated,
} from "./listeners/user.crm.listener.js";

// Re-export for convenience
export { APPLICATION_EVENTS };

// Initialize event system
export async function initEventSystem() {
  try {
    await init({
      url: process.env.RABBIT_URL,
      logger: logger,
      prefetch: 10,
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

    // CRM user events queue (user.events exchange)
    const USER_QUEUE = "accounts.user.events";
    logger.info("Creating CRM user events queue...", {
      queue: USER_QUEUE,
      exchange: "user.events",
      routingKeys: ["user.crm.created.v1", "user.crm.updated.v1"],
    });

    await consumer.createQueue(USER_QUEUE, {
      durable: true,
      messageTtl: 3600000, // 1 hour
    });

    await consumer.bindQueue(USER_QUEUE, "user.events", [
      "user.crm.created.v1",
      "user.crm.updated.v1",
    ]);

    consumer.registerHandler("user.crm.created.v1", async (payload, context) => {
      await handleCrmUserCreated(payload);
    });

    consumer.registerHandler("user.crm.updated.v1", async (payload, context) => {
      await handleCrmUserUpdated(payload);
    });

    await consumer.consume(USER_QUEUE, { prefetch: 10 });
    logger.info("CRM user events consumer ready", { queue: USER_QUEUE });

    logger.info("All consumers set up successfully");
  } catch (error) {
    logger.error({ error: error.message }, "Failed to set up consumers");
    throw error;
  }
}

// Utility function
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

// Export middleware components
export { init, publisher, consumer, shutdown };

// Export event types
export const EVENT_TYPES = MIDDLEWARE_EVENT_TYPES;
