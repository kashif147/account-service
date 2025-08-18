import mongoose from "mongoose";

const EntrySchema = new mongoose.Schema({
  accountCode: { type: String, required: true },
  accountName: { type: String, required: true },
  dc: { type: String, enum: ["D", "C"], required: true },
  amount: { type: Number, required: true, min: 0 },
  memberId: { type: String },
  periodBucket: { type: String, enum: ["arrears", "current", "advance"] },
  revenueSubType: { type: String, enum: ["fee", "fee increase", "fee decrease", null], default: null },
  adjSubType: { type: String, enum: ["discount", null], default: null },
  memo: { type: String }
}, { _id: false });

const GLTransactionSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  docType: { type: String, required: true },
  docNo: { type: String, required: true, unique: true },
  source: { type: String, default: "accounts-service" },
  memo: { type: String },
  entries: { type: [EntrySchema], validate: v => v.length >= 2 }
}, { timestamps: true });

GLTransactionSchema.index({ date: 1 });
GLTransactionSchema.index({ "entries.memberId": 1, date: 1 });
GLTransactionSchema.index({ "entries.accountCode": 1, date: 1 });

export default mongoose.model("GLTransaction", GLTransactionSchema);
