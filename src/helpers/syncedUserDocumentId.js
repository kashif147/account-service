import mongoose from "mongoose";

/** _id for downstream `users` docs = user-service user ObjectId (same as userId string). */
export function syncedUserObjectId(userId) {
  const s = userId != null ? String(userId) : "";
  if (s && mongoose.Types.ObjectId.isValid(s)) {
    return new mongoose.Types.ObjectId(s);
  }
  return null;
}

export function setOnInsertSyncedUserId(userId) {
  const oid = syncedUserObjectId(userId);
  return oid ? { _id: oid } : null;
}
