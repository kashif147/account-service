import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const { Schema } = mongoose;

// P5 application credit hold (owner policy): an application approved onto an EXISTING profile
// (LINK / MERGE / email match) whose 2020 application credit was not transferred by a
// CLAIM-<applicationId> journal is HELD as application credit pending finance review. It is
// never moved to member credit, invoiced or refunded automatically.
//
// This row is a marker only: no journal is posted and no balance changes. One row per
// (tenantId, applicationId). Ids and amounts only - no payload, no personal data.
export const HOLD_STATUS = Object.freeze({
  PENDING: "pending_finance_review",
  // The normal subscription flow posted CLAIM-<applicationId> after the hold was recorded
  // (e.g. a returning member whose approval created a new subscription).
  RELEASED_BY_CLAIM: "released_by_claim",
});

export const HOLD_REASON = Object.freeze({
  EXISTING_PROFILE_UNALLOCATED: "EXISTING_PROFILE_APPROVAL_CREDIT_UNALLOCATED",
});

const ApplicationCreditHoldSchema = new Schema(
  {
    applicationId: { type: String, required: true, trim: true },
    memberId: { type: String, trim: true }, // membership number of the approved-onto profile
    profileId: { type: String, trim: true },
    status: {
      type: String,
      enum: Object.values(HOLD_STATUS),
      required: true,
      default: HOLD_STATUS.PENDING,
    },
    reasonCode: { type: String, enum: Object.values(HOLD_REASON), required: true },
    // Unallocated 2020 application credit (integer cents) when the hold was recorded.
    amountCentsAtDetection: { type: Number, required: true },
    detectedAt: { type: Date, required: true },
    sourceEventId: { type: String },
    correlationId: { type: String },
    releasedAt: { type: Date },
    releasedClaimDocNo: { type: String },
  },
  { timestamps: true, collection: "applicationCreditHolds" },
);

ApplicationCreditHoldSchema.plugin(tenantScopedPlugin, { modelName: "ApplicationCreditHold" });
ApplicationCreditHoldSchema.index({ tenantId: 1, applicationId: 1 }, { unique: true });
ApplicationCreditHoldSchema.index({ tenantId: 1, status: 1, detectedAt: -1 });

export const ApplicationCreditHold =
  mongoose.models.ApplicationCreditHold ||
  mongoose.model("ApplicationCreditHold", ApplicationCreditHoldSchema);
export default ApplicationCreditHold;
