// P5 S1: bound internal payment command (contract b5-payment-mutation-contract.md, sections 3-6).
//
// The five payment-mutation routes accept, from a GENUINE internal caller (x-internal-request,
// no user identity of any kind), a command that names the business object it acts for. Account
// does not trust that claim: it resolves the STORED payment row in the internal tenant and the
// command must match it exactly. Fail closed on anything unbound, ambiguous or mismatched.
//
// This step only adds the command alongside today's (contained) CRM user path; nothing calls it
// until the owning services migrate (S2), and the user path is only removed in S3. It does not by
// itself establish the caller's authority over the object - that is the owning service's hop-1
// gate, and only becomes enforceable once the user path is gone and service identity is trusted.
import mongoose from "mongoose";
import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";

export const BOUND_TRANSITIONS = Object.freeze([
  "capture",
  "cancel",
  "manual_record",
  "manual_post",
  "manual_void",
]);

const DOMAIN_PURPOSES = Object.freeze({
  application: Object.freeze(["applicationFee"]),
  registration: Object.freeze(["eventRegistration", "courseRegistration"]),
});
const DOMAIN_LEDGER = Object.freeze({ application: "membership", registration: "events" });
const DOMAIN_TRANSITIONS = Object.freeze({
  application: Object.freeze(["capture", "cancel"]),
  registration: BOUND_TRANSITIONS,
});
const TRANSITION_REASONS = Object.freeze({
  capture: Object.freeze(["approve"]),
  cancel: Object.freeze(["reject", "event_cancelled", "payment_method_switched"]),
  manual_record: Object.freeze(["crm_add_attendee"]),
  manual_post: Object.freeze(["approve"]),
  manual_void: Object.freeze(["reject", "event_cancelled", "payment_method_switched"]),
});
const LINK_TRANSITIONS = new Set(["capture", "manual_post", "manual_record"]);
const MANUAL_METHODS = new Set(["manual", "comp", "invoice"]);

const TOP_KEYS = new Set(["binding", "transition", "reason", "actorUserId", "expected", "link", "record"]);
const BINDING_KEYS = new Set(["domain", "applicationId", "registrationId", "purpose", "paymentId"]);
const EXPECTED_KEYS = new Set(["amount", "currency"]);
const LINK_KEYS = new Set(["profileId", "memberId"]);
const RECORD_KEYS = new Set(["amount", "currency", "method", "productCode", "eventCategoryCode"]);

// Any of these on an internal request means it is NOT a pure service call.
const IDENTITY_HEADERS = [
  "authorization",
  "x-jwt-verified",
  "x-auth-source",
  "x-user-id",
  "x-user-email",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
  "x-ms-client-principal",
];

function err(status, code, message) {
  return new AppError(message, status, code);
}
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}
function isId(v) {
  return typeof v === "string" && mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v);
}

/** True when an internal request also carries any user / gateway identity header. */
export function carriesUserIdentity(headers = {}) {
  return IDENTITY_HEADERS.some((h) => headers[h] != null && String(headers[h]) !== "") ||
    Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-gateway-"));
}

/**
 * Strict parse of the command envelope (contract 3.2). Throws 400 on anything not allowed.
 * Body tenantId is never read (tenant only from the internal context).
 */
export function parseBoundCommand(routeTransition, body) {
  if (!isPlainObject(body) || !isPlainObject(body.binding)) {
    throw err(400, "PAYMENT_BINDING_REQUIRED", "A bound payment command is required");
  }
  const extraTop = unknownKeys(body, TOP_KEYS);
  const extraBinding = unknownKeys(body.binding, BINDING_KEYS);
  if (extraTop.length || extraBinding.length) {
    throw err(400, "UNKNOWN_FIELD", "Unknown field in payment command");
  }
  if (str(body.transition) !== routeTransition) {
    throw err(400, "TRANSITION_ROUTE_MISMATCH", "transition does not match this route");
  }
  const domain = str(body.binding.domain);
  if (!DOMAIN_PURPOSES[domain]) throw err(400, "PAYMENT_BINDING_REQUIRED", "binding.domain is invalid");
  const purpose = str(body.binding.purpose);
  if (!DOMAIN_PURPOSES[domain].includes(purpose)) {
    throw err(409, "PURPOSE_NOT_ALLOWED", "purpose is not allowed for this domain");
  }
  if (!DOMAIN_TRANSITIONS[domain].includes(routeTransition)) {
    throw err(409, "TRANSITION_NOT_ALLOWED", "transition is not allowed for this domain");
  }
  const objectId = domain === "application" ? str(body.binding.applicationId) : str(body.binding.registrationId);
  const otherId = domain === "application" ? body.binding.registrationId : body.binding.applicationId;
  if (!isId(objectId) || otherId != null) {
    throw err(400, "PAYMENT_BINDING_REQUIRED", "binding must name exactly one business object");
  }
  const paymentId = body.binding.paymentId == null ? null : str(body.binding.paymentId);
  if (paymentId != null && !isId(paymentId)) throw err(400, "PAYMENT_BINDING_REQUIRED", "binding.paymentId is invalid");
  if ((routeTransition === "manual_post" || routeTransition === "manual_void") && !paymentId) {
    throw err(400, "PAYMENT_BINDING_REQUIRED", "binding.paymentId is required");
  }
  if (routeTransition === "manual_record" && paymentId) {
    throw err(400, "UNKNOWN_FIELD", "binding.paymentId is not allowed when recording");
  }
  const reason = str(body.reason);
  if (!TRANSITION_REASONS[routeTransition].includes(reason)) {
    throw err(400, "REASON_NOT_ALLOWED", "reason is not allowed for this transition");
  }
  const actorUserId = str(body.actorUserId);
  if (!actorUserId || actorUserId.length > 128) throw err(400, "ACTOR_REQUIRED", "actorUserId is required");

  let expected = null;
  if (body.expected != null) {
    if (!isPlainObject(body.expected) || unknownKeys(body.expected, EXPECTED_KEYS).length) {
      throw err(400, "UNKNOWN_FIELD", "Unknown field in expected");
    }
    expected = {};
    if (body.expected.amount != null) {
      if (!Number.isInteger(body.expected.amount) || body.expected.amount < 0) throw err(400, "UNKNOWN_FIELD", "expected.amount is invalid");
      expected.amount = body.expected.amount;
    }
    if (body.expected.currency != null) expected.currency = str(body.expected.currency).toLowerCase();
  }

  let link = null;
  if (body.link != null) {
    if (domain === "application" || !LINK_TRANSITIONS.has(routeTransition)) {
      throw err(400, "LINK_NOT_ALLOWED", "link is not allowed for this command");
    }
    if (!isPlainObject(body.link) || unknownKeys(body.link, LINK_KEYS).length) {
      throw err(400, "UNKNOWN_FIELD", "Unknown field in link");
    }
    link = {};
    for (const k of LINK_KEYS) if (str(body.link[k])) link[k] = str(body.link[k]);
  }

  let record = null;
  if (routeTransition === "manual_record") {
    if (!isPlainObject(body.record) || unknownKeys(body.record, RECORD_KEYS).length) {
      throw err(400, "UNKNOWN_FIELD", "record is required and may only carry amount, currency, method, productCode, eventCategoryCode");
    }
    const { amount, method } = body.record;
    if (!Number.isInteger(amount) || amount < 0) throw err(400, "UNKNOWN_FIELD", "record.amount must be integer cents >= 0");
    if (!MANUAL_METHODS.has(method)) throw err(400, "UNKNOWN_FIELD", "record.method must be manual, comp or invoice");
    record = {
      amount,
      method,
      currency: str(body.record.currency).toLowerCase() || "eur",
      ...(str(body.record.productCode) ? { productCode: str(body.record.productCode) } : {}),
      ...(str(body.record.eventCategoryCode) ? { eventCategoryCode: str(body.record.eventCategoryCode) } : {}),
    };
  } else if (body.record != null) {
    throw err(400, "UNKNOWN_FIELD", "record is only allowed when recording");
  }

  return {
    transition: routeTransition,
    domain,
    purpose,
    objectId,
    paymentId,
    reason,
    actorUserId,
    expected,
    link,
    record,
  };
}

/** Canonical JSON of the parsed command: the body the response cache compares against. */
export function commandFingerprint(cmd) {
  // parseBoundCommand builds every object with a fixed key order, so this is canonical.
  return crypto.createHash("sha256").update(JSON.stringify(cmd)).digest("hex");
}

/**
 * The only Idempotency-Key a bound caller may send (response cache only): derived from the
 * binding, so a caller cannot pick a key that collides with another object's command.
 */
export function expectedCallerKey(cmd, paymentId) {
  return [cmd.domain, cmd.transition, cmd.objectId, paymentId || "new"].join(":");
}

/** Server-derived Stripe idempotency key (never from the request). */
export function stripeIdempotencyKey(transition, paymentId, paymentIntentId) {
  return `acct:${transition}:${paymentId}:${paymentIntentId}`;
}

function registrationCaptureVerified(row, registrationId) {
  if (str(row.registrationBinding) && str(row.registrationBinding) === registrationId) return true;
  const t = row.target;
  return Boolean(t && t.entityType === "registration" && str(t.entityId) === registrationId);
}

const MUTABLE_RECORDED = ["manual_review", "processing", "requires_capture", "requires_action", "created", "payment_required", "succeeded"];

/**
 * Contract 3.4: resolve the stored row in the internal tenant and require it to equal the command.
 * Returns the lean row (null for manual_record, which creates it).
 */
export async function resolveBoundPayment(cmd, { tenantId, paymentIntentId }, deps = {}) {
  const Payment = deps.Payment || (await import("../models/payment.model.js")).default;
  if (!tenantId) throw AppError.unauthorized("Tenant context required");

  if (cmd.transition === "manual_record") {
    const existing = await Payment.find({
      tenantId,
      registrationId: cmd.objectId,
      status: { $in: MUTABLE_RECORDED },
      isActiveAttempt: { $ne: false },
    }).select({ _id: 1, mode: 1, status: 1, amount: 1, currency: 1, external: 1 }).limit(2).lean();
    return { row: null, existing };
  }

  const filter =
    cmd.transition === "capture" || cmd.transition === "cancel"
      ? { tenantId, "stripe.paymentIntentId": paymentIntentId }
      : { tenantId, _id: cmd.paymentId };
  const rows = await Payment.find(filter).limit(2).lean();
  if (rows.length === 0) throw err(404, "PAYMENT_NOT_FOUND", "Payment not found");
  if (rows.length > 1) throw err(409, "PAYMENT_AMBIGUOUS", "More than one payment matches this command");
  const row = rows[0];

  const rowApp = str(row.applicationId);
  const rowReg = str(row.registrationId);
  if (!rowApp && !rowReg) throw err(409, "PAYMENT_UNBOUND", "This payment is not bound to a business object");
  const rowObject = cmd.domain === "application" ? rowApp : rowReg;
  const rowOther = cmd.domain === "application" ? rowReg : rowApp;
  // Webhook-upserted application payments carry the schema default purpose "subscriptionFee"
  // (see paymentMutationAuthority.middleware.js APPLICATION_ROW_PURPOSES): equivalent to
  // applicationFee only for an application binding with a matching applicationId.
  const purposeMatches =
    str(row.purpose) === cmd.purpose ||
    (cmd.domain === "application" && cmd.purpose === "applicationFee" && str(row.purpose) === "subscriptionFee");
  if (
    rowObject !== cmd.objectId ||
    rowOther ||
    !purposeMatches ||
    str(row.ledgerDomain || "membership") !== DOMAIN_LEDGER[cmd.domain] ||
    (cmd.paymentId && String(row._id) !== cmd.paymentId)
  ) {
    // Never say which field differed.
    throw err(409, "PAYMENT_BINDING_MISMATCH", "This payment is not bound to the named business object");
  }
  const external = str(row.mode) === "external";
  if ((cmd.transition === "manual_post" || cmd.transition === "manual_void") !== external) {
    throw err(409, "TRANSITION_NOT_ALLOWED", "This transition does not apply to this payment");
  }
  // A registration row created before payer binding may have had its registrationId attached by
  // a portal caller: it may release money (cancel) but never be captured on that claim alone.
  if (cmd.transition === "capture" && cmd.domain === "registration" && !registrationCaptureVerified(row, cmd.objectId)) {
    throw err(409, "PAYMENT_BINDING_UNVERIFIED", "This payment's registration binding cannot be verified for capture");
  }
  if (cmd.expected) {
    if (
      (cmd.expected.amount != null && cmd.expected.amount !== row.amount) ||
      (cmd.expected.currency && cmd.expected.currency !== str(row.currency).toLowerCase())
    ) {
      throw err(409, "STRIPE_MISMATCH", "Payment amount or currency does not match");
    }
  }
  return { row };
}

/** Audit entry for a bound command (actorUserId is audit metadata, never authority). */
export function boundAuditEntry(cmd, status, correlationId) {
  return {
    eventId: `bound:${cmd.transition}:${correlationId || crypto.randomUUID()}`,
    eventType: `bound.${cmd.transition}`,
    source: "internal",
    status,
    message: `actor=${cmd.actorUserId} reason=${cmd.reason}`,
    receivedAt: new Date(),
  };
}
