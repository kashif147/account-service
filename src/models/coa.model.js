// src/models/coa.model.js
import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const CoASchema = new mongoose.Schema({
  code: { type: String, required: true },
  description: { type: String, required: true },
  type: { type: String, enum: ["Asset","Liability","Equity","Income","ContraIncome","Expense"], required: true },
  isCash: { type: Boolean, default: false },
  isClearing: { type: Boolean, default: false },
  isMemberTracked: { type: Boolean, default: false },
  isRevenue: { type: Boolean, default: false },
  isContraRevenue: { type: Boolean, default: false }
}, { timestamps: true });

// Chart of Accounts rows are tenant-owned (the platform template lives in
// src/config/chartOfAccountsTemplate.js). code is unique per tenant; the legacy global
// code_1 index is dropped by scripts/migrations/ledger-tenancy.js.
CoASchema.index({ tenantId: 1, code: 1 }, { unique: true });
CoASchema.index({ tenantId: 1, type: 1, code: 1 });

CoASchema.plugin(tenantScopedPlugin, { modelName: "CoA" });

export default mongoose.model("CoA", CoASchema);
