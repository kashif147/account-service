import amqplib from "amqplib";
import logger from "./logger.js";
import { config } from "./index.js";
import { startMemberConsumer } from "../handlers/members.consumer.js";

let conn;
let ch;

export async function connectRabbit() {
  conn = await amqplib.connect(config.rabbitUrl);
  ch = await conn.createChannel();
  await ch.assertExchange(config.rabbitExchange, "topic", { durable: true });

  // example queue for inbound member events (sync)
  const q = await ch.assertQueue("accounts.sync.members", { durable: true });
  await ch.bindQueue(q.queue, config.rabbitExchange, "members.*");
  startMemberConsumer(ch, q.queue);

  logger.info({ url: config.rabbitUrl, exchange: config.rabbitExchange }, "RabbitMQ connected");
  return { conn, ch };
}

export function getChannel() {
  if (!ch) throw new Error("Rabbit channel not ready");
  return ch;
}

export async function closeRabbit() {
  try { await ch?.close(); } catch {}
  try { await conn?.close(); } catch {}
  logger.info("RabbitMQ disconnected");
}
