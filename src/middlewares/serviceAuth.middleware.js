// P5 S3 signed service authority - verifier for the five payment-mutation routes.
//
//   POST /payments/intents/:pi/capture            capture        application -> profile-service
//   POST /payments/intents/:pi/cancel             cancel                 registration -> events-service
//   POST /journal/events/manual-payment           manual_record  events-service only
//   POST /journal/events/manual-payment/post      manual_post    events-service only
//   POST /journal/events/manual-payment/void      manual_void    events-service only
//   POST /payments/intents  (registrationId, eventRegistration/courseRegistration, INTERNAL path only)
//                                                 intent_registration  events-service only  (b12: the
//                                                 manual-to-card binding takeover; user-path callers are
//                                                 governed by registrationIntentAuthority.middleware.js)
//
// Mounted FIRST on each route (before identity, idempotency and any Stripe/DB mutation). Protocol
// and canonical string: lib/serviceSigning.js. Checks, in order:
//   1. headers present and well-formed, version 1            -> SERVICE_AUTH_REQUIRED / _MALFORMED
//   2. caller has a configured key map, kid is in it           -> SERVICE_AUTH_UNKNOWN_CALLER / _KID
//   3. |now - ts| <= 60 s                                       -> SERVICE_AUTH_STALE
//   4. HMAC over the exact transmitted body (raw bytes captured before JSON parsing), exact
//      path + raw query, tenant, Idempotency-Key, ts, nonce, caller, kid and the fixed audience,
//      compared in constant time                                -> SERVICE_AUTH_INVALID
//   5. caller allowed for this operation and the command's domain -> SERVICE_NOT_ALLOWED
//   6. nonce inserted atomically (unique (caller, nonce), TTL)   -> SERVICE_AUTH_REPLAY;
//      replay store unavailable                                  -> SERVICE_AUTH_STORE_UNAVAILABLE
// The domain used in 5 is the signed body's binding.domain; the existing bound-command checks
// (paymentMutationAuthority) then require it to equal the STORED row's domain, so a caller cannot
// reach another domain's rows. actorUserId and the body purpose are never used as caller identity.
// A legitimate retry signs again with a fresh nonce and the SAME business Idempotency-Key.
//
// Mode: PAYMENT_SERVICE_AUTH_MODE, read per request.
//   off      (default) - not evaluated.
//   report   - evaluated and logged (operation, caller, kid, outcome code only); NEVER rejects.
//              Measures compatibility only; it is not a security boundary.
//   enforce  - a signed request must pass every check; an UNSIGNED request on the internal path
//              (x-internal-request) is refused. Unsigned user-path (CRM token) requests are left to
//              the existing chain here; removing that path is the separate S3 (R2) change.
// Logs never contain the signature, nonce, secret, body or headers.
import mongoose from "mongoose";
import logger from "../config/logger.js";
import ServiceAuthNonce from "../models/serviceAuthNonce.model.js";
import { isRegistrationBackedIntent } from "./registrationIntentAuthority.middleware.js";
import {
  HEADERS,
  canonicalString,
  headerShapeError,
  keyMapEnvName,
  parseKeyMap,
  sha256Hex,
  signCanonical,
  signaturesEqual,
  withinSkew,
} from "../lib/serviceSigning.js";

export const OPERATIONS = Object.freeze(["capture", "cancel", "manual_record", "manual_post", "manual_void", "intent_registration"]);

// Caller allow-list per operation and command domain.
export const ALLOW = Object.freeze({
  capture: Object.freeze({ application: "profile-service", registration: "events-service" }),
  cancel: Object.freeze({ application: "profile-service", registration: "events-service" }),
  manual_record: Object.freeze({ registration: "events-service" }),
  manual_post: Object.freeze({ registration: "events-service" }),
  manual_void: Object.freeze({ registration: "events-service" }),
  intent_registration: Object.freeze({ registration: "events-service" }),
});

/** Command domain of a signed request: the bound command's binding.domain, or (intent create) the
 *  registration domain derived from the body. Never the caller's claim alone. */
function commandDomain(req, operation) {
  if (operation === "intent_registration") return isRegistrationBackedIntent(req.body) ? "registration" : null;
  return req.body?.binding?.domain;
}

const STATUS = Object.freeze({
  SERVICE_AUTH_REQUIRED: 401,
  SERVICE_AUTH_MALFORMED: 401,
  SERVICE_AUTH_UNKNOWN_CALLER: 401,
  SERVICE_AUTH_UNKNOWN_KID: 401,
  SERVICE_AUTH_STALE: 401,
  SERVICE_AUTH_INVALID: 401,
  SERVICE_NOT_ALLOWED: 403,
  SERVICE_AUTH_REPLAY: 409,
  SERVICE_AUTH_STORE_UNAVAILABLE: 503,
});

export function serviceAuthMode() {
  const m = String(process.env.PAYMENT_SERVICE_AUTH_MODE || "off").trim().toLowerCase();
  return m === "report" || m === "enforce" ? m : "off";
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function isInternalPath(req) {
  return String(header(req, "x-internal-request") || "").trim() === "true";
}

async function insertNonce(Model, caller, nonce) {
  if (mongoose.connection.readyState !== 1) return "SERVICE_AUTH_STORE_UNAVAILABLE";
  try {
    await Model.create({ caller, nonce, createdAt: new Date() });
    return null;
  } catch (err) {
    if (err?.code === 11000) return "SERVICE_AUTH_REPLAY";
    return "SERVICE_AUTH_STORE_UNAVAILABLE";
  }
}

/**
 * Evaluates the signature of one request. Returns { outcome, caller, kid } where outcome is
 * "valid" or one of the STATUS codes above. Side effect: a valid signature records its nonce.
 */
export async function evaluateServiceAuth(req, operation, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const Model = deps.NonceModel || ServiceAuthNonce;
  const h = {
    version: header(req, HEADERS.version),
    caller: header(req, HEADERS.caller),
    kid: header(req, HEADERS.kid),
    ts: header(req, HEADERS.ts),
    nonce: header(req, HEADERS.nonce),
    sig: header(req, HEADERS.sig),
  };
  if (!h.sig && !h.caller && !h.nonce) return { outcome: "SERVICE_AUTH_REQUIRED", caller: null, kid: null };
  if (headerShapeError(h)) return { outcome: "SERVICE_AUTH_MALFORMED", caller: null, kid: null };
  const keys = parseKeyMap(env[keyMapEnvName(h.caller)]);
  if (!keys.size || !Object.values(ALLOW).some((byDomain) => Object.values(byDomain).includes(h.caller))) {
    return { outcome: "SERVICE_AUTH_UNKNOWN_CALLER", caller: h.caller, kid: null };
  }
  const secret = keys.get(h.kid);
  if (!secret) return { outcome: "SERVICE_AUTH_UNKNOWN_KID", caller: h.caller, kid: h.kid };
  if (!withinSkew(h.ts, now)) return { outcome: "SERVICE_AUTH_STALE", caller: h.caller, kid: h.kid };

  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
  const canonical = canonicalString({
    caller: h.caller,
    kid: h.kid,
    method: req.method,
    target: req.originalUrl,
    tenant: header(req, "x-tenant-id") || "",
    idem: header(req, "idempotency-key") || "",
    bodySha256: sha256Hex(raw),
    ts: h.ts,
    nonce: h.nonce,
  });
  if (!signaturesEqual(signCanonical(secret, canonical), h.sig)) {
    return { outcome: "SERVICE_AUTH_INVALID", caller: h.caller, kid: h.kid };
  }
  const domain = commandDomain(req, operation);
  if (ALLOW[operation]?.[domain] !== h.caller) return { outcome: "SERVICE_NOT_ALLOWED", caller: h.caller, kid: h.kid };
  const nonceError = await insertNonce(Model, h.caller, h.nonce);
  if (nonceError) return { outcome: nonceError, caller: h.caller, kid: h.kid };
  return { outcome: "valid", caller: h.caller, kid: h.kid };
}

export function createServiceAuthVerifier(operation, deps = {}) {
  if (!OPERATIONS.includes(operation)) throw new Error(`unknown payment operation ${operation}`);
  const log = deps.logger || logger;
  return async function serviceAuthVerifier(req, res, next) {
    const mode = serviceAuthMode();
    if (mode === "off") return next();
    let result;
    try {
      result = await evaluateServiceAuth(req, operation, deps);
    } catch {
      result = { outcome: "SERVICE_AUTH_STORE_UNAVAILABLE", caller: null, kid: null };
    }
    const unsigned = result.outcome === "SERVICE_AUTH_REQUIRED";
    (result.outcome === "valid" ? log.info : log.warn).call(log, "[service-auth] payment command", {
      operation,
      mode,
      outcome: result.outcome,
      caller: result.caller,
      kid: result.kid,
      internalPath: isInternalPath(req),
    });
    if (result.outcome === "valid") {
      req.serviceCaller = { caller: result.caller, kid: result.kid };
      return next();
    }
    if (mode === "report") return next();
    // enforce
    if (unsigned && !isInternalPath(req)) return next(); // user path: existing chain (R2 removes it)
    return res.status(STATUS[result.outcome] || 401).json({
      success: false,
      code: result.outcome,
      message: "Service authentication failed",
    });
  };
}

// The three /journal/events/manual-payment routes (mounted with router.use("/events", ...) ahead of
// their own chains): POST /manual-payment -> manual_record, /post -> manual_post, /void -> manual_void.
const MANUAL_PAYMENT_OPERATIONS = Object.freeze({
  "/manual-payment": "manual_record",
  "/manual-payment/post": "manual_post",
  "/manual-payment/void": "manual_void",
});
export function createManualPaymentServiceAuth(deps = {}) {
  const verifiers = Object.fromEntries(
    Object.entries(MANUAL_PAYMENT_OPERATIONS).map(([p, op]) => [p, createServiceAuthVerifier(op, deps)]),
  );
  // Express route matching is case-insensitive and ignores a trailing slash; match the same way.
  return function manualPaymentServiceAuth(req, res, next) {
    const v = req.method === "POST" ? verifiers[req.path.toLowerCase().replace(/\/+$/, "")] : null;
    return v ? v(req, res, next) : next();
  };
}

/**
 * POST /payments/intents: evaluated only for a registration-backed intent on the INTERNAL path
 * (x-internal-request without a user token) - the caller able to take over a manual record's
 * binding without a business permission. User-path creates are not service-signed (their authority
 * is the CRM business permission, registrationIntentAuthority.middleware.js); everything else on
 * this route is out of scope and passes through untouched.
 */
export function createIntentRegistrationServiceAuth(deps = {}) {
  const verifier = createServiceAuthVerifier("intent_registration", deps);
  return function intentRegistrationServiceAuth(req, res, next) {
    const userToken = Boolean(req.headers.authorization || req.headers["x-jwt-verified"]);
    if (userToken || !isInternalPath(req) || !isRegistrationBackedIntent(req.body)) return next();
    return verifier(req, res, next);
  };
}
