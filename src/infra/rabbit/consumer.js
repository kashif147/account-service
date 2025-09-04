import amqplib from "amqplib";
import logger from "../../config/logger.js";

let connection;
let channel;
let consumers = new Map();
let stopping = false;

export async function initConsumer() {
  if (connection) return;

  const url = process.env.RABBIT_URL || "amqp://localhost:5672";
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();

  // Set prefetch for fair dispatch
  await channel.prefetch(10);

  // Assert the exchange
  await channel.assertExchange("domain.events", "topic", { durable: true });

  logger.info("RabbitMQ consumer initialized");

  // Handle connection events
  connection.on("error", (err) => {
    logger.warn({ err }, "RabbitMQ consumer connection error");
  });

  connection.on("close", () => {
    if (!stopping) {
      logger.warn("RabbitMQ consumer connection closed, attempting reconnect");
      setTimeout(() => initConsumer(), 5000);
    }
  });

  channel.on("error", (err) => {
    logger.warn({ err }, "RabbitMQ consumer channel error");
  });

  channel.on("close", () => {
    if (!stopping) {
      logger.warn("RabbitMQ consumer channel closed, attempting reconnect");
      setTimeout(() => initConsumer(), 5000);
    }
  });
}

export async function createQueue(queueName, routingPatterns = []) {
  if (!channel) await initConsumer();

  const queue = await channel.assertQueue(queueName, { durable: true });

  // Bind to routing patterns
  for (const pattern of routingPatterns) {
    await channel.bindQueue(queue.queue, "domain.events", pattern);
  }

  logger.info(
    { queue: queue.queue, patterns: routingPatterns },
    "Queue created and bound"
  );
  return queue.queue;
}

export async function consumeQueue(queueName, handler, options = {}) {
  if (!channel) await initConsumer();

  const consumerOptions = {
    noAck: false,
    ...options,
  };

  const consumer = await channel.consume(
    queueName,
    async (msg) => {
      if (!msg) return;

      try {
        const payload = JSON.parse(msg.content.toString());
        const routingKey = msg.fields.routingKey;

        logger.debug(
          {
            queue: queueName,
            routingKey,
            messageId: msg.properties.messageId,
          },
          "Processing message"
        );

        await handler(payload, routingKey, msg);

        // Acknowledge the message
        channel.ack(msg);

        logger.debug(
          {
            queue: queueName,
            routingKey,
            messageId: msg.properties.messageId,
          },
          "Message processed successfully"
        );
      } catch (error) {
        logger.error(
          {
            queue: queueName,
            error: error.message,
            messageId: msg.properties.messageId,
          },
          "Error processing message"
        );

        // Reject the message - don't requeue on handler errors
        channel.nack(msg, false, false);
      }
    },
    consumerOptions
  );

  consumers.set(queueName, consumer);
  logger.info({ queue: queueName }, "Consumer started");

  return consumer;
}

export async function stopConsumer(queueName) {
  if (!channel) return;

  const consumer = consumers.get(queueName);
  if (consumer) {
    await channel.cancel(consumer.consumerTag);
    consumers.delete(queueName);
    logger.info({ queue: queueName }, "Consumer stopped");
  }
}

export async function stopAllConsumers() {
  stopping = true;

  for (const [queueName] of consumers) {
    await stopConsumer(queueName);
  }

  if (channel) {
    await channel.close();
  }

  if (connection) {
    await connection.close();
  }

  logger.info("All consumers stopped");
}

export function getChannel() {
  return channel;
}

export function isConnected() {
  return !!channel && channel.connection && channel.connection.state === "open";
}
