// src/models/balance.model.js
import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const BalanceSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", default: null },
  coaCode: { type: String, required: true }, // always matches a CoA.code
  bucket: { type: String, enum: ["Arrears", "Current", "Advance"], default: "Current" },
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  balance: { type: Number, default: 0 }
}, { timestamps: true });

// Unique per tenant (Phase 2B-PARALLEL-2). The legacy global memberId_1_coaCode_1_bucket_1
// index is dropped by scripts/migrations/ledger-tenancy.js.
BalanceSchema.index({ tenantId: 1, memberId: 1, coaCode: 1, bucket: 1 }, { unique: true });

BalanceSchema.plugin(tenantScopedPlugin, { modelName: "Balance" });

export default mongoose.model("Balance", BalanceSchema);
