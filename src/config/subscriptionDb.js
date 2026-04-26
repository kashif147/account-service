import mongoose from "mongoose";
import logger from "./logger.js";

let subscriptionConnection = null;

/**
 * Read-only connection to subscription-service MongoDB (Subscription collection).
 * Used to enrich batch-detail rows with membershipStatus. Set SUBSCRIPTION_MONGODB_URI
 * (or reuse subscription-service connection string) alongside PROFILE_MONGODB_URI.
 */
export async function connectSubscriptionDB() {
  const uri =
    process.env.SUBSCRIPTION_MONGODB_URI ||
    process.env.SUBSCRIPTION_SERVICE_MONGO_URI ||
    "";
  if (!uri) {
    logger.warn(
      "SUBSCRIPTION_MONGODB_URI not set — batch membership status enrichment skipped",
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
