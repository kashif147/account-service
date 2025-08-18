import mongoose from "mongoose";

/**
 * One document per (memberId, accountCode, bucket, year)
 * amount > 0 => debit balance; amount < 0 => credit balance
 */
const MatBalSchema = new mongoose.Schema({
  memberId:   { type: String },
  accountCode:{ type: String },     // 1400 or 2020 (mainly)
  bucket:     { type: String, enum: ["arrears","current","advance"]},
  year:       { type: Number },
  amount:     { type: Number, required: true },  // signed
  updatedAt:  { type: Date, default: Date.now }
}, { timestamps: false });

MatBalSchema.index({ memberId: 1, accountCode: 1, bucket: 1, year: 1 }, { unique: true });
MatBalSchema.index({ accountCode: 1, bucket: 1, year: 1 });
MatBalSchema.index({ amount: 1 }); // for fast debtors/creditors scans

export default mongoose.model("MaterializedBalance", MatBalSchema);
