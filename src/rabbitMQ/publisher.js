import amqplib from "amqplib";
import logger from "../config/logger.js";

let channel;
let connection;

export async function initRabbit() {
  if (connection) return;

  const url = process.env.RABBIT_URL || "amqp://localhost:5672";
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();
  const exchange =
    process.env.RABBITMQ_EXCHANGE ||
    process.env.RABBIT_EXCHANGE ||
    "accounts.events";
  await channel.assertExchange(exchange, "topic", { durable: true });

  logger.info("RabbitMQ publisher initialized");

  // Handle connection events
  connection.on("error", (err) => {
    logger.warn({ err }, "RabbitMQ publisher connection error");
  });

  connection.on("close", () => {
    logger.warn("RabbitMQ publisher connection closed");
    channel = null;
    connection = null;
  });

  channel.on("error", (err) => {
    logger.warn({ err }, "RabbitMQ publisher channel error");
  });

  channel.on("close", () => {
    logger.warn("RabbitMQ publisher channel closed");
    channel = null;
  });
}

export async function publishEvent(routingKey, payload, options = {}) {
  try {
    if (!channel) await initRabbit();

    const messageOptions = {
      contentType: "application/json",
      persistent: true,
      timestamp: Date.now(),
      ...options,
    };

    const exchange =
      process.env.RABBITMQ_EXCHANGE ||
      process.env.RABBIT_EXCHANGE ||
      "accounts.events";
    const success = channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      messageOptions
    );

    if (success) {
      logger.debug({ routingKey }, "Event published successfully");
    } else {
      logger.warn(
        { routingKey },
        "Event publish failed - channel returned false"
      );
    }

    return success;
  } catch (error) {
    logger.error(
      { routingKey, error: error.message },
      "Failed to publish event"
    );
    return false;
  }
}

export async function closePublisher() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    logger.info("RabbitMQ publisher closed");
  } catch (error) {
    logger.warn({ error: error.message }, "Error closing publisher");
  }
}
