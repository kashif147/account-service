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
    payoutMethod: {
      type: String,
      enum: ["bank_transfer", "cheque"],
      required: false,
    },
    glDocNo: { type: String, sparse: true, index: true },
    glStatus: {
      type: String,
      enum: ["posted", "gl_failed"],
      required: false,
    },
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

RefundSchema.index({ tenantId: 1, createdAt: -1 });

const isObjectId = (id) => Types.ObjectId.isValid(id);

export const zCreateRefund = z
  .object({
    mode: z.enum(["stripe", "external"]),
    paymentIntentId: z.string().optional(),
    chargeId: z.string().optional(),
    paymentId: z
      .string()
      .optional()
      .refine((id) => id === undefined || isObjectId(id), "Invalid paymentId"),
    amount: z.number().int().positive().optional(),
    payoutMethod: z.enum(["bank_transfer", "cheque"]).optional(),
    reason: z.string().optional(),
    note: z.string().optional(),
    metadata: z.record(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "stripe") {
      if (!data.paymentIntentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "paymentIntentId is required for stripe refunds",
          path: ["paymentIntentId"],
        });
      }
      return;
    }
    if (!data.paymentId && !data.paymentIntentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paymentId or paymentIntentId is required for external refunds",
        path: ["paymentId"],
      });
    }
    if (data.paymentId) {
      if (!data.payoutMethod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "payoutMethod is required when paymentId is set",
          path: ["payoutMethod"],
        });
      }
      if (data.amount == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "amount is required when paymentId is set",
          path: ["amount"],
        });
      }
    }
  });

export const zListRefundsQuery = z.object({
  limit: z.preprocess(
    (v) => (v === undefined || v === "" ? 20 : v),
    z.coerce.number().int().min(1).max(100)
  ),
  skip: z.preprocess(
    (v) => (v === undefined || v === "" ? 0 : v),
    z.coerce.number().int().min(0)
  ),
  memberId: z.string().optional(),
  mode: z.enum(["stripe", "external"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const Refund =
  mongoose.models.Refund || mongoose.model("Refund", RefundSchema);

export default Refund;
