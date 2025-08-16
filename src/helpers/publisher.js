import { getChannel } from "../config/rabbit.js";
import { config } from "../config/index.js";

export function publishEvent(routingKey, payload) {
  const ch = getChannel();
  const body = Buffer.from(JSON.stringify(payload));
  ch.publish(config.rabbitExchange, routingKey, body, { contentType: "application/json", persistent: true });
}
