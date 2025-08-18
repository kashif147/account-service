export default [
  // ----------------- Assets -----------------
  { code: "1100", description: "Cash", type: "Asset", isCash: true },
  { code: "1200", description: "Bank", type: "Asset", isCash: true },
  { code: "1210", description: "Undeposited cheques", type: "Asset", isClearing: true },
  { code: "1220", description: "Card gateway clearing", type: "Asset", isClearing: true },
  { code: "1230", description: "Salary deduction clearing", type: "Asset", isClearing: true },
  { code: "1240", description: "Standing order clearing", type: "Asset", isClearing: true },
  { code: "1250", description: "Direct debit clearing", type: "Asset", isClearing: true },
  { code: "1160", description: "VAT recoverable on fees", type: "Asset" },
  { code: "1300", description: "Product inventory", type: "Asset" },
  { code: "1400", description: "Accounts receivable (Members)", type: "Asset", isMemberTracked: true },

  // ----------------- Liabilities -----------------
  { code: "2020", description: "Payment on Account (Member credits)", type: "Liability", isMemberTracked: true },

  // ----------------- Income -----------------
  { code: "4000", description: "Subscription income – General All Grades", type: "Income", isRevenue: true },
  { code: "4010", description: "Subscription income – Short-term / Relief", type: "Income", isRevenue: true },
  { code: "4040", description: "Subscription income – Private nursing home", type: "Income", isRevenue: true },
  { code: "4050", description: "Subscription income – Affiliate members", type: "Income", isRevenue: true },
  { code: "4060", description: "Subscription income – Lecturing", type: "Income", isRevenue: true },
  { code: "4070", description: "Subscription income – Associate", type: "Income", isRevenue: true },
  { code: "4080", description: "Subscription income – Retired Associate", type: "Income", isRevenue: true },
  { code: "4090", description: "Subscription income – Students", type: "Income", isRevenue: true },

  // ----------------- Contra Income -----------------
  {
    code: "4900",
    description: "Credit Notes / Discounts (adjSubType: discount, prorata, fee-decrease, fee-increase-credit)",
    type: "ContraIncome",
    isContraRevenue: true
  },

  // ----------------- Expenses -----------------
  { code: "5100", description: "Payment processing fees (e.g. Stripe, bank charges)", type: "Expense" },

  // ----------------- Write-offs -----------------
  { code: "5200", description: "Bad debt / Write-offs", type: "Expense" }
];
