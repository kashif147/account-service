function r2(n){return Math.round((n + Number.EPSILON)*100)/100;}

export function stripeFeeBreakdown(gross, { pct=0.014, fixed=0.25, vat=0.23 } = {}) {
  const feeNoVat = r2(gross * pct + fixed);
  const feeVat   = r2(feeNoVat * vat);
  const feeTotal = r2(feeNoVat + feeVat);
  return { feeNoVat, feeVat, feeTotal };
}
