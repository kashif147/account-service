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
    /** Set for standalone external refunds (no Payment row), e.g. salary deduction / bank / cheque not in Payment collection. */
    memberId: { type: String, index: true },
    applicationId: { type: String, index: true },
    mode: { type: String, enum: ["stripe", "external"], required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    reason: { type: String },
    /** Business date of the refund (GL journal date); defaults to request time if omitted. */
    refundDate: { type: Date },
    stripe: { type: StripeRefundSubSchema, default: {} },
    note: { type: String },
    metadata: { type: Map, of: String },
    payoutMethod: {
      type: String,
      enum: ["bank_transfer", "cheque", "card"],
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
    payoutMethod: z.enum(["bank_transfer", "cheque", "card"]).optional(),
    /** Required with applicationId (or alone) for standalone external refunds when paymentId is omitted. */
    memberId: z.string().optional(),
    applicationId: z.string().optional(),
    currency: z.string().min(1).optional(),
    /** ISO date or datetime; sets Refund.refundDate and GL journal date. */
    refundDate: z
      .string()
      .trim()
      .optional()
      .refine((s) => !s || !Number.isNaN(Date.parse(s)), "Invalid refundDate"),
    reason: z.string().optional(),
    note: z.string().optional(),
    metadata: z.record(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "stripe") {
      const hasPi =
        data.paymentIntentId != null &&
        String(data.paymentIntentId).trim() !== "";
      if (!hasPi && !data.paymentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "paymentIntentId (Stripe API refund) or paymentId (GL-only record) is required for stripe refunds",
          path: ["paymentIntentId"],
        });
      }
      if (!hasPi && data.paymentId && !data.payoutMethod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "payoutMethod is required for GL-only stripe refunds: bank_transfer (1200), cheque (1210), or card (1220)",
          path: ["payoutMethod"],
        });
      }
      return;
    }
    const extHasPi =
      data.paymentIntentId != null &&
      String(data.paymentIntentId).trim() !== "";
    const extHasPaymentId = !!data.paymentId;

    if (extHasPaymentId) {
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
    } else if (extHasPi) {
      if (!data.payoutMethod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "payoutMethod is required when using paymentIntentId for external refund",
          path: ["payoutMethod"],
        });
      }
      if (data.amount == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "amount is required when using paymentIntentId for external refund",
          path: ["amount"],
        });
      }
    } else {
      if (!data.memberId && !data.applicationId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "For external refunds without paymentId, provide memberId and/or applicationId (e.g. deduction/cheque/bank not stored as Payment)",
          path: ["memberId"],
        });
      }
      if (data.amount == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "amount is required for standalone external refunds",
          path: ["amount"],
        });
      }
      if (!data.payoutMethod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "payoutMethod is required for standalone external refunds",
          path: ["payoutMethod"],
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
