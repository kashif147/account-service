// Server-side price for an application payment link. The amount is never taken from a
// client: the membership category and payment type come from profile-service's own
// application record (in the requested event), and the annual fee from this tenant's synced
// product catalogue via getMembershipPricing() - the resolver the approval listener and the
// portal intent guard use.
//
// Owner rule (2026-10-29): Credit Card -> the full annual fee (ANNUAL); any other supported
// payment type -> three months' fee, one quarter of the annual fee (THREE_MONTHS), rounded
// with the same rule the portal guard already enforces (quarterlyInstalmentCents).
const CARD_PAYMENT_TYPE = "credit card";
// profile-service constants/enums.js PAYMENT_TYPE values.
const SUPPORTED_PAYMENT_TYPES = new Set([
  "credit card",
  "salary deduction",
  "direct debit",
  "standing order",
  "cheque",
  "cash",
]);

/**
 * Three months' fee in minor units: Math.round(annual / 4). The single rounding rule shared by
 * payment links and the portal intent guard (paymentIntentGuard.service.js).
 */
export function quarterlyInstalmentCents(annualCents) {
  return Math.round(annualCents / 4);
}

export function isCardPaymentType(paymentType) {
  return String(paymentType || "").trim().toLowerCase() === CARD_PAYMENT_TYPE;
}

/** ANNUAL for card applications, THREE_MONTHS for every other supported type, else null. */
export function pricingBasisFor(paymentType) {
  const t = String(paymentType || "").trim().toLowerCase();
  if (!SUPPORTED_PAYMENT_TYPES.has(t)) return null;
  return t === CARD_PAYMENT_TYPE ? "ANNUAL" : "THREE_MONTHS";
}

export class PriceError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "PriceError";
    this.reason = reason;
  }
}

async function defaultGetMembershipPricing(args) {
  const mod = await import("../handlers/application.approval.listener.js");
  return mod.getMembershipPricing(args);
}

/**
 * @returns {Promise<{amount:number,currency:string,paymentOption:"FULL"|"FIRST_INSTALMENT",pricingBasis:object}>}
 * @throws {PriceError} reason PAYMENT_METHOD_NOT_SUPPORTED | PAYMENT_NOT_REQUIRED | PRICE_UNAVAILABLE
 */
export async function computeApplicationAmount(
  { tenantId, applicationId, membershipCategory, paymentType, now = new Date() },
  deps = {},
) {
  const basis = pricingBasisFor(paymentType);
  if (!basis) {
    throw new PriceError("PAYMENT_METHOD_NOT_SUPPORTED", "Unknown payment type for this application");
  }
  const categoryName = String(membershipCategory || "").trim();
  if (!categoryName) throw new PriceError("PRICE_UNAVAILABLE", "Application has no membership category");
  const getMembershipPricing = deps.getMembershipPricing || defaultGetMembershipPricing;
  const today = now.toISOString().split("T")[0];
  let annualFee = null;
  let priceSource = null;
  try {
    ({ annualFee, priceSource } = await getMembershipPricing({
      categoryName,
      subscriptionDetails: {},
      startDate: today,
      tenantId,
      applicationId,
      referenceIsoDate: today,
    }));
  } catch {
    annualFee = null;
    priceSource = null;
  }
  // Payment links charge only an authoritative price from THIS tenant's catalogue. The shared
  // resolver falls back to a hardcoded default when no product/pricing matches (legacy approval
  // invoicing relies on that); a link must never charge it.
  if (priceSource === "no_fee_category" && annualFee === 0) {
    throw new PriceError("PAYMENT_NOT_REQUIRED", "No fee for this membership category");
  }
  if (priceSource !== "catalogue") {
    throw new PriceError("PRICE_UNAVAILABLE", "No catalogue price for this membership category in this tenant");
  }
  // A catalogue row priced at zero is also "not required"; a non-card method is not.
  if (annualFee === 0) throw new PriceError("PAYMENT_NOT_REQUIRED", "No fee for this membership category");
  if (!Number.isInteger(annualFee) || annualFee <= 0) {
    throw new PriceError("PRICE_UNAVAILABLE", "No payable catalogue price for this membership category");
  }
  const amount = basis === "ANNUAL" ? annualFee : quarterlyInstalmentCents(annualFee);
  return {
    amount,
    currency: "eur",
    paymentOption: basis === "ANNUAL" ? "FULL" : "FIRST_INSTALMENT",
    pricingBasis: {
      basis,
      rule: basis === "ANNUAL" ? "ANNUAL_FEE" : "ANNUAL_FEE_DIV_4_MATH_ROUND",
      annualFee,
      membershipCategory: categoryName,
      paymentType,
      pricedAt: now.toISOString(),
    },
  };
}
