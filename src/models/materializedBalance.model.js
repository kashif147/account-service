import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

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
// Phase 2B-PARALLEL-2: balances are per tenant. The global
// memberId_1_accountCode_1_bucket_1_year_1_ledgerDomain_1 index is dropped by
// scripts/migrations/ledger-tenancy.js; rebuilds run per tenant.
MatBalSchema.index(
  { tenantId: 1, memberId: 1, accountCode: 1, bucket: 1, year: 1, ledgerDomain: 1 },
  { unique: true },
);
MatBalSchema.index({ tenantId: 1, accountCode: 1, bucket: 1, year: 1 });
MatBalSchema.index({ tenantId: 1, amount: 1 }); // debtors/creditors scans

MatBalSchema.plugin(tenantScopedPlugin, { modelName: "MaterializedBalance" });

export default mongoose.model("MaterializedBalance", MatBalSchema);
