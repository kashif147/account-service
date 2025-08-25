import logger from "../config/logger.js";

// Example consumer to sync member changes from the Members service
export function startMemberConsumer(channel, queue) {
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      logger.info({ routingKey: msg.fields.routingKey, payload }, "Member event");
      // TODO: Upsert member cache, or trigger side effects as needed
      channel.ack(msg);
    } catch (e) {
      channel.nack(msg, false, false); // dead-letter on parse errors
    }
  }, { noAck: false });
}
