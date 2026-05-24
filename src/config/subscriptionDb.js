import mongoose from "mongoose";
import logger from "./logger.js";

let subscriptionConnection = null;

/**
 * Read-only connection to subscription-service MongoDB.
 * Set SUBSCRIPTION_MONGODB_URI or SUBSCRIPTION_SERVICE_MONGO_URI.
 */
export async function connectSubscriptionDB() {
  const uri =
    process.env.SUBSCRIPTION_MONGODB_URI ||
    process.env.SUBSCRIPTION_SERVICE_MONGO_URI ||
    "";
  if (!uri) {
    logger.warn(
      "SUBSCRIPTION_MONGODB_URI not set — direct debit eligibility will use HTTP fallback only",
    );
    return null;
  }
  if (subscriptionConnection?.readyState === 1) {
    return subscriptionConnection;
  }
  subscriptionConnection = mongoose.createConnection(uri);
  await subscriptionConnection.asPromise();
  logger.info(
    { db: subscriptionConnection.name },
    "Subscription read Mongo connection ready",
  );
  return subscriptionConnection;
}

export function getSubscriptionConnection() {
  return subscriptionConnection;
}

export async function disconnectSubscriptionDB() {
  if (subscriptionConnection && subscriptionConnection.readyState !== 0) {
    await subscriptionConnection.close();
    subscriptionConnection = null;
    logger.info("Subscription read Mongo disconnected");
  }
}
