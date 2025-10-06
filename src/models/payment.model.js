import mongoose from "mongoose";
import { z } from "zod";

const { Schema } = mongoose;

const StripeSubSchema = new Schema(
  {
    paymentIntentId: { type: String, index: true },
    checkoutSessionId: { type: String, index: true },
    chargeId: { type: String },
    customerId: { type: String },
    paymentMethodId: { type: String },
  },
  { _id: false }
);

const ExternalSubSchema = new Schema(
  {
    externalRef: { type: String },
  },
  { _id: false }
);

const AuditSubSchema = new Schema(
  {
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { _id: false }
);

const PaymentSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    purpose: {
      type: String,
      required: true,
      enum: ["applicationFee", "subscriptionFee"],
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: "eur" },
    status: {
      type: String,
      required: true,
      enum: [
        "created",
        "requires_action",
        "processing",
        "succeeded",
        "failed",
        "refunded",
        "partially_refunded",
      ],
    },
    memberId: { type: String, index: true },
    applicationId: { type: String, index: true },
    invoiceId: { type: String, index: true },
    idempotencyKey: { type: String, index: true },
    source: { type: String, default: "portal" },
    mode: { type: String, enum: ["stripe", "external"], default: "stripe" },
    stripe: { type: StripeSubSchema, default: {} },
    external: { type: ExternalSubSchema, default: {} },
    metadata: { type: Map, of: String },
    audit: { type: AuditSubSchema, default: {} },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
    minimize: false,
  }
);

// Compound indexes
PaymentSchema.index(
  { tenantId: 1, "stripe.paymentIntentId": 1 },
  { unique: true, sparse: true }
);

PaymentSchema.index({ tenantId: 1, memberId: 1, createdAt: -1 });

PaymentSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);

// Zod DTOs
export const zCreateIntent = z.object({
  purpose: z.enum(["applicationFee", "subscriptionFee"]),
  amount: z.number().int().nonnegative(),
  currency: z.string().default("eur"),
  memberId: z.string().optional(),
  applicationId: z.string().optional(),
  invoiceId: z.string().optional(),
  useCheckout: z.boolean().optional(),
  savePaymentMethod: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
});

export const zReconcile = z.object({
  eventId: z.string(),
  type: z.string(),
  payment: z.object({
    paymentIntentId: z.string(),
    amount: z.number().int().nonnegative(),
    currency: z.string(),
    chargeId: z.string().optional(),
    customerId: z.string().optional(),
    paymentMethodId: z.string().optional(),
    status: z.enum([
      "created",
      "requires_action",
      "processing",
      "succeeded",
      "failed",
      "refunded",
      "partially_refunded",
    ]),
    metadata: z.record(z.string()).optional(),
  }),
});

export const zRecordExternal = z.object({
  direction: z.enum(["in", "out"]),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  reason: z.string().optional(),
  memberId: z.string().optional(),
  applicationId: z.string().optional(),
  invoiceId: z.string().optional(),
  externalRef: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export const Payment =
  mongoose.models.Payment || mongoose.model("Payment", PaymentSchema);

export default Payment;
