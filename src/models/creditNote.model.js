import mongoose from "mongoose";
import { tenantScopedPlugin } from "./plugins/tenantScoped.plugin.js";

const CREDIT_NOTE_STATUSES = ["Draft", "Approved", "Cancelled"];

const CreditNoteSchema = new mongoose.Schema(
  {
    docNo: { type: String, required: true },
    memberId: { type: String, required: true, index: true },
    invoiceDocNo: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    periodBucket: {
      type: String,
      enum: ["arrears", "current", "advance"],
      default: "current",
    },
    status: {
      type: String,
      enum: CREDIT_NOTE_STATUSES,
      default: "Draft",
      index: true,
    },
    incomeCode: { type: String },
    categoryName: { type: String },
    reason: { type: String },
    notes: { type: String },
    glDocNo: { type: String, sparse: true },
    transferGlDocNo: { type: String, sparse: true },
    createdBy: { type: String },
    approvedBy: { type: String },
    cancelledBy: { type: String },
    approvedAt: { type: Date },
    cancelledAt: { type: Date },
    effectiveDate: { type: Date, required: true },
  },
  { timestamps: true },
);

// docNo is unique per tenant; legacy global docNo_1 is dropped by the ledger-tenancy migration.
CreditNoteSchema.index({ tenantId: 1, docNo: 1 }, { unique: true });
CreditNoteSchema.index({ tenantId: 1, memberId: 1, status: 1, createdAt: -1 });

export { CREDIT_NOTE_STATUSES };
CreditNoteSchema.plugin(tenantScopedPlugin, { modelName: "CreditNote" });

export default mongoose.model("CreditNote", CreditNoteSchema);
