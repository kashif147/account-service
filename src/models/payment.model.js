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

// Who created the intent (P5 payer binding). Set ONCE at POST /payments/intents from the
// VERIFIED caller (never body/metadata) and never changed afterwards. userId is null for a
// genuine internal S2S call (forwardedInternalContext's x-user-id is not verified identity).
// Legacy rows (created before this field) have no payer; owner checks then fall back to
// audit.createdBy.
const PayerSubSchema = new Schema(
  {
    userId: { type: String, default: null },
    userType: { type: String, default: null }, // "PORTAL" | "CRM" | "INTERNAL" | other verified type
  },
  { _id: false }
);

// What the intent pays for (P5 payer binding), set ONCE at creation: the event/course a
// portal member is paying for before a Registration exists, or the registration itself
// for intents events-service creates with a registrationId. attach-registration requires
// the registration's event/course to equal this target.
const TargetSubSchema = new Schema(
  {
    entityType: { type: String, enum: ["event", "course", "registration"], required: true },
    entityId: { type: String, required: true },
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
    // P5: authoritative application binding, written ONLY at creation by a path that verified the
    // application (portal intent guard loaded it as the caller; account's own payment-link flow).
    // Mutation authority treats a row as an application payment only through this binding or an
    // explicit applicationFee purpose - never by inference from applicationId on a subscriptionFee
    // row. Absent on legacy rows (they fail closed: PAYMENT_APPLICATION_BINDING_UNVERIFIED).
    applicationBinding: { type: String, default: undefined },
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
    payer: { type: PayerSubSchema, default: undefined },
    target: { type: TargetSubSchema, default: undefined },
    // Set when attach-registration binds registrationId (single attach, never re-bound).
    attachedAt: { type: Date },
    // P5 active registration binding: equals registrationId on the ONE Stripe Payment that
    // currently holds the registration (unique per tenant, index below). Claimed atomically
    // at creation (events-service CRM/retry intents) or attach (portal intents); released
    // only by the named replacement transition (holder can no longer take money - see
    // payments.service.js releasableBindingFilter). Manual records claim it at creation; legacy
    // rows are adopted on first contention or by the backfill script.
    registrationBinding: { type: String, default: undefined },
    bindingReleasedAt: { type: Date },
    // Set when a pre-binding (legacy / manual) row was adopted into the binding index
    // (payments.service.js adoptLegacyRegistrationHolder or scripts/backfill-registration-binding).
    bindingAdoptedAt: { type: Date },
    bindingReleaseReason: { type: String },
    // Deferred payment link (PaymentLink._id) - set only for link payments, which use the
    // lifecycle state machine authoritatively and never publish application.status.updated.
    paymentLinkId: { type: Schema.Types.ObjectId, ref: "PaymentLink", default: null },
    linkVersion: { type: Number },
    // Card authorisation hold deadline (charge.payment_method_details.card.capture_before).
    capturableUntil: { type: Date },
    authorisedAt: { type: Date },
    expiryWarnedAt: { type: Date },
    lastStripeEventAt: { type: Date },
    // P5 refund accounting (cents), services/refundOperations.service.js: one entry per in-flight
    // RefundOperation (exactly-once by opId); refundCommittedCents counts completed refunds of
    // every source (initialised once from the Refund rows). committed + reserved <= amount.
    refundReservations: {
      type: [new Schema({ opId: { type: Schema.Types.ObjectId, required: true }, amount: { type: Number, required: true }, at: { type: Date, default: Date.now } }, { _id: false })],
      default: undefined,
    },
    refundCommittedCents: { type: Number },
    webhookEventIds: { type: [String], default: [], index: true },
    auditHistory: { type: [PaymentAuditEventSubSchema], default: [] },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
    minimize: false,
  }
);

// Compound indexes
//
// partialFilterExpression, not just sparse: true, on both indexes below.
// Sparse only excludes documents where the field is entirely MISSING - a
// document with the field explicitly set to null still gets indexed, so
// multiple payments that all end up with e.g. idempotencyKey: null collide
// on that shared null value under a plain sparse unique index. A partial
// filter requiring the field to actually be a string fixes this properly
// (same pattern applied to events-service's Registration.profileId index).
PaymentSchema.index(
  { tenantId: 1, "stripe.paymentIntentId": 1 },
  { unique: true, partialFilterExpression: { "stripe.paymentIntentId": { $type: "string" } } }
);

PaymentSchema.index({ tenantId: 1, memberId: 1, createdAt: -1 });
PaymentSchema.index(
  { paymentLinkId: 1 },
  { partialFilterExpression: { paymentLinkId: { $type: "objectId" } } },
);
// Authorisation-expiry scheduler scan.
PaymentSchema.index(
  { status: 1, capturableUntil: 1 },
  { partialFilterExpression: { capturableUntil: { $type: "date" } } },
);
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

// P5: at most one Payment holds the active binding of a registration (see registrationBinding).
PaymentSchema.index(
  { tenantId: 1, registrationBinding: 1 },
  { unique: true, partialFilterExpression: { registrationBinding: { $type: "string" } } }
);

PaymentSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
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
  // P5 payer binding: the event/course this intent pays for (registration intents). The
  // live portal still sends only metadata.eventId, which createIntent accepts as a fallback.
  entityType: z.enum(["event", "course"]).optional(),
  entityId: z.string().optional(),
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
    capturableUntil: z.union([z.string(), z.date()]).optional(),
    occurredAt: z.union([z.string(), z.date()]).optional(),
  }),
});

/**
 * HTTP body for POST /api/payments/reconcile. Only the PaymentIntent id is used: amount,
 * currency, status and metadata are re-read from Stripe server-side (see
 * reconcilePaymentFromStripe). The legacy webhook-shaped body ({eventId, type, payment})
 * is still accepted for compatibility, but every field other than
 * payment.paymentIntentId is ignored.
 */
export const zReconcileRequest = z
  .object({
    paymentIntentId: z.string().trim().min(1).optional(),
    eventId: z.string().optional(),
    type: z.string().optional(),
    payment: z
      .object({ paymentIntentId: z.string().trim().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (!data.paymentIntentId && !data.payment?.paymentIntentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentIntentId"],
        message: "paymentIntentId is required",
      });
    }
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
