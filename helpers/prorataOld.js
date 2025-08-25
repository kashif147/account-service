import dayjs from "dayjs";

/**
 * Calculate pro-rata based on days left in the joinDate's calendar year.
 * If yearEndDate is omitted, we use endOfYear(joinDate) automatically.
 */
export function calculateProRataFee(joinDate, yearEndDate, annualFee) {
  const start = dayjs(joinDate).startOf("day");
  const end = yearEndDate
    ? dayjs(yearEndDate).endOf("day")
    : start.endOf("year"); // ← derive from joinDate's year

  if (end.isBefore(start)) return { daysRemaining: 0, totalDays: 0, prorataFee: 0 };

  const yearStart = start.startOf("year");
  const yearEnd = start.endOf("year");     // same calendar year as joinDate
  const totalDays = yearEnd.diff(yearStart, "day") + 1; // leap years handled

  const daysRemaining = end.diff(start, "day") + 1;     // inclusive
  const prorataFee = Number(((annualFee / totalDays) * daysRemaining).toFixed(2));

  return { daysRemaining, totalDays, prorataFee, inferredYearEnd: end.format("YYYY-MM-DD") };
}
