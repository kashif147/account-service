import mongoose from "mongoose";

const RECON_STATUSES = [
  "unmatched",
  "auto_matched",
  "manual_matched",
  "suspense",
  "settled",
];

const ReconciliationRecordSchema = new mongoose.Schema(
  {
    clearingAccountCode: {
      type: String,
      enum: ["1210", "1220", "1230", "1240", "1250"],
      required: true,
      index: true,
    },
    glDocNo: { type: String, index: true },
    externalReference: { type: String, index: true },
    amount: { type: Number, required: true },
    reconciliationStatus: {
      type: String,
      enum: RECON_STATUSES,
      default: "unmatched",
      index: true,
    },
    matchedGlDocNo: { type: String },
    suspenseReason: { type: String },
    settlementStatus: {
      type: String,
      enum: ["PENDING", "SETTLED"],
      default: "PENDING",
    },
    settledAt: { type: Date },
    notes: { type: String },
    createdBy: { type: String },
    matchedBy: { type: String },
  },
  { timestamps: true },
);

export { RECON_STATUSES };
export default mongoose.model(
  "ReconciliationRecord",
  ReconciliationRecordSchema,
);
