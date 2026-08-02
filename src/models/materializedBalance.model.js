import mongoose from "mongoose";

/**
 * One document per (memberId, accountCode, bucket, year, ledgerDomain)
 * amount > 0 => debit balance; amount < 0 => credit balance
 *
 * ledgerDomain keeps membership and events/courses money in separate rows even though both
 * domains post to the same account codes (1400 AR, 2020 POA) - see glTransaction.model.js's
 * EntrySchema.ledgerDomain, the source of truth this is rolled up from. default: "membership"
 * so every pre-existing row (all written before this field existed) keeps matching
 * membership-only queries unchanged.
 */
const MatBalSchema = new mongoose.Schema({
  memberId:   { type: String },
  accountCode:{ type: String },     // 1400 or 2020 (mainly)
  bucket:     { type: String, enum: ["arrears","current","advance"]},
  year:       { type: Number },
  ledgerDomain: { type: String, enum: ["membership", "events"], default: "membership" },
  amount:     { type: Number, required: true },  // signed
  updatedAt:  { type: Date, default: Date.now }
}, { timestamps: false });

// NOTE: replaces the old { memberId, accountCode, bucket, year } unique index - the old index
// must be dropped in every environment (it would otherwise still reject two docs that differ
// only by ledgerDomain). See scripts/rebuild-materialized-balances.js, which drops it before
// rebuilding.
MatBalSchema.index({ memberId: 1, accountCode: 1, bucket: 1, year: 1, ledgerDomain: 1 }, { unique: true });
MatBalSchema.index({ accountCode: 1, bucket: 1, year: 1 });
MatBalSchema.index({ amount: 1 }); // for fast debtors/creditors scans

export default mongoose.model("MaterializedBalance", MatBalSchema);
