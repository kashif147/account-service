import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const JOURNAL_ADJ_STATUSES = ["Draft", "Approved", "Cancelled"];

const JournalAdjustmentSchema = new mongoose.Schema(
  {
    docNo: { type: String, required: true },
    debitAccount: { type: String, required: true },
    creditAccount: { type: String, required: true },
    amount: { type: Number, required: true },
    memberId: { type: String, index: true, sparse: true },
    /** Display name and CRM profile id when member was chosen from search (optional). */
    memberName: { type: String },
    memberProfileId: { type: String, index: true, sparse: true },
    financialPeriod: { type: String, required: true },
    reason: { type: String, required: true },
    notes: { type: String },
    approvalStatus: {
      type: String,
      enum: JOURNAL_ADJ_STATUSES,
      default: "Draft",
      index: true,
    },
    createdBy: { type: String },
    approvedBy: { type: String },
    glDocNo: { type: String, sparse: true },
    effectiveDate: { type: Date, required: true },
  },
  { timestamps: true },
);

// docNo unique per tenant; legacy global docNo_1 is dropped by the ledger-tenancy migration.
JournalAdjustmentSchema.index({ tenantId: 1, docNo: 1 }, { unique: true });

export { JOURNAL_ADJ_STATUSES };
JournalAdjustmentSchema.plugin(tenantScopedPlugin, { modelName: "JournalAdjustment" });

export default mongoose.model("JournalAdjustment", JournalAdjustmentSchema);
