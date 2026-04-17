import mongoose from "mongoose";

export const BATCH_DETAIL_TYPES = [
  "cheque",
  "deduction",
  "other",
  "Standing Order",
];

const BatchDetailSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: false,
      index: true,
    },
    type: {
      type: String,
      enum: BATCH_DETAIL_TYPES,
      required: true,
      index: true,
    },
    batchDate: {
      type: Date,
      required: true,
      index: true,
    },
    paymentDate: {
      type: Date,
      required: true,
    },
    workLocation: {
      type: String,
      trim: true,
      default: null,
    },
    bank: {
      type: String,
      trim: true,
      default: null,
    },
    batchStatus: {
      type: String,
      trim: true,
      default: "pending",
    },
    queuedBy: {
      type: String,
      default: null,
      index: true,
    },
    queuedAt: {
      type: Date,
      default: null,
    },
    processingStartedAt: {
      type: Date,
      default: null,
    },
    processingCompletedAt: {
      type: Date,
      default: null,
    },
    totalTransactions: {
      type: Number,
      default: 0,
    },
    processedTransactions: {
      type: Number,
      default: 0,
    },
    failedTransactions: {
      type: Number,
      default: 0,
    },
    referenceNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    comments: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    fileBlobPath: { type: String, default: null, trim: true },
    fileUrl: { type: String, default: null, trim: true },
    fileName: { type: String, default: null, trim: true, maxlength: 500 },
    fileContentType: { type: String, default: null, trim: true },
    batchPayments: [
      {
        profileId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Profile",
          required: true,
        },
        membershipNumber: { type: String, required: true, trim: true },
        forename: { type: String, default: null, trim: true },
        surname: { type: String, default: null, trim: true },
        fullName: { type: String, default: null, trim: true },
        dateOfBirth: { type: Date, default: null },
        gender: { type: String, default: null, trim: true },
        personalEmail: { type: String, default: null, trim: true },
        workEmail: { type: String, default: null, trim: true },
        mobileNumber: { type: String, default: null, trim: true },
        fullAddress: { type: String, default: null, trim: true },
        workLocation: { type: String, default: null, trim: true },
        grade: { type: String, default: null, trim: true },
        primarySection: { type: String, default: null, trim: true },
        valueAddedServices: { type: Boolean, default: false },
        fileRow: {
          membershipNumber: { type: String, default: null, trim: true },
          lastName: { type: String, default: null, trim: true },
          firstName: { type: String, default: null, trim: true },
          fullName: { type: String, default: null, trim: true },
          valueForPeriodSelected: { type: Number, default: null },
          rowIndex: { type: Number, default: null },
        },
      },
    ],
    batchExceptions: [
      {
        profileId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Profile",
          required: false,
        },
        membershipNumber: { type: String, required: true, trim: true },
        lastName: { type: String, default: null, trim: true },
        firstName: { type: String, default: null, trim: true },
        fullName: { type: String, default: null, trim: true },
        valueForPeriodSelected: { type: Number, default: null },
        rowIndex: { type: Number, default: null },
      },
    ],
    createdBy: {
      type: String,
      required: true,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "batchdetails",
  }
);

BatchDetailSchema.index({ tenantId: 1, isDeleted: 1 });
BatchDetailSchema.index({ type: 1, batchDate: -1 });

export default mongoose.model("BatchDetail", BatchDetailSchema);
