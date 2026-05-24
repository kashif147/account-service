import mongoose from "mongoose";

export const DD_ITEM_STATUSES = [
  "INCLUDED",
  "EXCLUDED",
  "FILED",
  "SUBMITTED",
  "PAID",
  "UNPAID",
  "REJECTED",
];

const DirectDebitRunItemSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    runId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DirectDebitRun",
      required: true,
      index: true,
    },
    memberId: { type: String, required: true, index: true },
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    mandateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DirectDebitMandate",
      default: null,
      index: true,
    },
    paymentFormId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    memberSnapshot: {
      membershipNumber: String,
      fullName: String,
      email: String,
      membershipCategory: String,
      paymentFrequency: String,
    },
    mandateSnapshot: {
      umr: String,
      signedDate: Date,
      debtorName: String,
      debtorIban: String,
      debtorBic: String,
      debtorAddress: String,
      debtorCity: String,
      debtorPostcode: String,
      debtorCountry: String,
      seqTp: { type: String, enum: ["FRST", "RCUR", "OOFF", "FNAL"], default: "RCUR" },
    },
    amountEur: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "EUR" },
    endToEndId: { type: String, required: true, trim: true, index: true },
    remittanceInfo: { type: String, default: "", trim: true, maxlength: 140 },
    collectionPeriod: {
      startDate: Date,
      endDate: Date,
    },
    status: {
      type: String,
      enum: DD_ITEM_STATUSES,
      default: "INCLUDED",
      index: true,
    },
    exclusionReason: {
      code: String,
      message: String,
    },
    pain008: {
      pmtInfId: String,
      blockSeqTp: String,
    },
    pain002: {
      reasonCode: String,
      reasonText: String,
      pain002FileRef: String,
      pain002MsgId: String,
      receivedAt: Date,
      settlementPhase: { type: String, enum: ["pre_settlement", "post_settlement", null], default: null },
    },
  },
  { timestamps: true, collection: "directdebitrunitems" },
);

DirectDebitRunItemSchema.index({ tenantId: 1, runId: 1, status: 1 });
DirectDebitRunItemSchema.index({ tenantId: 1, endToEndId: 1 });
DirectDebitRunItemSchema.index(
  { tenantId: 1, runId: 1, memberId: 1 },
  { unique: true },
);

export default mongoose.model("DirectDebitRunItem", DirectDebitRunItemSchema);
