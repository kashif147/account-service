import mongoose from "mongoose";

const { Schema } = mongoose;

// A verified Stripe event that can never be applied (unknown PaymentIntent / session, tenant
// mismatch, invalid shape). The webhook answers 2xx for these so Stripe stops retrying, and
// this row is the record finance/support reconcile from. Ids only - no payload, no card data.
const StripeEventRejectionSchema = new Schema(
  {
    stripeEventId: { type: String, required: true },
    eventType: { type: String, required: true },
    reason: { type: String, required: true },
    objectId: { type: String }, // pi_/cs_/ch_/re_ id
    paymentId: { type: String },
    tenantId: { type: String }, // persisted payment tenant when known; never Stripe metadata
    occurrences: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "stripeEventRejections" },
);

StripeEventRejectionSchema.index({ stripeEventId: 1 }, { unique: true });
StripeEventRejectionSchema.index({ reason: 1, createdAt: -1 });

export const StripeEventRejection =
  mongoose.models.StripeEventRejection ||
  mongoose.model("StripeEventRejection", StripeEventRejectionSchema);
export default StripeEventRejection;
