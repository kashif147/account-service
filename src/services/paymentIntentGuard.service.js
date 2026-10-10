// Server-side authorization of POST /api/payments/intents inputs (H-11).
//
// Authoritative amount sources, by payment kind:
//  - Membership APPLICATION payments (applicationId, no membership number yet — portal
//    SubscriptionWrapper): the synced product catalogue (Product/Pricing, kept current by
//    product.sync.listener) resolved through getMembershipPricing(), the same resolver the
//    approval listener uses to post the invoice. Accepted amounts are the annual fee or the
//    quarterly instalment (Math.round(annual / 4)) — exactly what the portal offers.
//  - Member payments ON ACCOUNT (memberId = caller's own membership number, no
//    applicationId — portal dashboard "pay now"): the payer chooses how much to pay towards
//    their own balance by design; the receipt posts only what Stripe actually captures, so
//    a small amount cannot mark anything as paid. Ownership of memberId is enforced.
//  - Event/course registrations: price lives in events-service (price-quote). events-service
//    re-verifies amount/currency against GET /payments/by-stripe/:id before attaching the
//    intent to a Registration, and these intents are manual-capture, captured only at CRM
//    approval. Not re-priced here (account-service has no event pricing).
//
// Caller scope: the checks apply to user-originated calls that are not CRM staff (PORTAL
// members and any unknown user type). Genuine S2S calls (x-internal-request, no user JWT)
// and CRM users are unchanged.
import { AppError } from "../errors/AppError.js";

function norm(v) {
  return v == null ? "" : String(v).trim();
}

export function isPortalLikeCaller(caller = {}) {
  if (caller.internalRequest === true) return false;
  return String(caller.userType || "").toUpperCase() !== "CRM";
}

async function defaultGetMembershipPricing(args) {
  const mod = await import("../handlers/application.approval.listener.js");
  return mod.getMembershipPricing(args);
}

async function defaultFetchMyPortalProfile(req) {
  const mod = await import("./profileUpstream.client.js");
  return mod.fetchMyPortalProfile(req);
}

/**
 * @param {object} p
 * @param {object} p.parsed           zCreateIntent output
 * @param {object} p.metadata         parsed.metadata || {}
 * @param {string} [p.memberId]
 * @param {string} [p.applicationId]
 * @param {string} [p.profileId]
 * @param {boolean} p.isApplicationPayment
 * @param {boolean} p.isEventRegistrationPayment
 * @param {object} p.ctx              trusted req.ctx (tenantId)
 * @param {object} p.caller           { userType, internalRequest, req }
 */
export async function assertIntentAuthorized(
  {
    parsed,
    metadata = {},
    memberId,
    applicationId,
    profileId,
    isApplicationPayment,
    isEventRegistrationPayment,
    ctx = {},
    caller = {},
  },
  deps = {},
) {
  if (!isPortalLikeCaller(caller)) return { checked: false };

  const tenantId = norm(ctx.tenantId);
  if (!tenantId) throw AppError.unauthorized("Tenant context required");

  const getMembershipPricing =
    deps.getMembershipPricing || defaultGetMembershipPricing;
  const fetchMyPortalProfile =
    deps.fetchMyPortalProfile || defaultFetchMyPortalProfile;

  // 1) Ownership of member/profile identifiers (portal callers only ever pay for themselves).
  const wantMember = norm(memberId);
  const wantProfile = norm(profileId);
  if (wantMember || wantProfile) {
    let mine;
    try {
      mine = await fetchMyPortalProfile(caller.req);
    } catch {
      throw AppError.serviceUnavailable(
        "Unable to verify the member for this payment. Please try again.",
      );
    }
    if (wantMember && norm(mine?.membershipNumber) !== wantMember) {
      throw AppError.forbidden("memberId does not belong to the caller");
    }
    if (wantProfile && norm(mine?.profileId) !== wantProfile) {
      throw AppError.forbidden("profileId does not belong to the caller");
    }
  }

  // 2) Amount for membership application payments comes from the catalogue.
  if (isApplicationPayment && !isEventRegistrationPayment) {
    const categoryName = norm(
      metadata.membershipCategory || metadata.membership_category,
    );
    if (!categoryName) {
      throw AppError.badRequest(
        "membershipCategory is required to price an application payment",
      );
    }
    const today = new Date().toISOString().split("T")[0];
    let annualFee = null;
    try {
      ({ annualFee } = await getMembershipPricing({
        categoryName,
        subscriptionDetails: {},
        startDate: today,
        tenantId,
        applicationId,
        referenceIsoDate: today,
      }));
    } catch {
      annualFee = null;
    }
    if (!Number.isInteger(annualFee) || annualFee <= 0) {
      throw AppError.badRequest(
        "No payable catalogue price for this membership category",
      );
    }
    const allowed = new Set([annualFee, Math.round(annualFee / 4)]);
    if (!allowed.has(parsed.amount)) {
      throw AppError.badRequest(
        "Payment amount does not match the membership fee for this category",
      );
    }
    return { checked: true, annualFee, allowed: [...allowed] };
  }

  return { checked: true };
}
