import mongoose from "mongoose";

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

reportSnapshotSchema.index({ type: 1, label: 1 }, { unique: true });

export default mongoose.model("ReportSnapshot", reportSnapshotSchema);
