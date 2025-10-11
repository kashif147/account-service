import amqplib from "amqplib";
import logger from "../config/logger.js";

let channel;
let connection;
const consumers = new Map();

export async function initConsumer() {
  if (connection) return;

  const url = process.env.RABBIT_URL || "amqp://localhost:5672";
  logger.info(
    { url: url.replace(/\/\/.*@/, "//***@") },
    "Connecting to RabbitMQ"
  );

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

export async function createQueue(queueName, exchangeName, routingKeys = []) {
  if (!channel) await initConsumer();

  // Assert the exchange
  await channel.assertExchange(exchangeName, "topic", { durable: true });
  await channel.assertQueue(queueName, { durable: true });

  // Bind to exchange with routing keys
  for (const routingKey of routingKeys) {
    await channel.bindQueue(queueName, exchangeName, routingKey);
    logger.info(
      { queue: queueName, exchange: exchangeName, routingKey },
      "Queue bound"
    );
  }

  logger.info({ queueName, exchangeName }, "Queue created");
}

export async function consumeQueue(queueName, handler) {
  if (!channel) await initConsumer();

  logger.info({ queueName }, "Starting to consume queue");

  const consumer = await channel.consume(queueName, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      const routingKey = msg.fields.routingKey;
      const exchange = msg.fields.exchange;

      logger.info(
        {
          queueName,
          exchange,
          routingKey,
          eventId: payload.eventId,
          eventType: payload.eventType,
        },
        "Message received"
      );

      await handler(payload, routingKey, msg);
      channel.ack(msg);

      logger.info(
        { queueName, routingKey, eventId: payload.eventId },
        "Message processed successfully"
      );
    } catch (error) {
      logger.error(
        {
          queueName,
          routingKey: msg.fields.routingKey,
          error: error.message,
          stack: error.stack,
        },
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
