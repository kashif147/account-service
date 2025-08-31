// import { getChannel } from "../config/rabbit.js";
// import { config } from "../config/index.js";

// export function publishEvent(routingKey, payload) {
//   const ch = getChannel();
//   const body = Buffer.from(JSON.stringify(payload));
//   ch.publish(config.rabbitExchange, routingKey, body, { contentType: "application/json", persistent: true });
// }
// publisher.js
import { publish as mqPublish } from "../config/rabbit.js";

/**
 * Publishes an event to RabbitMQ. Returns true if queued, false if dropped.
 */
export async function publishEvent(routingKey, payload, options = {}) {
  try {
    const ok = await mqPublish(routingKey, payload, options);
    return !!ok;
  } catch {
    return false;
  }
}
