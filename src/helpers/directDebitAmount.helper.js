const MEMBERSHIP_FEE_EUR_BY_KEY = {
  FULL_TIME: 540.0,
  PART_TIME: 360.0,
  STUDENT: 120.0,
  RETIRED: 60.0,
  ASSOCIATE: 240.0,
  GENERAL_ALL_GRADE: 326.0,
  PRIVATE_NURSING: 243.0,
};

function normalizeCategoryKey(category) {
  if (!category) return "";
  return String(category)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function annualFeeFromCategory(category) {
  const key = normalizeCategoryKey(category);
  return MEMBERSHIP_FEE_EUR_BY_KEY[key] || 0;
}

function periodsPerYear(runType, paymentFrequency) {
  const rt = String(runType || "").toUpperCase();
  if (rt === "ANNUAL") return 1;
  if (rt === "BI_WEEKLY") return 26;
  if (rt === "MONTHLY") return 12;
  const pf = String(paymentFrequency || "").toLowerCase();
  if (pf.includes("fortnight") || pf.includes("biweek")) return 26;
  if (pf.includes("week")) return 52;
  if (pf.includes("quarter")) return 4;
  if (pf.includes("annual") || pf.includes("year")) return 1;
  return 12;
}

/**
 * Collectible EUR for a DD run period (installment).
 * AD_HOC uses outstanding current bucket when provided (cents → EUR).
 */
export function computeCollectibleAmountEur({
  runType,
  membershipCategory,
  paymentFrequency,
  outstandingCurrentCents = 0,
}) {
  const annual = annualFeeFromCategory(membershipCategory);
  if (String(runType || "").toUpperCase() === "AD_HOC") {
    const owed = Math.max(0, Number(outstandingCurrentCents) || 0) / 100;
    return Math.round(owed * 100) / 100;
  }
  if (annual <= 0) return 0;
  const periods = periodsPerYear(runType, paymentFrequency);
  return Math.round((annual / periods) * 100) / 100;
}

export function buildEndToEndId({ membershipNumber, periodEndDate, runNo }) {
  const period = periodEndDate
    ? new Date(periodEndDate).toISOString().slice(0, 7).replace("-", "")
    : "000000";
  const base = `E2E-${String(membershipNumber || "MBR").replace(/\s+/g, "")}-${period}`;
  const suffix = String(runNo || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-6);
  return `${base}-${suffix}`.slice(0, 35);
}

export function buildRemittanceInfo({ membershipNumber, periodStart, periodEnd }) {
  const ps = periodStart ? new Date(periodStart).toISOString().slice(0, 10) : "";
  const pe = periodEnd ? new Date(periodEnd).toISOString().slice(0, 10) : "";
  return `Membership ${membershipNumber} ${ps} to ${pe}`.slice(0, 140);
}

export function resolveSeqTp(mandate) {
  const count = mandate?.successfulCollectionCount || 0;
  return count > 0 ? "RCUR" : "FRST";
}
