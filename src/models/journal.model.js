// src/models/journal.model.js
import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const JournalSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Member",
      default: null,
    },
    entries: [
      {
        coaCode: { type: String, required: true }, // e.g. 1400
        amount: { type: Number, required: true },
        drCr: { type: String, enum: ["Dr", "Cr"], required: true },
        description: { type: String },
      },
    ],
    ref: { type: String }, // reference to invoice, batch, refund, etc
    tags: [{ type: String }],
  },
  { timestamps: true },
);

JournalSchema.index({ tenantId: 1, date: -1 });

JournalSchema.plugin(tenantScopedPlugin, { modelName: "Journal" });

export default mongoose.model("Journal", JournalSchema);
