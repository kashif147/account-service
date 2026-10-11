// Server-side authorization of POST /api/payments/intents inputs (H-11, corrected in
// Phase 2B-PARALLEL-2). The client may calculate or choose an amount; the backend checks
// that the submitted amount is allowed by current server-side rules and financial state.
//
//  - APPLICATION payments (applicationId, no membership number yet; portal
//    SubscriptionWrapper): application -> payment -> approval -> member creation. The
//    application is loaded from portal-service AS THE CALLER under the trusted tenant
//    (proves it exists in this tenant and belongs to the caller). Its OWN subscription
//    record supplies the membership category and payment type (never the client
//    metadata). Allowed amounts mirror the portal's existing rule: Credit Card -> the
//    annual catalogue fee; any other payment type -> the first-quarter instalment
//    (Math.round(annual / 4)) or the full annual fee. The annual fee comes from the synced
//    catalogue via getMembershipPricing(), the same resolver the approval listener uses.
//  - MEMBER payments ON ACCOUNT (memberId = the caller's own membership number): the
//    member chooses full or partial payment of their CURRENT outstanding balance
//    (MaterializedBalance 1400 arrears + current, this tenant): 0 < amount <= outstanding.
//  - Event/course registrations: price lives in events-service, which re-verifies amount
//    and currency before attaching the intent; manual capture at CRM approval. Unchanged.
//  - Any other portal payment (no applicationId and no memberId) is rejected: it could not
//    be reconciled to anything.
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

async function defaultFetchMyApplicationSubscription(req, applicationId) {
  const mod = await import("./portalUpstream.client.js");
  return mod.fetchMyApplicationSubscription(req, applicationId);
}

/** Current outstanding membership AR (cents) for the member in this tenant. */
async function defaultGetMemberOutstandingCents(memberId, tenantId) {
  const mod = await import("../helpers/paymentReceiptAllocation.js");
  const { arrears, current } = await mod.memberOwed1400AllYears(memberId, { tenantId });
  return Math.max(0, arrears || 0) + Math.max(0, current || 0);
}

const CARD_PAYMENT_TYPE = "credit card";

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
  const fetchMyApplicationSubscription =
    deps.fetchMyApplicationSubscription || defaultFetchMyApplicationSubscription;
  const getMemberOutstandingCents =
    deps.getMemberOutstandingCents || defaultGetMemberOutstandingCents;

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

  if (!Number.isInteger(parsed.amount) || parsed.amount <= 0) {
    throw AppError.badRequest("amount must be a positive integer (minor units)");
  }

  // Events/courses: re-verified by events-service (see header). Unchanged.
  if (isEventRegistrationPayment) return { checked: true, kind: "event" };

  // 2) Application payment: the caller's own application in this tenant.
  if (isApplicationPayment) {
    let app;
    try {
      app = await fetchMyApplicationSubscription(caller.req, applicationId);
    } catch (err) {
      if (err?.name === "UpstreamNotFoundError") {
        throw AppError.notFound("Application not found");
      }
      throw AppError.serviceUnavailable(
        "Unable to verify the application for this payment. Please try again.",
      );
    }
    const categoryName = norm(app?.membershipCategory);
    if (!categoryName) {
      throw AppError.badRequest("The application has no membership category to price");
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
    const isCard = norm(app?.paymentType).toLowerCase() === CARD_PAYMENT_TYPE;
    const allowed = isCard ? [annualFee] : [Math.round(annualFee / 4), annualFee];
    if (!allowed.includes(parsed.amount)) {
      throw AppError.badRequest(
        "Payment amount does not match the membership fee for this application",
      );
    }
    // Record the authoritative category on the intent, never the client's value.
    metadata.membershipCategory = categoryName;
    return { checked: true, kind: "application", annualFee, allowed, paymentType: app?.paymentType || null };
  }

  // 3) Member payment on account: full or partial payment of the current outstanding balance.
  if (!wantMember) {
    throw AppError.badRequest("memberId or applicationId is required for this payment");
  }
  let outstandingCents;
  try {
    outstandingCents = await getMemberOutstandingCents(wantMember, tenantId);
  } catch {
    throw AppError.serviceUnavailable(
      "Unable to read the outstanding balance for this payment. Please try again.",
    );
  }
  if (!Number.isFinite(outstandingCents) || outstandingCents <= 0) {
    throw AppError.badRequest("There is no outstanding balance to pay");
  }
  if (parsed.amount > outstandingCents) {
    throw AppError.badRequest("Payment amount exceeds the outstanding balance", {
      outstandingCents,
    });
  }
  return { checked: true, kind: "member", outstandingCents };
}
