import mongoose from "mongoose";
import { getProfileConnection } from "../config/profileDb.js";

const ProfileReadSchema = new mongoose.Schema(
  {
    tenantId: { type: String, index: true },
    membershipNumber: { type: String },
    personalInfo: { type: mongoose.Schema.Types.Mixed },
    contactInfo: { type: mongoose.Schema.Types.Mixed },
    professionalDetails: { type: mongoose.Schema.Types.Mixed },
    preferences: { type: mongoose.Schema.Types.Mixed },
  },
  { collection: "profiles", strict: false }
);

let ProfileRead = null;

/** Lazy model on profile DB connection (same collection as profile-service Profile). */
export function getProfileReadModel() {
  const conn = getProfileConnection();
  if (!conn) {
    throw new Error("Profile DB not connected; set PROFILE_MONGODB_URI");
  }
  if (!ProfileRead) {
    ProfileRead = conn.models.Profile || conn.model("Profile", ProfileReadSchema);
  }
  return ProfileRead;
}
