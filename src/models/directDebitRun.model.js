import mongoose from "mongoose";

export const DD_RUN_TYPES = ["MONTHLY", "BI_WEEKLY", "ANNUAL", "AD_HOC"];

export const DD_RUN_STATUSES = [
  "DRAFT",
  "VALIDATED",
  "APPROVED",
  "FILE_GENERATED",
  "SUBMITTED",
  "PARTIALLY_RECONCILED",
  "RECONCILED",
  "CANCELLED",
];

const OPEN_RUN_STATUSES = DD_RUN_STATUSES.filter((s) => s !== "CANCELLED" && s !== "RECONCILED");

export { OPEN_RUN_STATUSES };

const AuditEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, trim: true },
    actorId: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const DirectDebitRunSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    runNo: { type: String, required: true, trim: true, index: true },
    runType: { type: String, enum: DD_RUN_TYPES, required: true, index: true },
    periodStartDate: { type: Date, required: true, index: true },
    periodEndDate: { type: Date, required: true, index: true },
    collectionDate: { type: Date, required: true, index: true },
    submissionDueDate: { type: Date, default: null },
    status: {
      type: String,
      enum: DD_RUN_STATUSES,
      default: "DRAFT",
      index: true,
    },
    creditorSnapshot: {
      name: String,
      oin: String,
      iban: String,
      bic: String,
      address: String,
      city: String,
      postcode: String,
      country: String,
    },
    pain008: {
      msgId: { type: String, default: null, trim: true },
      fileName: { type: String, default: null },
      fileHash: { type: String, default: null },
      blobPath: { type: String, default: null },
      downloadUrl: { type: String, default: null },
      generatedAt: { type: Date, default: null },
      generatedBy: { type: String, default: null },
      pmtInfIds: [{ type: String }],
      nbOfTxs: { type: Number, default: 0 },
      ctrlSum: { type: Number, default: 0 },
    },
    totals: {
      includedCount: { type: Number, default: 0 },
      excludedCount: { type: Number, default: 0 },
      includedAmountEur: { type: Number, default: 0 },
      paidCount: { type: Number, default: 0 },
      paidAmountEur: { type: Number, default: 0 },
      unpaidCount: { type: Number, default: 0 },
      unpaidAmountEur: { type: Number, default: 0 },
      rejectedCount: { type: Number, default: 0 },
      rejectedAmountEur: { type: Number, default: 0 },
    },
    validationSummary: {
      isValid: { type: Boolean, default: false },
      errors: [
        {
          code: String,
          message: String,
          memberId: String,
          profileId: String,
        },
      ],
      warnings: [{ code: String, message: String }],
      validatedAt: Date,
      validatedBy: String,
    },
    approval: {
      approvedAt: Date,
      approvedBy: String,
      notes: String,
    },
    submission: {
      submittedAt: Date,
      submittedBy: String,
      reference: String,
      notes: String,
    },
    reconciliation: {
      lastPain002ImportAt: Date,
      lastPain002FileName: String,
      cumulativeUnpaidEur: { type: Number, default: 0 },
    },
    auditTrail: [AuditEntrySchema],
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    cancelledAt: Date,
    cancelledBy: String,
    cancelReason: String,
  },
  { timestamps: true, collection: "directdebitruns" },
);

DirectDebitRunSchema.index(
  { tenantId: 1, runNo: 1 },
  { unique: true },
);

DirectDebitRunSchema.index({
  tenantId: 1,
  runType: 1,
  periodStartDate: 1,
  periodEndDate: 1,
  collectionDate: 1,
  status: 1,
});

export default mongoose.model("DirectDebitRun", DirectDebitRunSchema);
