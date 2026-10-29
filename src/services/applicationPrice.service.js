// Server-side price for an application payment link. The amount is never taken from a
// client: the membership category and payment type come from profile-service's own
// application record (in the requested event), and the fee from this tenant's synced
// product catalogue via getMembershipPricing() - the resolver the approval listener and the
// portal intent guard use. First release: card applications pay the full annual fee only
// (no first-instalment links until instalments 2-4 have an owner). The inline portal guard
// (paymentIntentGuard.service.js) is deliberately left untouched.
const CARD_PAYMENT_TYPE = "credit card";

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
 * @returns {Promise<{amount:number,currency:string,pricingBasis:object}>}
 * @throws {PriceError} reason PAYMENT_METHOD_NOT_SUPPORTED | INSTALMENTS_NOT_ALLOWED |
 *         PAYMENT_NOT_REQUIRED | PRICE_UNAVAILABLE
 */
export async function computeApplicationAmount(
  { tenantId, applicationId, membershipCategory, paymentType, paymentOption = "FULL", now = new Date() },
  deps = {},
) {
  if (String(paymentType || "").trim().toLowerCase() !== CARD_PAYMENT_TYPE) {
    throw new PriceError("PAYMENT_METHOD_NOT_SUPPORTED", "Payment links are for card applications only");
  }
  if (paymentOption !== "FULL") {
    throw new PriceError("INSTALMENTS_NOT_ALLOWED", "Only full payment links are available");
  }
  const categoryName = String(membershipCategory || "").trim();
  if (!categoryName) throw new PriceError("PRICE_UNAVAILABLE", "Application has no membership category");
  const getMembershipPricing = deps.getMembershipPricing || defaultGetMembershipPricing;
  const today = now.toISOString().split("T")[0];
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
  if (annualFee === 0) throw new PriceError("PAYMENT_NOT_REQUIRED", "No fee for this membership category");
  if (!Number.isInteger(annualFee) || annualFee <= 0) {
    throw new PriceError("PRICE_UNAVAILABLE", "No payable catalogue price for this membership category");
  }
  return {
    amount: annualFee,
    currency: "eur",
    pricingBasis: {
      rule: "FULL_ANNUAL_FEE",
      annualFee,
      membershipCategory: categoryName,
      paymentType,
      pricedAt: now.toISOString(),
    },
  };
}
