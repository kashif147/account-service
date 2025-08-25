// src/models/balance.model.js
import mongoose from "mongoose";

const BalanceSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", default: null },
  coaCode: { type: String, required: true }, // always matches a CoA.code
  bucket: { type: String, enum: ["Arrears", "Current", "Advance"], default: "Current" },
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  balance: { type: Number, default: 0 }
}, { timestamps: true });

BalanceSchema.index({ memberId: 1, coaCode: 1, bucket: 1 }, { unique: true });

export default mongoose.model("Balance", BalanceSchema);
