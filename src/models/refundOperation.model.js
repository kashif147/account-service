import mongoose from "mongoose";

const { Schema, Types } = mongoose;

/**
 * P5 durable refund operation (one per refund attempt). Persisted BEFORE any provider call so
 * a crash at any point leaves a visible, reconcilable record:
 *   reserved -> submitting -> succeeded | failed | uncertain;  uncertain -> succeeded | failed
 * Reservations (Payment.refundReservations / MemberRefundReservation) are held while the
 * operation is reserved / submitting / uncertain and released only when non-execution or a
 * definitive provider failure is established. See services/refundOperations.service.js.
 */
const HistorySchema = new Schema(
  { state: String, at: { type: Date, default: Date.now }, note: String, actor: String },
  { _id: false },
);

const RefundOperationSchema = new Schema(
  {
    tenantId: { type: String, required: true },
    source: { type: String, required: true, enum: ["crm_refund", "event_cancellation", "stripe_observed"] },
    flow: { type: String, required: true }, // A | B | EXT | E | E_CRM | UNLINKED (server-derived)
    mode: { type: String, required: true, enum: ["stripe", "external"] },
    state: {
      type: String,
      required: true,
      enum: ["reserved", "submitting", "succeeded", "failed", "uncertain"],
    },
    // Fencing: every transition is a CAS on {state, version[, lease.owner]} and increments
    // version; only the lease owner may submit to the provider.
    version: { type: Number, required: true, default: 0 },
    lease: {
      type: new Schema({ owner: String, expiresAt: Date }, { _id: false }),
      default: null,
    },
    paymentId: { type: Types.ObjectId, default: null },
    memberKey: { type: String, default: null }, // authoritative member / app:<id> ledger key
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    // Client Idempotency-Key, scoped "<userId>|<key>" (or a server key for automatic sources).
    clientKey: { type: String, default: undefined },
    requestFingerprint: { type: String, default: null },
    // Server-derived from the operation id; never client supplied.
    stripeIdempotencyKey: { type: String, required: true },
    stripeParams: { type: Schema.Types.Mixed, default: null }, // { payment_intent, charge? } or null
    stripeRefundId: { type: String, default: null },
    stripeChargeId: { type: String, default: null },
    refundDocId: { type: Types.ObjectId, default: null },
    refundTemplate: { type: Schema.Types.Mixed, default: null }, // Refund row fields (no ids)
    glContext: { type: Schema.Types.Mixed, default: null },
    paymentReservationHeld: { type: Boolean, default: false },
    memberReservationHeld: { type: Boolean, default: false },
    glStatus: { type: String, default: null },
    policy: { type: Schema.Types.Mixed, default: null }, // { mode, flow, wouldRefuse, code }
    error: { type: Schema.Types.Mixed, default: null }, // { status, code, message, providerType }
    result: { type: Schema.Types.Mixed, default: null }, // stored response for idempotent replay
    createdBy: { type: String, default: null },
    submittedAt: { type: Date },
    resolvedAt: { type: Date },
    finalizedAt: { type: Date },
    history: { type: [HistorySchema], default: [] },
  },
  { timestamps: true, minimize: false },
);

RefundOperationSchema.index(
  { tenantId: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: "string" } } },
);
RefundOperationSchema.index({ stripeIdempotencyKey: 1 }, { unique: true });
RefundOperationSchema.index({ tenantId: 1, state: 1, createdAt: -1 });
RefundOperationSchema.index({ tenantId: 1, paymentId: 1 });

export const RefundOperation =
  mongoose.models.RefundOperation || mongoose.model("RefundOperation", RefundOperationSchema);
export default RefundOperation;
