// Main RabbitMQ module exports - Now using shared middleware
import {
  init,
  publisher,
  consumer,
  EVENT_TYPES as MIDDLEWARE_EVENT_TYPES,
  shutdown,
  connectionManager,
} from "@projectShell/rabbitmq-middleware";

import logger from "../config/logger.js";

// Import local event definitions
import {
  APPLICATION_EVENTS,
  handleApplicationEvent,
  BATCH_PROCESS_EVENTS,
} from "./events/index.js";
import { runBatchProcessing } from "../services/batch.process.job.service.js";
import {
  handleCrmUserCreated,
  handleCrmUserUpdated,
} from "./listeners/user.crm.listener.js";
import {
  handleProductTypeCreated,
  handleProductTypeUpdated,
  handleProductTypeDeleted,
  handleProductCreated,
  handleProductUpdated,
  handleProductDeleted,
  handlePricingCreated,
  handlePricingUpdated,
  handlePricingDeleted,
} from "./listeners/product.sync.listener.js";
import {
  handleApplicationApproved,
  handleMemberCreated,
} from "../handlers/application.approval.listener.js";
import { handleSubscriptionCategoryChanged } from "./listeners/subscription.category.change.listener.js";

// Re-export for convenience
export { APPLICATION_EVENTS, BATCH_PROCESS_EVENTS };

// Initialize event system
export async function initEventSystem() {
  try {
    await init({
      url: process.env.RABBIT_URL,
      logger: logger,
      prefetch: 10,
      connectionName: "account-service",
      serviceName: "account-service",
      exchanges: [
        { name: "batch.events", type: "topic", options: { durable: true } },
      ],
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

    // Ensure user.events exchange exists on consumer channel before binding
    try {
      const consumerChannel = await connectionManager.getNamedChannel(
        "consumer",
        10
      );
      await consumerChannel.assertExchange("user.events", "topic", {
        durable: true,
      });
    } catch (error) {
      logger.warn(
        { error: error.message },
        "Failed to assert user.events exchange, will attempt binding anyway"
      );
    }

    try {
      await consumer.bindQueue(USER_QUEUE, "user.events", [
        "user.crm.created.v1",
        "user.crm.updated.v1",
      ]);

      consumer.registerHandler(
        "user.crm.created.v1",
        async (payload, context) => {
          await handleCrmUserCreated(payload);
        }
      );

      consumer.registerHandler(
        "user.crm.updated.v1",
        async (payload, context) => {
          await handleCrmUserUpdated(payload);
        }
      );

      await consumer.consume(USER_QUEUE, { prefetch: 10 });
      logger.info("CRM user events consumer ready", { queue: USER_QUEUE });
    } catch (error) {
      logger.error(
        { error: error.message, queue: USER_QUEUE },
        "Failed to set up CRM user events consumer, continuing without it"
      );
    }

    // Application approval events queue (application.events exchange)
    const APPLICATION_QUEUE = "accounts.application.events";

    // Parse prefetch from environment variable with default
    // Reduced from 100 to 50 to work with global DB limiter
    // Global limiter ensures total concurrent operations don't exceed connection pool
    const APPLICATION_PREFETCH = parseInt(
      process.env.APPLICATION_EVENTS_PREFETCH || "50",
      10
    );

    logger.info("Creating application events queue...", {
      queue: APPLICATION_QUEUE,
      exchange: "application.events",
      routingKeys: ["applications.review.approved.v1"],
      prefetch: APPLICATION_PREFETCH,
    });

    await consumer.createQueue(APPLICATION_QUEUE, {
      durable: true,
      messageTtl: 3600000, // 1 hour
    });

    // Ensure application.events exchange exists on consumer channel before binding
    try {
      const consumerChannel = await connectionManager.getNamedChannel(
        "consumer",
        10
      );
      await consumerChannel.assertExchange("application.events", "topic", {
        durable: true,
      });
    } catch (error) {
      logger.warn(
        { error: error.message },
        "Failed to assert application.events exchange, will attempt binding anyway"
      );
    }

    try {
      await consumer.bindQueue(APPLICATION_QUEUE, "application.events", [
        "applications.review.approved.v1",
      ]);

      consumer.registerHandler(
        "applications.review.approved.v1",
        async (payload) => {
          await handleApplicationApproved(payload);
        }
      );

      await consumer.consume(APPLICATION_QUEUE, {
        prefetch: APPLICATION_PREFETCH,
      });
      logger.info("Application events consumer ready", {
        queue: APPLICATION_QUEUE,
        prefetch: APPLICATION_PREFETCH,
      });
    } catch (error) {
      logger.error(
        { error: error.message, queue: APPLICATION_QUEUE },
        "Failed to set up application events consumer, continuing without it"
      );
    }

    // Product events queue (product.events exchange)
    const PRODUCT_QUEUE = "accounts.product.events";
    logger.info("Creating product events queue...", {
      queue: PRODUCT_QUEUE,
      exchange: "product.events",
      routingKeys: [
        "product.type.created.v1",
        "product.type.updated.v1",
        "product.type.deleted.v1",
        "product.created.v1",
        "product.updated.v1",
        "product.deleted.v1",
        "pricing.created.v1",
        "pricing.updated.v1",
        "pricing.deleted.v1",
      ],
    });

    await consumer.createQueue(PRODUCT_QUEUE, {
      durable: true,
      messageTtl: 3600000, // 1 hour
    });

    // Ensure product.events exchange exists on consumer channel before binding
    try {
      const consumerChannel = await connectionManager.getNamedChannel(
        "consumer",
        10
      );
      await consumerChannel.assertExchange("product.events", "topic", {
        durable: true,
      });
      logger.info("Product.events exchange asserted on consumer channel");
    } catch (error) {
      logger.warn(
        { error: error.message },
        "Failed to assert product.events exchange, will attempt binding anyway"
      );
    }

    try {
      await consumer.bindQueue(PRODUCT_QUEUE, "product.events", [
        "product.type.created.v1",
        "product.type.updated.v1",
        "product.type.deleted.v1",
        "product.created.v1",
        "product.updated.v1",
        "product.deleted.v1",
        "pricing.created.v1",
        "pricing.updated.v1",
        "pricing.deleted.v1",
      ]);

      consumer.registerHandler("product.type.created.v1", async (payload) => {
        await handleProductTypeCreated(payload);
      });
      consumer.registerHandler("product.type.updated.v1", async (payload) => {
        await handleProductTypeUpdated(payload);
      });
      consumer.registerHandler("product.type.deleted.v1", async (payload) => {
        await handleProductTypeDeleted(payload);
      });
      consumer.registerHandler("product.created.v1", async (payload) => {
        await handleProductCreated(payload);
      });
      consumer.registerHandler("product.updated.v1", async (payload) => {
        await handleProductUpdated(payload);
      });
      consumer.registerHandler("product.deleted.v1", async (payload) => {
        await handleProductDeleted(payload);
      });
      consumer.registerHandler("pricing.created.v1", async (payload) => {
        await handlePricingCreated(payload);
      });
      consumer.registerHandler("pricing.updated.v1", async (payload) => {
        await handlePricingUpdated(payload);
      });
      consumer.registerHandler("pricing.deleted.v1", async (payload) => {
        await handlePricingDeleted(payload);
      });

      await consumer.consume(PRODUCT_QUEUE, { prefetch: 10 });
      logger.info("Product events consumer ready", { queue: PRODUCT_QUEUE });
    } catch (error) {
      logger.error(
        { error: error.message, queue: PRODUCT_QUEUE },
        "Failed to set up product events consumer, continuing without it"
      );
    }

    // Membership events queue (membership.events exchange)
    // Listen to subscription current updated events which happen after member creation
    const MEMBERSHIP_QUEUE = "accounts.membership.events";

    // Reduced from 100 to 50 to work with global DB limiter
    // Global limiter ensures total concurrent operations don't exceed connection pool
    const MEMBERSHIP_PREFETCH = parseInt(
      process.env.MEMBERSHIP_EVENTS_PREFETCH || "50",
      10
    );

    logger.info("Creating membership events queue...", {
      queue: MEMBERSHIP_QUEUE,
      exchange: "membership.events",
      routingKeys: [
        "members.subscription.current.updated.v1",
        "members.subscription.category.changed.v1",
      ],
      prefetch: MEMBERSHIP_PREFETCH,
    });

    await consumer.createQueue(MEMBERSHIP_QUEUE, {
      durable: true,
      messageTtl: 3600000, // 1 hour
    });

    // Ensure membership.events exchange exists on consumer channel before binding
    try {
      const consumerChannel = await connectionManager.getNamedChannel(
        "consumer",
        10
      );
      await consumerChannel.assertExchange("membership.events", "topic", {
        durable: true,
      });
      logger.info("Membership.events exchange asserted on consumer channel");
    } catch (error) {
      logger.warn(
        { error: error.message },
        "Failed to assert membership.events exchange, will attempt binding anyway"
      );
    }

    try {
      await consumer.bindQueue(MEMBERSHIP_QUEUE, "membership.events", [
        "members.subscription.current.updated.v1",
        "members.subscription.category.changed.v1",
      ]);

      consumer.registerHandler(
        "members.subscription.category.changed.v1",
        async (payload) => {
          await handleSubscriptionCategoryChanged(payload);
        }
      );

      consumer.registerHandler(
        "members.subscription.current.updated.v1",
        async (payload) => {
          const data = payload.data || payload;
          const { applicationId, memberId, subscriptionId } = data;
          if (!subscriptionId) {
            logger.warn(
              { applicationId, memberId, profileId: data.profileId },
              "Subscription current updated without subscriptionId — skip billing"
            );
            return;
          }
          if (
            memberId == null ||
            (typeof memberId === "string" && memberId.trim() === "")
          ) {
            logger.warn(
              {
                applicationId,
                subscriptionId,
                profileId: data.profileId,
              },
              "Subscription current updated without memberId (membership number) — defer invoice/claim until event includes memberId"
            );
            return;
          }
          logger.info(
            {
              applicationId,
              memberId,
              subscriptionId,
            },
            "Subscription current updated — run invoice/claim handler"
          );
          await handleMemberCreated(payload);
        }
      );

      await consumer.consume(MEMBERSHIP_QUEUE, {
        prefetch: MEMBERSHIP_PREFETCH,
      });
      logger.info("Membership events consumer ready", {
        queue: MEMBERSHIP_QUEUE,
        prefetch: MEMBERSHIP_PREFETCH,
      });
    } catch (error) {
      logger.error(
        { error: error.message, queue: MEMBERSHIP_QUEUE },
        "Failed to set up membership events consumer, continuing without it"
      );
    }

    // Batch detail processing (batch.events exchange)
    const BATCH_PROCESS_QUEUE = "accounts.batch.process";
    try {
      const consumerChannel = await connectionManager.getNamedChannel(
        "consumer",
        10
      );
      await consumerChannel.assertExchange("batch.events", "topic", {
        durable: true,
      });
    } catch (error) {
      logger.warn(
        { error: error.message },
        "Failed to assert batch.events exchange"
      );
    }

    await consumer.createQueue(BATCH_PROCESS_QUEUE, {
      durable: true,
      messageTtl: 86400000,
    });

    await consumer.bindQueue(BATCH_PROCESS_QUEUE, "batch.events", [
      BATCH_PROCESS_EVENTS.BATCH_PROCESS_REQUESTED,
    ]);

    consumer.registerHandler(
      BATCH_PROCESS_EVENTS.BATCH_PROCESS_REQUESTED,
      async (payload) => {
        const data = payload.data || payload;
        const { batchDetailId, tenantId, userId } = data;
        if (!batchDetailId) {
          logger.error("[BatchProcess] Missing batchDetailId in payload");
          return;
        }
        const result = await runBatchProcessing(
          batchDetailId,
          tenantId || null,
          {}
        );
        await publisher.publish(
          BATCH_PROCESS_EVENTS.BATCH_PROCESS_COMPLETED,
          {
            batchDetailId,
            userId: userId || null,
            tenantId: tenantId || null,
            success: result.success,
            processed: result.processed,
            failed: result.failed,
            message: result.message,
          },
          {
            tenantId: tenantId || undefined,
            exchange: "batch.events",
            routingKey: BATCH_PROCESS_EVENTS.BATCH_PROCESS_COMPLETED,
            metadata: { service: "account-service", version: "1.0" },
          }
        );
        if (result.success) {
          logger.info(
            { batchDetailId, processed: result.processed, failed: result.failed },
            "[BatchProcess] Completed batch"
          );
        } else {
          logger.warn(
            { batchDetailId, message: result.message },
            "[BatchProcess] Batch failed"
          );
        }
      }
    );

    await consumer.consume(BATCH_PROCESS_QUEUE, { prefetch: 1 });
    logger.info({ queue: BATCH_PROCESS_QUEUE }, "Batch process consumer ready");

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
export const EVENT_TYPES = {
  ...MIDDLEWARE_EVENT_TYPES,
  ...BATCH_PROCESS_EVENTS,
};

export const QUEUES = {
  BATCH_PROCESS: "accounts.batch.process",
};
