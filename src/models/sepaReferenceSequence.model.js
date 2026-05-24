import mongoose from "mongoose";

/**
 * Atomic counters for SEPA reference generation.
 * scopeKey examples:
 *   DD_RUN_NO  → "INMO|MONTHLY|202605"
 *   DD_MSG_ID  → "INMO|20260525"
 *   DD_PMT_INF → "INMO|MAY25"
 */
const SepaReferenceSequenceSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    scope: {
      type: String,
      required: true,
      enum: ["DD_RUN_NO", "DD_MSG_ID", "DD_PMT_INF"],
    },
    scopeKey: { type: String, required: true, trim: true },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: "separeferencesequences" },
);

SepaReferenceSequenceSchema.index(
  { tenantId: 1, scope: 1, scopeKey: 1 },
  { unique: true },
);

export default mongoose.model("SepaReferenceSequence", SepaReferenceSequenceSchema);
