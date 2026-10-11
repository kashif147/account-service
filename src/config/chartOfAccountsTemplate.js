// Platform Chart of Accounts TEMPLATE (Phase 2B-PARALLEL-2, B4).
//
// This is a source, not ledger data: actual CoA rows are tenant-owned (coa.model.js,
// unique { tenantId, code }) and are created from this template per tenant by
// services/coaProvisioning.service.js. Balances and postings never reference a shared
// row. Mirrors account-service.coas.md plus the events/CPD income rows seeded by
// scripts/seed-events-income-coa.js and scripts/seed-cpd-events-income-coa.js.
const row = (code, description, type, flags = {}) =>
  Object.freeze({
    code,
    description,
    type,
    isCash: false,
    isClearing: false,
    isMemberTracked: false,
    isRevenue: false,
    isContraRevenue: false,
    ...flags,
  });

export const CHART_OF_ACCOUNTS_TEMPLATE = Object.freeze([
  row("1100", "Cash", "Asset", { isCash: true }),
  row("1160", "VAT recoverable on fees", "Asset"),
  row("1200", "Bank", "Asset", { isCash: true }),
  row("1210", "Undeposited cheques", "Asset", { isClearing: true }),
  row("1220", "Card gateway clearing", "Asset", { isClearing: true }),
  row("1230", "Salary deduction clearing", "Asset", { isClearing: true }),
  row("1240", "Standing order clearing", "Asset", { isClearing: true }),
  row("1250", "Direct debit clearing", "Asset", { isClearing: true }),
  row("1300", "Product inventory", "Asset"),
  row("1400", "Accounts receivable (Members)", "Asset", { isMemberTracked: true }),
  row("2020", "Payment on Account (Member credits)", "Liability", { isMemberTracked: true }),
  row("4000", "Subscription income – General All Grades", "Income", { isRevenue: true }),
  row("4010", "Subscription income – Short-term / Relief", "Income", { isRevenue: true }),
  row("4020", "Subscription income – Postgraduate Students", "Income", { isRevenue: true }),
  row("4040", "Subscription income – Private nursing home", "Income", { isRevenue: true }),
  row("4050", "Subscription income – Affiliate members", "Income", { isRevenue: true }),
  row("4060", "Subscription income – Lecturing", "Income", { isRevenue: true }),
  row("4070", "Subscription income – Associate", "Income", { isRevenue: true }),
  row("4080", "Subscription income – Retired Associate", "Income", { isRevenue: true }),
  row("4090", "Subscription income – Students", "Income", { isRevenue: true }),
  row("4500", "Events & Courses registration income", "Income", { isRevenue: true }),
  row("4510", "CPD registration income", "Income", { isRevenue: true }),
  row("4520", "Professional Events registration income", "Income", { isRevenue: true }),
  row(
    "4900",
    "Adjustments (adjSubType: prorata-fee-adjustment, manual-discount, category-upgrade-unused-credit, category-downgrade-unused-credit, category-change-prorata-credit, fee-decrease-adjustment, fee-increase-adjustment)",
    "ContraIncome",
    { isContraRevenue: true },
  ),
  row("5100", "Payment processing fees (e.g. Stripe, bank charges)", "Expense"),
  row("5200", "Bad debt / Write-offs", "Expense"),
]);
