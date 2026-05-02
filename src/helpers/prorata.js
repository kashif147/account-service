import dayjs from "dayjs";
import { AppError } from "../errors/AppError.js";

// Removed round2 - amounts are now stored as integer cents, no rounding needed

/** Gregorian leap-year aware day count */
export function daysInYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/** Inclusive day-diff between two ISO dates (YYYY-MM-DD) */
export function diffDaysInclusive(fromISO, toISO) {
  const from = dayjs(fromISO).startOf("day");
  const to = dayjs(toISO).endOf("day");
  const d = to.diff(from, "day") + 1;
  if (d < 0)
    throw AppError.badRequest(`Invalid range ${fromISO} → ${toISO}`, {
      fromISO,
      toISO,
    });
  return d;
}

/** Start/End of the calendar year for a given ISO date */
export function yearBoundsFrom(dateISO) {
  const d = dayjs(dateISO);
  return {
    startISO: d.startOf("year").format("YYYY-MM-DD"),
    endISO: d.endOf("year").format("YYYY-MM-DD"),
    year: d.year(),
  };
}

/** Latest calendar day (YYYY-MM-DD); invalid inputs fall back to the other. */
export function laterIsoDate(isoA, isoB) {
  const a = dayjs(String(isoA ?? "").split("T")[0]);
  const b = dayjs(String(isoB ?? "").split("T")[0]);
  if (!a.isValid()) return b.format("YYYY-MM-DD");
  if (!b.isValid()) return a.format("YYYY-MM-DD");
  return a.isAfter(b) ? a.format("YYYY-MM-DD") : b.format("YYYY-MM-DD");
}

// export function daysInclusive(aISO, bISO) {
//   const a = dayjs(aISO).startOf("day");
//   const b = dayjs(bISO).endOf("day");
//   return b.diff(a, "day") + 1;
// }

export function totalDaysInYearOf(dateISO) {
  const d = dayjs(dateISO);
  return d.endOf("year").diff(d.startOf("year"), "day") + 1; // handles leap years
}

/**
 * Pro-rate an annual fee (in cents) over an inclusive period within a single calendar year
 * @param {number} annualFeeCents - Annual fee in cents (integer)
 * @param {string} fromISO - Start date (YYYY-MM-DD)
 * @param {string} toISO - End date (YYYY-MM-DD)
 * @returns {number} Pro-rated amount in cents (integer)
 */
export function prorataForPeriod(annualFeeCents, fromISO, toISO) {
  // Validate input is integer
  if (!Number.isInteger(annualFeeCents)) {
    throw AppError.badRequest(
      "annualFeeCents must be an integer (minor units)",
      { annualFeeCents, fromISO, toISO }
    );
  }
  
  const fromY = dayjs(fromISO).year();
  const toY = dayjs(toISO).year();
  if (fromY !== toY)
    throw AppError.badRequest(
      "Pro-rata period must be within one calendar year",
      { fromISO, toISO, fromYear: fromY, toYear: toY }
    );
  const numDays = diffDaysInclusive(fromISO, toISO);
  const denomDays = daysInYear(fromY);
  // Calculate in cents, maintain precision, round to integer
  const amountCents = Math.round((Number(annualFeeCents) * numDays) / denomDays);
  return amountCents; // Integer in cents
}

/**
 * Pro-rate from join date (inclusive) to that year's end (inclusive)
 * @param {number} annualFeeCents - Annual fee in cents (integer)
 * @param {string} joinISO - Join date (YYYY-MM-DD)
 * @returns {number} Pro-rated amount in cents (integer)
 */
export function prorataFromJoinToYearEnd(annualFeeCents, joinISO) {
  // Validate input is integer
  if (!Number.isInteger(annualFeeCents)) {
    throw AppError.badRequest(
      "annualFeeCents must be an integer (minor units)",
      { annualFeeCents, joinISO }
    );
  }
  
  const { endISO, year } = yearBoundsFrom(joinISO);
  const numDays = diffDaysInclusive(joinISO, endISO);
  const denomDays = daysInYear(year);
  // Calculate in cents, maintain precision, round to integer
  const amountCents = Math.round((Number(annualFeeCents) * numDays) / denomDays);
  return amountCents; // Integer in cents
}
