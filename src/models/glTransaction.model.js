import mongoose from "mongoose";

const EntrySchema = new mongoose.Schema(
  {
    accountCode: { type: String, required: true },
    dc: { type: String, enum: ["D", "C"], required: true },
    amount: { type: Number, required: true },
    memberId: { type: String }, // required for 1400/2020 lines
    applicationId: { type: String }, // used before memberId exists
    registrationId: { type: String }, // events-service Registration._id, used before memberId exists (events domain)
    profileId: { type: String }, // generic person link when there is no membershipNumber (events/courses attendees)
    periodBucket: { type: String, enum: ["arrears", "current", "advance"] },
    revenueSubType: { type: String }, // e.g. "fee", "Fee Increase", "Fee Decrease"
    adjSubType: { type: String }, // "prorata", "discount", etc.
    categoryName: { type: String }, // for descriptions/reports
    // Segregates events/courses entries from membership entries for reporting;
    // does not replace account-code-based posting - see coaAccountCodes.helper.js.
    ledgerDomain: { type: String, enum: ["membership", "events"], default: "membership" },
  },
  { _id: false }
);

const GLSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    userId: { type: String, index: true },
    docType: { type: String, required: true }, // Invoice, CreditNote, Receipt, Claim, Refund, WriteOff, Adjustment, etc.
    docNo: { type: String, required: true, unique: true },
    reference: { type: String },
    memo: { type: String },
    /** App id for claim / traceability; does not replace entry-level memberId for 2020 rollups. */
    sourceApplicationId: { type: String, index: true, sparse: true },
    /** Cached claim recipient memberId for fast app->member resolution (docType=Claim). */
    claimMemberId: { type: String, index: true, sparse: true },
    settlement: {
      provider: { type: String }, // Stripe
      payoutId: { type: String }, // Stripe payout id
      status: {
        type: String,
        enum: ["PENDING", "SETTLED"],
        default: "PENDING",
      },
      settledAt: { type: Date },
      bankAccountCode: { type: String }, // 1010
    },

    entries: {
      type: [EntrySchema],
      validate: (v) => Array.isArray(v) && v.length >= 2,
    },
  },
  { timestamps: true }
);

// Helpful compound indexes for reporting and lookups
GLSchema.index({ "entries.memberId": 1, date: -1 });
GLSchema.index({ "entries.periodBucket": 1, date: -1 });
GLSchema.index({ "entries.adjSubType": 1, date: -1 });
GLSchema.index({ "entries.accountCode": 1, date: -1 });
GLSchema.index({ docType: 1, date: -1 });

// Fast docNo fetch (already unique)
//GLSchema.index({ docNo: 1 }, { unique: true });

// Optional: text index on memo/category for search
GLSchema.index({ memo: "text", "entries.categoryName": "text" });

export default mongoose.model("GLTransaction", GLSchema);
