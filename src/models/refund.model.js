import mongoose from "mongoose";
import { z } from "zod";

const { Schema, Types } = mongoose;

const StripeRefundSubSchema = new Schema(
  {
    refundId: { type: String, index: true },
    chargeId: { type: String },
    paymentIntentId: { type: String },
  },
  { _id: false }
);

const RefundSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    paymentId: { type: Types.ObjectId, ref: "Payment" },
    mode: { type: String, enum: ["stripe", "external"], required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    reason: { type: String },
    stripe: { type: StripeRefundSubSchema, default: {} },
    note: { type: String },
    metadata: { type: Map, of: String },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: false },
    minimize: false,
  }
);

RefundSchema.index(
  { tenantId: 1, "stripe.refundId": 1 },
  { unique: true, sparse: true }
);

export const zCreateRefund = z.object({
  paymentIntentId: z.string().optional(),
  chargeId: z.string().optional(),
  amount: z.number().int().positive().optional(),
  reason: z.string().optional(),
  mode: z.enum(["stripe", "external"]),
  note: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export const Refund =
  mongoose.models.Refund || mongoose.model("Refund", RefundSchema);

export default Refund;
