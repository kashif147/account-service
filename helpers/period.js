import dayjs from "dayjs";

export function monthRange(yyyymm) {
  const start = dayjs(yyyymm + "-01").startOf("month");
  const end   = start.endOf("month");
  return {
    startISO: start.format("YYYY-MM-DD"),
    endISO:   end.format("YYYY-MM-DD"),
    label:    start.format("YYYY-MM")
  };
}

export function yearRange(year) {
  const start = dayjs(`${year}-01-01`).startOf("year");
  const end   = start.endOf("year");
  return {
    startISO: start.format("YYYY-MM-DD"),
    endISO:   end.format("YYYY-MM-DD"),
    label:    String(year)
  };
}

// Small util for debit/credit math (positive for D, negative for C)
export function signedAmount(entry) {
  return entry.dc === "D" ? +entry.amount : -entry.amount;
}
