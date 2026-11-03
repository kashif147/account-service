import mongoose from "mongoose";

const { Schema } = mongoose;

// P5 payer binding: durable record of a registration-backed Stripe PaymentIntent creation
// (payments.service.js createIntent, claimsRegistrationBinding). Written BEFORE Stripe is
// called, so a PaymentIntent that never becomes a Payment row (lost the registration-binding
// race, or the process died between Stripe and Payment.create) is always findable and is
// cancelled by sweepPaymentIntentReservations - never bound, captured or attached.
//
// The Stripe idempotency key is derived from this record's _id only, so a recovery re-call
// returns the SAME PaymentIntent. Request parameters are kept (non-secret) so the recovery
// call is a byte-identical replay. Never stores a client_secret, card data or caller identity.
//
// state: reserved -> intent_created -> bound
//                                   \-> orphaned -> orphan_canceled
//                                                \-> orphan_cancel_failed (retried by sweep)
// Terminal sweep outcomes (scripts/sweep-payment-intent-reservations.js; never retried):
//   needs_attention  - attempts exhausted, or the PaymentIntent's metadata/tenant does not match
//                      this reservation; a human resolves it (attentionReason says why)
//   no_intent_found  - the creation never reached Stripe (nothing exists to cancel)
export const RESERVATION_STATES = [
  "reserved",
  "intent_created",
  "bound",
  "orphaned",
  "orphan_canceled",
  "orphan_cancel_failed",
  "needs_attention",
  "no_intent_found",
];
// A PaymentIntent recorded in any of these states is never captured or attached.
export const ORPHAN_STATES = ["orphaned", "orphan_canceled", "orphan_cancel_failed", "needs_attention"];
// States the recovery sweep works on.
export const SWEEP_OPEN_STATES = ["reserved", "intent_created", "orphaned", "orphan_cancel_failed"];

const PaymentIntentReservationSchema = new Schema(
  {
    tenantId: { type: String, required: true },
    registrationId: { type: String, required: true },
    purpose: { type: String, required: true },
    state: { type: String, required: true, enum: RESERVATION_STATES, default: "reserved" },
    stripeIdempotencyKey: { type: String, required: true },
    request: {
      amount: { type: Number, required: true },
      currency: { type: String, required: true },
      captureMethod: { type: String, required: true },
      metadata: { type: Map, of: String },
    },
    paymentIntentId: { type: String, default: null },
    paymentId: { type: String, default: null },
    orphanReason: { type: String, default: null },
    cancelAttempts: { type: Number, default: 0 },
    lastErrorCode: { type: String, default: null }, // Stripe error code/type only, never a message body
    sweepAttempts: { type: Number, default: 0 },
    sweepLeaseUntil: { type: Date, default: null }, // one sweep at a time per reservation
    attentionReason: { type: String, default: null }, // code only (see needs_attention)
  },
  { timestamps: true, collection: "paymentIntentReservations", strict: "throw" },
);

PaymentIntentReservationSchema.index({ stripeIdempotencyKey: 1 }, { unique: true });
PaymentIntentReservationSchema.index({ paymentIntentId: 1 }, { sparse: true });
PaymentIntentReservationSchema.index({ state: 1, updatedAt: 1 });
PaymentIntentReservationSchema.index({ tenantId: 1, registrationId: 1, createdAt: -1 });

export const PaymentIntentReservation =
  mongoose.models.PaymentIntentReservation ||
  mongoose.model("PaymentIntentReservation", PaymentIntentReservationSchema);
export default PaymentIntentReservation;
