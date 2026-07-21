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
    clientSecret: { type: String },
    checkoutUrl: { type: String },
    status: { type: String },
    latestEventId: { type: String },
    latestEventType: { type: String },
    capturedAt: { type: Date },
    canceledAt: { type: Date },
    cancellationReason: { type: String },
    failureCode: { type: String },
    failureMessage: { type: String },
    nextAction: { type: Schema.Types.Mixed },
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

const PaymentAuditEventSubSchema = new Schema(
  {
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    source: { type: String, default: "stripe-webhook" },
    status: { type: String },
    stripeStatus: { type: String },
    message: { type: String },
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const PaymentSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    purpose: {
      type: String,
      required: true,
      enum: [
        "applicationFee",
        "subscriptionFee",
        "eventRegistration",
        "courseRegistration",
      ],
    },
    // Segregates events/courses money from membership money in the ledger -
    // see coaAccountCodes.helper.js and eventRegistration.approval.listener.js.
    ledgerDomain: {
      type: String,
      enum: ["membership", "events"],
      default: "membership",
      index: true,
    },
    registrationId: { type: String, index: true }, // events-service Registration._id, parallel to applicationId
    // Person-level link that works whether or not the payer holds a membership
    // number (profile-service Profile._id). memberId stays the membershipNumber-
    // based key used across membership; profileId is the generic alternative
    // for events/courses attendees who may not be members. If an events/courses
    // attendee IS also a member, both profileId and memberId are set so the
    // entry still surfaces in per-member reporting.
    profileId: { type: String, index: true },
    productCode: { type: String }, // Product.code, used to resolve the events/courses income account
    // user-service Lookup "Event Category" code (CPD | EVENT) - resolves the
    // GL income account directly (see eventRegistration.approval.listener.js's
    // resolveEventIncomeCode()), decoupled from the synced Product record.
    eventCategoryCode: { type: String, default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: "eur" },
    status: {
      type: String,
      required: true,
      enum: [
        "created",
        "requires_action",
        "requires_capture",
        "processing",
        "succeeded",
        "canceled",
        "authorization_expired",
        "payment_required",
        "refund_required",
        "manual_review",
        "failed",
        "refunded",
        "partially_refunded",
      ],
    },
    memberId: { type: String, index: true },
    applicationId: { type: String, index: true },
    invoiceId: { type: String, index: true },
    idempotencyKey: { type: String, index: true },
    attemptNumber: { type: Number, default: 1, min: 1 },
    isActiveAttempt: { type: Boolean, default: true, index: true },
    supersededAt: { type: Date },
    supersededByPaymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
    supersededReason: { type: String },
    source: { type: String, default: "portal" },
    mode: { type: String, enum: ["stripe", "external"], default: "stripe" },
    stripe: { type: StripeSubSchema, default: {} },
    external: { type: ExternalSubSchema, default: {} },
    metadata: { type: Map, of: String },
    audit: { type: AuditSubSchema, default: {} },
    webhookEventIds: { type: [String], default: [], index: true },
    auditHistory: { type: [PaymentAuditEventSubSchema], default: [] },
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
PaymentSchema.index({
  tenantId: 1,
  applicationId: 1,
  purpose: 1,
  attemptNumber: -1,
  createdAt: -1,
});

PaymentSchema.index({
  tenantId: 1,
  registrationId: 1,
  purpose: 1,
  attemptNumber: -1,
  createdAt: -1,
});

PaymentSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);

// Zod DTOs
export const zCreateIntent = z.object({
  purpose: z.enum([
    "applicationFee",
    "subscriptionFee",
    "eventRegistration",
    "courseRegistration",
  ]),
  ledgerDomain: z.enum(["membership", "events"]).optional(),
  registrationId: z.string().optional(),
  profileId: z.string().optional(),
  productCode: z.string().optional(),
  eventCategoryCode: z.string().optional(),
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
      "requires_capture",
      "processing",
      "succeeded",
      "canceled",
      "authorization_expired",
      "payment_required",
      "refund_required",
      "manual_review",
      "failed",
      "refunded",
      "partially_refunded",
    ]),
    stripeStatus: z.string().optional(),
    capturedAt: z.union([z.string(), z.date()]).optional(),
    canceledAt: z.union([z.string(), z.date()]).optional(),
    cancellationReason: z.string().optional(),
    failureCode: z.string().optional(),
    failureMessage: z.string().optional(),
    nextAction: z.any().optional(),
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

export const zAssociateMemberLink = z
  .object({
    memberId: z.string().trim().min(1),
    applicationId: z.string().trim().optional(),
    paymentIds: z.array(z.string().trim().min(1)).optional(),
    refundIds: z.array(z.string().trim().min(1)).optional(),
    includePayments: z.boolean().default(true),
    includeRefunds: z.boolean().default(true),
    onlyIfMissingMemberId: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    const hasSelector =
      !!data.applicationId ||
      (Array.isArray(data.paymentIds) && data.paymentIds.length > 0) ||
      (Array.isArray(data.refundIds) && data.refundIds.length > 0);
    if (!hasSelector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationId"],
        message:
          "Provide at least one selector: applicationId, paymentIds, or refundIds",
      });
    }
    if (!data.includePayments && !data.includeRefunds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["includePayments"],
        message: "At least one target must be enabled: includePayments/includeRefunds",
      });
    }
  });

export const Payment =
  mongoose.models.Payment || mongoose.model("Payment", PaymentSchema);

export default Payment;
