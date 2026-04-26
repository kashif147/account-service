import mongoose from "mongoose";
import { getSubscriptionConnection } from "../config/subscriptionDb.js";

const SubscriptionReadSchema = new mongoose.Schema(
  {
    tenantId: { type: String, index: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, index: true },
    isCurrent: { type: Boolean, default: false },
    subscriptionStatus: { type: String, default: null },
    startDate: { type: Date },
    createdAt: { type: Date },
    deleted: { type: Boolean, default: false },
  },
  { collection: "subscription", strict: false },
);

let SubscriptionRead = null;

export function getSubscriptionReadModel() {
  const conn = getSubscriptionConnection();
  if (!conn) {
    throw new Error("Subscription DB not connected; set SUBSCRIPTION_MONGODB_URI");
  }
  if (!SubscriptionRead) {
    SubscriptionRead =
      conn.models.SubscriptionRead ||
      conn.model("SubscriptionRead", SubscriptionReadSchema);
  }
  return SubscriptionRead;
}
