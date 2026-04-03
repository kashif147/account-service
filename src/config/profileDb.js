import mongoose from "mongoose";
import logger from "./logger.js";

let profileConnection = null;

/**
 * Read-only connection to profile-service MongoDB (membership / Profile collection).
 * Used by batch detail Excel matching. Set PROFILE_MONGODB_URI or PROFILE_SERVICE_MONGO_URI.
 */
export async function connectProfileDB() {
  const uri =
    process.env.PROFILE_MONGODB_URI ||
    process.env.PROFILE_SERVICE_MONGO_URI ||
    "";
  if (!uri) {
    logger.warn(
      "PROFILE_MONGODB_URI not set — batch profile matching will fail until configured"
    );
    return null;
  }
  if (profileConnection?.readyState === 1) {
    return profileConnection;
  }
  profileConnection = mongoose.createConnection(uri);
  await profileConnection.asPromise();
  logger.info(
    { db: profileConnection.name },
    "Profile read Mongo connection ready"
  );
  return profileConnection;
}

export function getProfileConnection() {
  return profileConnection;
}

export async function disconnectProfileDB() {
  if (profileConnection && profileConnection.readyState !== 0) {
    await profileConnection.close();
    profileConnection = null;
    logger.info("Profile read Mongo disconnected");
  }
}
