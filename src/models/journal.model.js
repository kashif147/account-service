// src/models/journal.model.js
import mongoose from "mongoose";

const JournalSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", default: null },
  entries: [
    {
      coaCode: { type: String, required: true }, // e.g. 1400
      amount: { type: Number, required: true },
      drCr: { type: String, enum: ["Dr", "Cr"], required: true },
      description: { type: String }
    }
  ],
  ref: { type: String }, // reference to invoice, batch, refund, etc
  tags: [{ type: String }]
}, { timestamps: true });

export default mongoose.model("Journal", JournalSchema);
