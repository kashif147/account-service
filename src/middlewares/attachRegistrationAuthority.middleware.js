// P6: POST /payments/intents/:paymentIntentId/attach-registration.
//
// Before P6 the CRM branch of requireInternalOrCrmOrIntentOwner let ANY verified CRM user attach a
// registration to any PaymentIntent of the tenant, with no business permission. Now:
//   - genuine internal call (x-internal-request, no user identity)  -> unchanged (allowed)
//   - verified CRM user   -> needs the EXACT events:write business permission (or the ASU tenant wildcard "*",
//                            as every exact-business-permission check here); else 403 EVENTS_WRITE_REQUIRED
//   - PORTAL member       -> unchanged: must be the verified payer of the intent (requireInternalOrCrmOrIntentOwner)
//   - anything else       -> 403 CRM_ONLY (unchanged)
// Tenant and object checks stay where they were: the owner lookup and attachRegistrationToPaymentIntent are
// pinned to the trusted tenant (req.ctx), and the service still validates the registration binding.
import { AppError } from "../errors/AppError.js";
import { collectRequestPermissions } from "../helpers/financePermissions.js";
import { isCrmCaller, requireInternalOrCrmOrIntentOwner } from "./callerScope.middleware.js";
import { hasExactBusinessPermission } from "./paymentMutationAuthority.middleware.js";

export const EVENTS_WRITE_REQUIRED = "EVENTS_WRITE_REQUIRED";

export function createRequireAttachRegistrationAuthority({ ownerGuard = requireInternalOrCrmOrIntentOwner } = {}) {
  return function requireAttachRegistrationAuthority(req, res, next) {
    if (isCrmCaller(req) && !hasExactBusinessPermission(collectRequestPermissions(req), "events:write")) {
      return next(new AppError("Attaching a registration requires the events:write permission", 403, EVENTS_WRITE_REQUIRED));
    }
    return ownerGuard(req, res, next);
  };
}

export const requireAttachRegistrationAuthority = createRequireAttachRegistrationAuthority();
