import logger from "../config/logger.js";
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";

// Example consumer to sync member changes from the Members service
export function startMemberConsumer(channel, queue) {
  channel.consume(
    queue,
    async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        const routingKey = msg.fields.routingKey;

        logger.info(
          { routingKey, eventId: payload.eventId },
          "Processing member event"
        );

        // Process member event based on routing key
        switch (routingKey) {
          case "member.created":
            await handleMemberCreated(payload);
            break;
          case "member.updated":
            await handleMemberUpdated(payload);
            break;
          case "member.deleted":
            await handleMemberDeleted(payload);
            break;
          default:
            logger.warn({ routingKey }, "Unknown member event type");
        }

        channel.ack(msg);
      } catch (e) {
        logger.error({ error: e.message }, "Error processing member event");
        channel.nack(msg, false, false); // dead-letter on parse errors
      }
    },
    { noAck: false }
  );
}

async function handleMemberCreated(payload) {
  logger.info(
    { memberId: payload.data.memberId },
    "Handling member created event"
  );

  // TODO: Implement member creation logic
  // - Create member record in local cache
  // - Initialize member balances
  // - Set up member-specific accounts

  // Publish balance recalculation event
  await publishDomainEvent(
    EVENT_TYPES.BALANCE_RECALCULATED,
    {
      memberId: payload.data.memberId,
      reason: "member_created",
    },
    {
      source: "members.consumer",
      operation: "handleMemberCreated",
    }
  );
}

async function handleMemberUpdated(payload) {
  logger.info(
    { memberId: payload.data.memberId },
    "Handling member updated event"
  );

  // TODO: Implement member update logic
  // - Update member record in local cache
  // - Handle membership changes
  // - Update related records
}

async function handleMemberDeleted(payload) {
  logger.info(
    { memberId: payload.data.memberId },
    "Handling member deleted event"
  );

  // TODO: Implement member deletion logic
  // - Mark member as inactive
  // - Handle outstanding balances
  // - Clean up member-specific data
}
