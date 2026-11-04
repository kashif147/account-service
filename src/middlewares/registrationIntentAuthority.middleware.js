// P5 (b12) registration-backed intent creation - the manual-to-card binding takeover.
//
// POST /payments/intents with a registrationId (purpose eventRegistration / courseRegistration) can
// RELEASE the registration's current binding holder. For an unposted manual/comp/invoice record
// that release also cancels the record (payments.service.js releaseRegistrationBinding,
// MANUAL_TO_CARD) - the same business effect as manual_void, which is a signed, events:write
// operation. Before this change ANY CRM token (and any bare internal header) could trigger it.
//
// Rules (run after authentication, before the service). Only the TAKEOVER is gated - creating a
// registration-backed intent is otherwise unchanged (existing callers and the reviewed payer-binding
// behaviour are kept; see residual note below):
//   - not a registration-backed intent (no registrationId, other purpose)  -> no takeover
//   - PORTAL-like caller                -> no takeover (the service refuses a registrationId anyway)
//   - genuine internal S2S (x-internal-request, no user identity)
//                                        -> takeover allowed. Caller identity is the signed service
//                                           boundary (serviceAuth "intent_registration", events-service
//                                           only; report mode measures, enforce refuses unsigned).
//   - CRM user                          -> takeover only with the EXACT events:write business permission
//                                           (the retry-payment business action) or the ASU "*"; never
//                                           "any CRM". Without it an unposted manual holder simply stays
//                                           the holder (409 REGISTRATION_PAYMENT_HELD) - nothing is cancelled.
// Residual (recorded, not closed here): a CRM caller without events permissions can still create a
// registration-backed intent that claims a FREE (unheld) registration binding - no money moves and the
// manual record path is unaffected; closing it is the S3 R2 user-path removal.
// Sets req.registrationIntentAuthority = { manualToCardAllowed } for the controller.
import { isCrmCaller, isTrustedInternalCall } from "./callerScope.middleware.js";
import { collectRequestPermissions } from "../helpers/financePermissions.js";
import { hasExactBusinessPermission } from "./paymentMutationAuthority.middleware.js";

const REGISTRATION_PURPOSES = new Set(["eventRegistration", "courseRegistration"]);

export function registrationIdOfIntentBody(body = {}) {
  const md = body && typeof body.metadata === "object" && body.metadata ? body.metadata : {};
  const v = body.registrationId || md.registrationId || md.registration_id;
  return v == null ? "" : String(v).trim();
}

export function isRegistrationBackedIntent(body = {}) {
  return REGISTRATION_PURPOSES.has(String(body?.purpose || "")) && Boolean(registrationIdOfIntentBody(body));
}

export function requireRegistrationIntentAuthority(req, res, next) {
  req.registrationIntentAuthority = { manualToCardAllowed: false };
  if (!isRegistrationBackedIntent(req.body)) return next();
  if (isTrustedInternalCall(req)) {
    req.registrationIntentAuthority = { manualToCardAllowed: true };
    return next();
  }
  if (isCrmCaller(req)) {
    req.registrationIntentAuthority = {
      manualToCardAllowed: hasExactBusinessPermission(collectRequestPermissions(req), "events:write"),
    };
  }
  return next();
}
