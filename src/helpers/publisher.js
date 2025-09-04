// Legacy publisher helper - now using new infra/rabbit infrastructure
import { publishDomainEvent, EVENT_TYPES } from "../infra/rabbit/events.js";

/**
 * Publishes an event to RabbitMQ using the new infrastructure.
 * Returns true if queued, false if dropped.
 * @deprecated Use publishDomainEvent from infra/rabbit/events.js instead
 */
export async function publishEvent(routingKey, payload, options = {}) {
  try {
    // Convert legacy format to new domain event format
    const success = await publishDomainEvent(routingKey, payload, {
      legacy: true,
      ...options,
    });
    return !!success;
  } catch (error) {
    console.error("Failed to publish event:", error);
    return false;
  }
}

// Export event types for backward compatibility
export { EVENT_TYPES };
