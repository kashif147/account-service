import mongoose from "mongoose";

const { Schema } = mongoose;

// Deferred application payment link (docs/design/IMPLEMENTATION_PLAN.md s.4). One row per
// (tenant, application, linkVersion). The link is a Stripe Checkout Session; the Payment it
// creates is the ordinary Payment/PaymentIntent record (paymentId), not a separate concept.
// Amount, currency and pricing basis are frozen at issue; a REPLACE (new version) re-prices.
const PaymentLinkSchema = new Schema(
  {
    tenantId: { type: String, required: true },
    applicationId: { type: String, required: true },
    linkVersion: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["PENDING", "ISSUED", "COMPLETED", "EXPIRED", "REPLACED", "FAILED"],
      required: true,
    },
    action: { type: String, enum: ["ISSUE", "REPLACE"], required: true },
    // Derived from the payment type: FULL (card, annual fee) | FIRST_INSTALMENT (three months).
    paymentOption: { type: String, enum: ["FULL", "FIRST_INSTALMENT"], default: "FULL" },
    failureReason: { type: String },
    checkoutSessionId: { type: String },
    checkoutUrl: { type: String },
    expiresAt: { type: Date },
    // expires_at sent to Stripe, frozen when the PENDING row is created so a resumed request
    // repeats the first attempt's parameters under the same Stripe idempotency key.
    checkoutExpiresAt: { type: Date },
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
    amount: { type: Number, min: 0 },
    currency: { type: String },
    pricingBasis: { type: Schema.Types.Mixed },
    requestedBy: {
      userId: { type: String },
      userType: { type: String },
      channel: { type: String },
    },
    requestEventKey: { type: String },
    replacedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true, collection: "paymentLinks" },
);

PaymentLinkSchema.index({ tenantId: 1, applicationId: 1, linkVersion: 1 }, { unique: true });
// One current (ISSUED) link per application.
PaymentLinkSchema.index(
  { tenantId: 1, applicationId: 1 },
  { unique: true, partialFilterExpression: { status: "ISSUED" }, name: "one_issued_link_per_application" },
);
PaymentLinkSchema.index(
  { checkoutSessionId: 1 },
  { unique: true, partialFilterExpression: { checkoutSessionId: { $type: "string" } } },
);

export const PaymentLink =
  mongoose.models.PaymentLink || mongoose.model("PaymentLink", PaymentLinkSchema);
export default PaymentLink;
