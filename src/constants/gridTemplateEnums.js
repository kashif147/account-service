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

export const JOURNAL_ADJUSTMENT_FILTER_FIELD_MAP = {
  approvalStatus: "approvalStatus",
  docNo: "docNo",
  debitAccount: "debitAccount",
  creditAccount: "creditAccount",
  memberId: "memberId",
  reason: "reason",
  effectiveDate: "effectiveDate",
  createdAt: "createdAt",
};

export const JOURNAL_ADJUSTMENT_TEMPLATE_FILTER_KEYS = Object.keys(
  JOURNAL_ADJUSTMENT_FILTER_FIELD_MAP,
);

export const FINANCE_TEMPLATE_TYPES = ["creditnotes", "journaladjustments"];

export const OPEN_COLUMN_TEMPLATE_TYPES = [...FINANCE_TEMPLATE_TYPES];
