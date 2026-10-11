import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const reportSnapshotSchema = new mongoose.Schema({
  type: { type: String, enum: ["month-end", "year-end"], required: true },
  label: { type: String, required: true },          // "2025-08" or "2025"
  range: {
    startISO: { type: String, required: true },
    endISO:   { type: String, required: true }
  },
  generatedAt: { type: Date, default: Date.now },
  data: { type: Object, required: true },           // the full report JSON
  lockedBy: { type: String },                       // userId or service that ran it
  notes: { type: String }
}, { timestamps: true });

// One snapshot per tenant + period; the global type_1_label_1 index is dropped by the
// ledger-tenancy migration.
reportSnapshotSchema.index({ tenantId: 1, type: 1, label: 1 }, { unique: true });

reportSnapshotSchema.plugin(tenantScopedPlugin, { modelName: "ReportSnapshot" });

export default mongoose.model("ReportSnapshot", reportSnapshotSchema);
