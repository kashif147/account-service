export const FILTER_OPERATOR = {
  EQUAL_TO: "equal_to",
  NOT_EQUAL_TO: "not_equal_to",
  BETWEEN: "between",
  WITHIN: "within",
  MORE_THAN: "more_than",
  LESS_THAN: "less_than",
  GREATER_THAN: "greater_than",
  LESS_THAN_OR_EQUAL: "less_than_or_equal",
  GREATER_THAN_OR_EQUAL: "greater_than_or_equal",
  CONTAINS: "contains",
  NOT_CONTAINS: "not_contains",
  STARTS_WITH: "starts_with",
  ENDS_WITH: "ends_with",
};

export const CREDIT_NOTE_FILTER_FIELD_MAP = {
  status: "status",
  memberId: "memberId",
  docNo: "docNo",
  invoiceDocNo: "invoiceDocNo",
  effectiveDate: "effectiveDate",
  createdAt: "createdAt",
  amount: "amount",
  reason: "reason",
  createdBy: "createdBy",
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

export const ONLINE_PAYMENT_FILTER_FIELD_MAP = {
  membershipStatus: "membershipStatus",
  paymentStatus: "paymentStatus",
  paymentMethod: "paymentMethod",
  billingCycle: "billingCycle",
  category: "category",
  memberNo: "memberNo",
  transactionId: "transactionId",
  fullName: "fullName",
  email: "email",
  phone: "phone",
  renewalDate: "renewalDate",
  date: "date",
  joinDate: "joinDate",
  paidAmount: "paidAmount",
};

export const ONLINE_PAYMENT_TEMPLATE_FILTER_KEYS = Object.keys(
  ONLINE_PAYMENT_FILTER_FIELD_MAP,
);

export const REFUNDS_FILTER_FIELD_MAP = {
  refundId: "refundId",
  refNo: "refNo",
  memo: "memo",
  refundDate: "refundDate",
  refundAmount: "refundAmount",
  refundType: "refundType",
  refundSource: "refundSource",
  memberNo: "memberNo",
  createdBy: "createdBy",
  createdAt: "createdAt",
};

export const REFUNDS_TEMPLATE_FILTER_KEYS = Object.keys(REFUNDS_FILTER_FIELD_MAP);

export const WRITE_OFFS_FILTER_FIELD_MAP = {
  writeOff: "writeOff",
  writeOffDate: "writeOffDate",
  ref: "ref",
  amount: "amount",
  memberId: "memberId",
  status: "status",
  type: "type",
  createdBy: "createdBy",
  createdAt: "createdAt",
  updatedBy: "updatedBy",
  updatedAt: "updatedAt",
};

export const WRITE_OFFS_TEMPLATE_FILTER_KEYS = Object.keys(
  WRITE_OFFS_FILTER_FIELD_MAP,
);

export const GENERAL_LEDGER_FILTER_FIELD_MAP = {
  memberId: "memberId",
  date: "date",
  docTypeLabel: "docTypeLabel",
  docNo: "docNo",
  debit: "debit",
  credit: "credit",
  memo: "memo",
  approvalStatus: "approvalStatus",
  createdAt: "createdAt",
};

export const GENERAL_LEDGER_TEMPLATE_FILTER_KEYS = Object.keys(
  GENERAL_LEDGER_FILTER_FIELD_MAP,
);

export const RECONCILIATION_FILTER_FIELD_MAP = {
  bankRef: "bankRef",
  memberId: "memberId",
  amount: "amount",
  expectedAmount: "expectedAmount",
  amountDifference: "amountDifference",
  matchConfidence: "matchConfidence",
  suggestedAction: "suggestedAction",
  clearingAccountCode: "clearingAccountCode",
  reconciliationStatus: "reconciliationStatus",
  matchedGlDocNo: "matchedGlDocNo",
  sourceType: "sourceType",
};

export const RECONCILIATION_TEMPLATE_FILTER_KEYS = Object.keys(
  RECONCILIATION_FILTER_FIELD_MAP,
);

export const FINANCE_TEMPLATE_TYPES = [
  "creditnotes",
  "journaladjustments",
  "onlinepayment",
  "refunds",
  "writeoffs",
  "generalledger",
  "reconciliation",
];

export const OPEN_COLUMN_TEMPLATE_TYPES = [...FINANCE_TEMPLATE_TYPES];
