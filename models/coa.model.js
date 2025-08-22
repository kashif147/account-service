// src/models/coa.model.js
import mongoose from "mongoose";

const CoASchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  type: { type: String, enum: ["Asset","Liability","Equity","Income","ContraIncome","Expense"], required: true },
  isCash: { type: Boolean, default: false },
  isClearing: { type: Boolean, default: false },
  isMemberTracked: { type: Boolean, default: false },
  isRevenue: { type: Boolean, default: false },
  isContraRevenue: { type: Boolean, default: false }
}, { timestamps: true });

CoASchema.index({ type: 1, code: 1 });

export default mongoose.model("CoA", CoASchema);
