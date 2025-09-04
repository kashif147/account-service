import dayjs from "dayjs";
import { AppError } from "../errors/AppError.js";

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

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
 * Pro-rate an annual fee over an inclusive period within a single calendar year,
 * using explicit daysInYear(year).
 */
export function prorataForPeriod(annualFee, fromISO, toISO) {
  const fromY = dayjs(fromISO).year();
  const toY = dayjs(toISO).year();
  if (fromY !== toY)
    throw AppError.badRequest(
      "Pro-rata period must be within one calendar year",
      { fromISO, toISO, fromYear: fromY, toYear: toY }
    );
  const numDays = diffDaysInclusive(fromISO, toISO);
  const denomDays = daysInYear(fromY);
  const amount = (Number(annualFee) * numDays) / denomDays;
  return Math.round((amount + Number.EPSILON) * 100) / 100; // round to 2dp
}

/** Pro-rate from join date (inclusive) to that year’s end (inclusive). */
export function prorataFromJoinToYearEnd(annualFee, joinISO) {
  const { endISO, year } = yearBoundsFrom(joinISO);
  const numDays = diffDaysInclusive(joinISO, endISO);
  const denomDays = daysInYear(year);
  const amount = (Number(annualFee) * numDays) / denomDays;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
