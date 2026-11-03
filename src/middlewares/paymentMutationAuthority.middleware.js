// P5 payment-mutation containment (owner-approved temporary narrowing; NOT a security closure).
//
// capture / cancel (POST /payments/intents/:pi/...) and the events manual-payment record / post /
// void (POST /journal/events/manual-payment[/post|/void]) were open to ANY CRM token of the
// tenant. Until the bound internal command (contract S1-S3) replaces the user path, a CRM caller
// must hold the EXACT business permission of the business action that legitimately triggers the
// mutation, for the domain of the STORED payment row:
//
//   applicationFee row (membership)             capture / cancel             application:write
//   eventRegistration / courseRegistration row  capture / cancel / post / void  events:write
//   new events manual payment (record)          manual_record                events:create
//
// "*" (the ASU own-tenant administrator token) also passes. Nothing else does: payments:write,
// finance aliases and resource wildcards are never accepted here. A row that is not bound to an
// application or a registration fails closed (409 PAYMENT_UNBOUND); more than one row for the
// same key is 409 PAYMENT_AMBIGUOUS. The row is looked up in the verified tenant only.
//
// This does NOT verify the caller's authority over the specific object (that needs the bound
// command from the owning service). Genuine internal S2S calls are unchanged here.
import mongoose from "mongoose";
import { AppError } from "../errors/AppError.js";
import { isCrmCaller, isTrustedInternalCall } from "./callerScope.middleware.js";
import { collectRequestPermissions } from "../helpers/financePermissions.js";
import { tenantOf } from "../helpers/tenantScope.js";
import logger from "../config/logger.js";

export const TRANSITIONS = Object.freeze([
  "capture",
  "cancel",
  "manual_record",
  "manual_post",
  "manual_void",
]);

const REGISTRATION_PURPOSES = new Set(["eventRegistration", "courseRegistration"]);

export const BUSINESS_PERMISSION = Object.freeze({
  application: Object.freeze({ capture: "application:write", cancel: "application:write" }),
  registration: Object.freeze({
    capture: "events:write",
    cancel: "events:write",
    manual_post: "events:write",
    manual_void: "events:write",
    manual_record: "events:create",
  }),
});

function norm(v) {
  return v == null ? "" : String(v).trim();
}

/**
 * Business domain a stored Payment row is bound to, or null when it is not bound to exactly one
 * business object of a known purpose (fail closed).
 */
// Webhook-upserted application payments are stored with the schema default purpose
// "subscriptionFee" (payments.service.js reconcileStripeEvent $setOnInsert) while carrying the
// applicationId - on DEV most open application holds look like this. Such a row is an
// application payment for authorization purposes; a subscriptionFee row WITHOUT an
// applicationId stays unbound.
export const APPLICATION_ROW_PURPOSES = new Set(["applicationFee", "subscriptionFee"]);

export function bindingDomainOfRow(row) {
  if (!row) return null;
  const purpose = norm(row.purpose);
  const hasApp = norm(row.applicationId) !== "";
  const hasReg = norm(row.registrationId) !== "";
  if (
    APPLICATION_ROW_PURPOSES.has(purpose) && hasApp && !hasReg &&
    (norm(row.ledgerDomain) || "membership") === "membership"
  ) {
    return "application";
  }
  if (REGISTRATION_PURPOSES.has(purpose) && hasReg && !hasApp && norm(row.ledgerDomain) === "events") {
    return "registration";
  }
  return null;
}

/** Exact business permission (or the ASU "*") - never an alias or a resource wildcard. */
export function hasExactBusinessPermission(permissions, code) {
  const perms = Array.isArray(permissions) ? permissions : [];
  return perms.includes(code) || perms.includes("*");
}

async function defaultLoadRows({ transition, tenantId, paymentIntentId, paymentId }) {
  const { default: Payment } = await import("../models/payment.model.js");
  const filter =
    transition === "capture" || transition === "cancel"
      ? { tenantId, "stripe.paymentIntentId": paymentIntentId }
      : { tenantId, _id: paymentId };
  return Payment.find(filter)
    .select({ _id: 1, purpose: 1, ledgerDomain: 1, applicationId: 1, registrationId: 1, mode: 1 })
    .limit(2)
    .lean();
}

function permissionDenied(code) {
  return new AppError(
    `This payment action requires the ${code} business permission`,
    403,
    "PAYMENT_MUTATION_PERMISSION_REQUIRED",
  );
}

export function createRequirePaymentMutationAuthority(transition, deps = {}) {
  if (!TRANSITIONS.includes(transition)) throw new Error(`unknown payment transition ${transition}`);
  const loadRows = deps.loadRows || defaultLoadRows;
  const log = deps.logger || logger;

  return async function requirePaymentMutationAuthority(req, res, next) {
    // Genuine internal S2S (no user identity): unchanged by the containment step.
    if (isTrustedInternalCall(req)) return next();
    if (!isCrmCaller(req)) {
      return next(new AppError("This action is restricted to CRM staff", 403, "CRM_ONLY"));
    }
    const tenantId = norm(tenantOf(req));
    if (!tenantId) return next(AppError.unauthorized("Tenant context required"));
    const permissions = collectRequestPermissions(req);
    const userId = norm(req.ctx?.userId || req.user?.id);

    let domain;
    let paymentId = null;
    if (transition === "manual_record") {
      // The row does not exist yet: the endpoint only ever creates an events-domain payment.
      domain = "registration";
    } else {
      const lookup = { transition, tenantId };
      if (transition === "capture" || transition === "cancel") {
        lookup.paymentIntentId = norm(req.params?.paymentIntentId);
        if (!lookup.paymentIntentId) return next(AppError.badRequest("paymentIntentId is required"));
      } else {
        lookup.paymentId = norm(req.body?.paymentId);
        if (!mongoose.isValidObjectId(lookup.paymentId)) {
          return next(AppError.badRequest("paymentId is required"));
        }
      }
      let rows;
      try {
        rows = await loadRows(lookup);
      } catch (err) {
        return next(err);
      }
      if (!rows || rows.length === 0) {
        return next(new AppError("Payment not found", 404, "PAYMENT_NOT_FOUND"));
      }
      if (rows.length > 1) {
        return next(new AppError("More than one payment matches this request", 409, "PAYMENT_AMBIGUOUS"));
      }
      const row = rows[0];
      domain = bindingDomainOfRow(row);
      if (!domain) {
        return next(
          new AppError("This payment is not bound to a business object", 409, "PAYMENT_UNBOUND"),
        );
      }
      const external = norm(row.mode) === "external";
      if ((transition === "manual_post" || transition === "manual_void") !== external) {
        return next(new AppError("This action does not apply to this payment", 409, "TRANSITION_NOT_ALLOWED"));
      }
      paymentId = String(row._id);
    }

    const code = BUSINESS_PERMISSION[domain]?.[transition];
    if (!code) {
      return next(new AppError("This action does not apply to this payment", 409, "TRANSITION_NOT_ALLOWED"));
    }
    if (!hasExactBusinessPermission(permissions, code)) return next(permissionDenied(code));

    // Ids only: no amounts, names, tokens or body fields.
    log.warn(
      { event: "PAYMENT_MUTATION_USER_PATH", tenantId, paymentId, transition, domain, userId },
      "payment mutation via the transitional CRM user path",
    );
    req.paymentMutation = { transition, domain, paymentId };
    return next();
  };
}
