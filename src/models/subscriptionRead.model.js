import mongoose from "mongoose";
import { getSubscriptionConnection } from "../config/subscriptionDb.js";

const SubscriptionReadSchema = new mongoose.Schema(
  {
    tenantId: { type: String, index: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, index: true },
    subscriptionStatus: { type: String },
    paymentType: { type: String },
    paymentFrequency: { type: String },
    membershipCategory: { type: String },
    isCurrent: { type: Boolean },
    startDate: Date,
    endDate: Date,
    deleted: { type: Boolean },
  },
  { collection: "subscription", strict: false },
);

let SubscriptionRead = null;

export function getSubscriptionReadModel() {
  const conn = getSubscriptionConnection();
  if (!conn) {
    throw new Error(
      "Subscription DB not connected; set SUBSCRIPTION_MONGODB_URI",
    );
  }
  if (!SubscriptionRead) {
    SubscriptionRead =
      conn.models.subscription ||
      conn.model("subscription", SubscriptionReadSchema);
  }
  return SubscriptionRead;
}
