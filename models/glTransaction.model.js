import mongoose from "mongoose";

const EntrySchema = new mongoose.Schema({
  accountCode: { type: String, required: true },
  dc:          { type: String, enum: ["D","C"], required: true },
  amount:      { type: Number, required: true },
  memberId:    { type: String},          // required for 1400/2020 lines
  applicationId: { type: String },                     // used before memberId exists
  periodBucket: { type: String, enum: ["arrears","current","advance"] },
  revenueSubType: { type: String },                    // e.g., "fee"
  adjSubType:     { type: String },                    // "prorata", "discount", etc.
  categoryName:   { type: String }                     // for descriptions/reports
}, { _id: false });

const GLSchema = new mongoose.Schema({
  date:     { type: Date, required: true },
  docType:  { type: String, required: true }, // Invoice, CreditNote, Receipt, WriteOff, Claim, etc.
  docNo:    { type: String, required: true, unique: true },
  memo:     { type: String },
  entries:  { type: [EntrySchema], validate: v => Array.isArray(v) && v.length >= 2 }
}, { timestamps: true });

// Helpful compound indexes for reporting and lookups
GLSchema.index({ "entries.memberId": 1, date: -1 });
GLSchema.index({ "entries.periodBucket": 1, date: -1 });
GLSchema.index({ "entries.adjSubType": 1, date: -1 });
GLSchema.index({ "entries.accountCode": 1, date: -1 });
GLSchema.index({ docType: 1, date: -1 });

// Fast docNo fetch (already unique)
GLSchema.index({ docNo: 1 }, { unique: true });

// Optional: text index on memo/category for search
GLSchema.index({ memo: "text", "entries.categoryName": "text" });

export default mongoose.model("GLTransaction", GLSchema);
