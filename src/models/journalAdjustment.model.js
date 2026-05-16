import mongoose from "mongoose";

const JOURNAL_ADJ_STATUSES = ["Draft", "Approved", "Cancelled"];

const JournalAdjustmentSchema = new mongoose.Schema(
  {
    docNo: { type: String, required: true, unique: true },
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

export { JOURNAL_ADJ_STATUSES };
export default mongoose.model("JournalAdjustment", JournalAdjustmentSchema);
