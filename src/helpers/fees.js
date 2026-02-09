/**
 * Calculate Stripe fees from gross amount in cents
 * @param {number} grossCents - Gross amount in cents (integer)
 * @param {Object} options - Fee configuration
 * @param {number} options.pct - Percentage fee (default: 0.014 = 1.4%)
 * @param {number} options.fixed - Fixed fee in euros (default: 0.25)
 * @param {number} options.vat - VAT rate (default: 0.23 = 23%)
 * @returns {Object} Fees in cents (integers)
 */
export function stripeFeeBreakdown(grossCents, { pct=0.014, fixed=0.25, vat=0.23 } = {}) {
  // Validate input is integer (cents)
  if (!Number.isInteger(grossCents)) {
    throw new Error(`grossCents must be an integer, got: ${typeof grossCents} ${grossCents}`);
  }
  
  // Convert fixed fee from euros to cents
  const fixedCents = Math.round(fixed * 100);
  
  // Calculate fees in cents (maintain precision during calculation)
  // Use Math.round to ensure integer results
  const feeNoVatCents = Math.round(grossCents * pct + fixedCents);
  const feeVatCents = Math.round(feeNoVatCents * vat);
  const feeTotalCents = feeNoVatCents + feeVatCents;
  
  return { 
    feeNoVat: feeNoVatCents, 
    feeVat: feeVatCents, 
    feeTotal: feeTotalCents 
  };
}
