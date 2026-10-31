// Payment lifecycle state machine (docs/design/IMPLEMENTATION_PLAN.md s.5.1). Pure: no I/O.
//
// Mode (PAYMENT_STATE_MACHINE_MODE):
//   shadow (default) - legacy resolveWebhookStatus stays authoritative for existing payments;
//                      this module's decision is computed alongside and disagreements are logged.
//   Payment-link payments (Payment.paymentLinkId set) are new and have no legacy behaviour to
//   preserve, so they always use this module's decision.
// Switching existing payments to authoritative needs a separate reviewed proof.

export const STATE_MACHINE_MODES = Object.freeze(["shadow", "authoritative"]);

export function stateMachineMode(env = process.env) {
  const mode = String(env.PAYMENT_STATE_MACHINE_MODE || "shadow").toLowerCase();
  return STATE_MACHINE_MODES.includes(mode) ? mode : "shadow";
}

// Stripe API 2018-02-28 webhook names -> current names, then -> Payment.status.
const LEGACY_STRIPE_NAMES = {
  requires_source: "requires_payment_method",
  requires_source_action: "requires_action",
};

export function normalizeStripeStatus(status) {
  if (!status) return status;
  return LEGACY_STRIPE_NAMES[status] || status;
}

const AUTH_EXPIRED_REASONS = new Set(["automatic", "abandoned", "expired"]);

export function classifyCancellation(reason) {
  return AUTH_EXPIRED_REASONS.has(reason) ? "authorization_expired" : "canceled";
}

const HOLDS = new Set(["manual_review", "refund_required"]);
const TERMINAL = new Set(["canceled", "authorization_expired", "refunded"]);

// Allowed moves per current state (s.5.1). "=" (same state) is an idempotent no-op.
const ALLOWED = {
  created: ["requires_action", "processing", "failed", "requires_capture", "succeeded", "canceled"],
  payment_required: ["requires_action", "processing", "failed", "requires_capture", "succeeded", "canceled"],
  requires_action: ["processing", "failed", "requires_capture", "succeeded", "canceled"],
  processing: ["failed", "requires_capture", "succeeded", "canceled"],
  failed: ["requires_action", "processing", "requires_capture", "succeeded", "canceled"],
  requires_capture: ["succeeded", "canceled", "authorization_expired"],
  succeeded: ["partially_refunded", "refunded"],
  partially_refunded: ["partially_refunded", "refunded"],
};

/**
 * Decide the next Payment.status.
 * @param {string|undefined} current  persisted status (undefined for a new record)
 * @param {string} incoming           candidate status from the event
 * @param {{occurredAt?: Date, lastAppliedAt?: Date}} [opts]
 * @returns {{status: string, applied: boolean, reason: string, recheck: boolean}}
 *   recheck: true when the move was refused as impossible -> caller may re-read the PI from Stripe.
 */
export function nextPaymentStatus(current, incoming, opts = {}) {
  const to = incoming;
  if (!current) return { status: to, applied: true, reason: "initial", recheck: false };
  if (HOLDS.has(current)) {
    return { status: current, applied: false, reason: "hold_record_only", recheck: false };
  }
  if (current === to && to !== "partially_refunded") {
    return { status: current, applied: false, reason: "idempotent", recheck: false };
  }
  if (TERMINAL.has(current)) {
    return { status: current, applied: false, reason: "terminal", recheck: false };
  }
  // processing -> requires_action only when the event is newer than the last applied one.
  if (current === "processing" && to === "requires_action") {
    const newer =
      opts.occurredAt && opts.lastAppliedAt && new Date(opts.occurredAt) > new Date(opts.lastAppliedAt);
    return newer
      ? { status: to, applied: true, reason: "newer_event", recheck: false }
      : { status: current, applied: false, reason: "stale_event", recheck: true };
  }
  if ((ALLOWED[current] || []).includes(to)) {
    return { status: to, applied: true, reason: "transition", recheck: false };
  }
  return { status: current, applied: false, reason: "regression_refused", recheck: true };
}

/** Refund state from the charge totals (s.5.1). null when the charge carries no refund. */
export function refundStatusFromCharge(charge) {
  const refunded = Number(charge?.amount_refunded || 0);
  const received = Number(charge?.amount_captured ?? charge?.amount ?? 0);
  if (!refunded || refunded <= 0 || !received) return null;
  return refunded >= received ? "refunded" : "partially_refunded";
}

/** Application-facing status for a Payment.status (profile-service personalDetails.payment). */
export function applicationPaymentStatus(paymentStatus) {
  switch (paymentStatus) {
    case "requires_capture":
      return "AUTHORISED";
    case "succeeded":
      return "CAPTURED";
    case "authorization_expired":
      return "AUTHORISATION_EXPIRED";
    case "canceled":
      return "CANCELED";
    case "failed":
      return "FAILED";
    case "refunded":
      return "REFUNDED";
    case "partially_refunded":
      return "PARTIALLY_REFUNDED";
    default:
      return null; // requires_action / processing / created: still LINK_ISSUED from profile's view
  }
}

/**
 * Shadow comparison record: safe to log (ids and statuses only - never payloads or card data).
 */
export function shadowComparison({ paymentId, eventId, eventType, current, incoming, legacy, machine }) {
  return {
    paymentId: paymentId ? String(paymentId) : null,
    eventId: eventId || null,
    eventType: eventType || null,
    current: current || null,
    incoming: incoming || null,
    legacyDecision: legacy,
    machineDecision: machine.status,
    machineReason: machine.reason,
    agree: legacy === machine.status,
  };
}
