import amqplib from "amqplib";
import logger from "../config/logger.js";

let channel;
let connection;
const consumers = new Map();

export async function initConsumer() {
  if (connection) return;

  const url = process.env.RABBIT_URL || "amqp://localhost:5672";
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();

  logger.info("RabbitMQ consumer initialized");

  // Handle connection events
  connection.on("error", (err) => {
    logger.warn({ err }, "RabbitMQ consumer connection error");
  });

  connection.on("close", () => {
    logger.warn("RabbitMQ consumer connection closed");
    channel = null;
    connection = null;
    consumers.clear();
  });

  channel.on("error", (err) => {
    logger.warn({ err }, "RabbitMQ consumer channel error");
  });

  channel.on("close", () => {
    logger.warn("RabbitMQ consumer channel closed");
    channel = null;
    consumers.clear();
  });
}

export async function createQueue(queueName, routingKeys = []) {
  if (!channel) await initConsumer();

  await channel.assertQueue(queueName, { durable: true });

  // Bind to exchange with routing keys
  for (const routingKey of routingKeys) {
    await channel.bindQueue(queueName, "domain.events", routingKey);
  }

  logger.info({ queueName, routingKeys }, "Queue created and bound");
}

export async function consumeQueue(queueName, handler) {
  if (!channel) await initConsumer();

  const consumer = await channel.consume(queueName, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      const routingKey = msg.fields.routingKey;

      logger.debug(
        { queueName, routingKey, eventId: payload.eventId },
        "Processing message"
      );

      await handler(payload, routingKey, msg);
      channel.ack(msg);
    } catch (error) {
      logger.error(
        { queueName, error: error.message },
        "Error processing message"
      );
      channel.nack(msg, false, false); // Don't requeue on error
    }
  });

  consumers.set(queueName, consumer);
  logger.info({ queueName }, "Consumer started");
}

export async function stopAllConsumers() {
  for (const [queueName, consumer] of consumers) {
    try {
      await channel.cancel(consumer.consumerTag);
      logger.info({ queueName }, "Consumer stopped");
    } catch (error) {
      logger.warn(
        { queueName, error: error.message },
        "Error stopping consumer"
      );
    }
  }
  consumers.clear();
}
