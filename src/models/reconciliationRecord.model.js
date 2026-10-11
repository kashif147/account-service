import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

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
    memberId: { type: String, index: true, sparse: true },
    sourceType: {
      type: String,
      enum: ["gl", "bank"],
      default: "gl",
    },
    importBatchId: { type: String, index: true, sparse: true },
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

ReconciliationRecordSchema.index({ tenantId: 1, clearingAccountCode: 1, reconciliationStatus: 1 });
ReconciliationRecordSchema.index({ tenantId: 1, glDocNo: 1 });

export { RECON_STATUSES };
ReconciliationRecordSchema.plugin(tenantScopedPlugin, { modelName: "ReconciliationRecord" });

export default mongoose.model(
  "ReconciliationRecord",
  ReconciliationRecordSchema,
);
