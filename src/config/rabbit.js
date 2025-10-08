// import amqplib from "amqplib";
// import logger from "./logger.js";
// import { config } from "./index.js";
// import { startMemberConsumer } from "../handlers/members.consumer.js";

// let conn;
// let ch;

// export async function connectRabbit() {
//   conn = await amqplib.connect(config.rabbitUrl);
//   ch = await conn.createChannel();
//   await ch.assertExchange(config.rabbitExchange, "topic", { durable: true });

//   // example queue for inbound member events (sync)
//   const q = await ch.assertQueue("accounts.sync.members", { durable: true });
//   await ch.bindQueue(q.queue, config.rabbitExchange, "members.*");
//   startMemberConsumer(ch, q.queue);

//   logger.info({ url: config.rabbitUrl, exchange: config.rabbitExchange }, "RabbitMQ connected");
//   return { conn, ch };
// }

// export function getChannel() {
//   if (!ch) throw new Error("Rabbit channel not ready");
//   return ch;
// }

// export async function closeRabbit() {
//   try { await ch?.close(); } catch {}
//   try { await conn?.close(); } catch {}
//   logger.info("RabbitMQ disconnected");
// }
// rabbit.js
import amqplib from "amqplib";
import logger from "./logger.js";
import { startMemberConsumer } from "../handlers/members.consumer.js";
import { AppError } from "../errors/AppError.js";

let conn;
let ch;
let stopping = false;

// Default to optional unless you explicitly set RABBIT_OPTIONAL=false
const ALLOW_START_WITHOUT_RABBIT =
  (process.env.RABBIT_OPTIONAL ?? "true").toLowerCase() !== "false";

async function initTopology(channel) {
  await channel.prefetch(10);
  await channel.assertExchange(
    process.env.RABBITMQ_EXCHANGE ||
      process.env.RABBIT_EXCHANGE ||
      "accounts.events",
    "topic",
    {
      durable: true,
    }
  );

  // inbound member events
  const q = await channel.assertQueue("accounts.sync.members", {
    durable: true,
  });
  await channel.bindQueue(
    q.queue,
    process.env.RABBITMQ_EXCHANGE ||
      process.env.RABBIT_EXCHANGE ||
      "accounts.events",
    "members.*"
  );
  startMemberConsumer(channel, q.queue);
}

async function attemptConnect() {
  const url = process.env.RABBITMQ_URL || process.env.RABBIT_URL;
  if (!url)
    throw AppError.badRequest("RabbitMQ URL not set", { config: "rabbitUrl" });

  const c = await amqplib.connect(url, {
    heartbeat: 30,
    clientProperties: { connection_name: "accounts-service" },
  });

  const channel = await c.createChannel();
  await initTopology(channel);

  c.on("error", (err) => logger.warn({ err }, "RabbitMQ connection error"));
  c.on("close", () => {
    if (!stopping) {
      logger.warn(
        "RabbitMQ connection closed. Continuing without messaging and will retry"
      );
      ch = undefined;
      reconnectLoop();
    }
  });

  channel.on("error", (err) => logger.warn({ err }, "RabbitMQ channel error"));
  channel.on("close", () => {
    if (!stopping) {
      logger.warn(
        "RabbitMQ channel closed. Continuing without messaging and will retry"
      );
      ch = undefined;
      reconnectLoop();
    }
  });

  conn = c;
  ch = channel;
  logger.info(
    {
      url,
      exchange:
        process.env.RABBITMQ_EXCHANGE ||
        process.env.RABBIT_EXCHANGE ||
        "accounts.events",
    },
    "RabbitMQ connected"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function reconnectLoop() {
  // exponential backoff up to 60s
  let delay = 5000;
  while (!stopping && !ch) {
    try {
      await attemptConnect();
      logger.info("RabbitMQ reconnected");
      return;
    } catch (err) {
      logger.warn({ delay, err: err.message }, "RabbitMQ reconnect failed");
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

export async function connectRabbit({
  allowStartWithoutRabbit = ALLOW_START_WITHOUT_RABBIT,
} = {}) {
  try {
    await attemptConnect();
  } catch (err) {
    if (allowStartWithoutRabbit) {
      logger.warn(
        { err: err.message },
        "RabbitMQ unavailable. Starting without messaging"
      );
      // try to recover in the background only if URL provided
      if (process.env.RABBITMQ_URL || process.env.RABBIT_URL) {
        reconnectLoop().catch((e) =>
          logger.error({ e }, "RabbitMQ reconnect loop crashed")
        );
      } else {
        logger.warn("RABBITMQ_URL not set; will not attempt reconnects");
      }
      return { conn: undefined, ch: undefined };
    }
    throw err;
  }
  return { conn, ch };
}

export function getChannel() {
  // may be undefined; callers should handle this or use publish() below
  return ch;
}

// Safe publish that no-ops when RabbitMQ is down
export async function publish(routingKey, payload, options = {}) {
  if (!ch) {
    logger.warn({ routingKey }, "RabbitMQ not ready. Dropping message");
    return false;
  }
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(JSON.stringify(payload));
  const ok = ch.publish(
    process.env.RABBIT_EXCHANGE || "accounts.events",
    routingKey,
    body,
    {
      persistent: true,
      contentType: "application/json",
      ...options,
    }
  );
  if (!ok) logger.warn({ routingKey }, "RabbitMQ publish returned false");
  return ok;
}

export async function closeRabbit() {
  stopping = true;
  try {
    await ch?.close();
  } catch {}
  try {
    await conn?.close();
  } catch {}
  ch = undefined;
  conn = undefined;
  logger.info("RabbitMQ disconnected");
}
