export const FILTER_OPERATOR = {
  EQUAL_TO: "equal_to",
  NOT_EQUAL_TO: "not_equal_to",
  BETWEEN: "between",
  WITHIN: "within",
  MORE_THAN: "more_than",
};

export const CREDIT_NOTE_FILTER_FIELD_MAP = {
  status: "status",
  memberId: "memberId",
  docNo: "docNo",
  invoiceDocNo: "invoiceDocNo",
  effectiveDate: "effectiveDate",
  createdAt: "createdAt",
};

export const CREDIT_NOTE_TEMPLATE_FILTER_KEYS = Object.keys(
  CREDIT_NOTE_FILTER_FIELD_MAP,
);

export const FINANCE_TEMPLATE_TYPES = ["creditnotes"];

export const OPEN_COLUMN_TEMPLATE_TYPES = [...FINANCE_TEMPLATE_TYPES];
