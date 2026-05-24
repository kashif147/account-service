import mongoose from "mongoose";

export const DD_MANDATE_STATUSES = ["ACTIVE", "EXPIRED", "CANCELLED", "SUSPENDED"];

const DirectDebitMandateSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    memberId: { type: String, required: true, index: true },
    membershipNumber: { type: String, required: true, index: true },
    paymentFormId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    umr: { type: String, required: true, trim: true, index: true },
    signedDate: { type: Date, required: true },
    status: {
      type: String,
      enum: DD_MANDATE_STATUSES,
      default: "ACTIVE",
      index: true,
    },
    debtorName: String,
    debtorIban: String,
    debtorBic: String,
    debtorAddress: String,
    debtorCity: String,
    debtorPostcode: String,
    debtorCountry: String,
    creditorName: String,
    creditorOin: String,
    creditorIban: String,
    creditorBic: String,
    successfulCollectionCount: { type: Number, default: 0 },
    lastSuccessfulCollectionAt: Date,
    lastRunId: { type: mongoose.Schema.Types.ObjectId, default: null },
    syncedFromPaymentFormAt: Date,
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true, collection: "directdebitmandates" },
);

DirectDebitMandateSchema.index(
  { tenantId: 1, profileId: 1, status: 1 },
);

DirectDebitMandateSchema.index(
  { tenantId: 1, umr: 1 },
  { unique: true },
);

export default mongoose.model("DirectDebitMandate", DirectDebitMandateSchema);
