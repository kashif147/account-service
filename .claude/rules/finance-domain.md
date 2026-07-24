# Double-entry accounting / GL

`journal.service.js`, `glJournalReplication.service.js`, `ledgerActions.service.js` implement
invoice/receipt/write-off/category-change/credit-note posting against `journal.model.js`,
`glTransaction.model.js`, `balance.model.js`, `materializedBalance.model.js`. `coa.model.js` is the
Chart of Accounts (see `account-service.coas.md` for the seeded code list — e.g. `4900` is the
generic adjustments/contra-income account used for pro-rata and category-change adjustments).
`journalAdjustment.service.js` + `journalAdjustment.model.js` handle manual finance-team GL
adjustments (draft → approved workflow, like credit notes). See the `membership-finance-processing`
skill for the full finance policy/workflow reference and `JOURNAL_ENTRIES_GUIDE.md` in this repo for
worked posting examples.

# SEPA Direct Debit

`directDebitRun.service.js` drives the run lifecycle (`directDebitRun.model.js`,
`directDebitRunItem.model.js`, `directDebitMandate.model.js`). `pain008.service.js` generates
PAIN.008 collection XML; `pain002.service.js` parses PAIN.002 reject/unpaid reports;
`sepaReferenceGenerator.js` + `sepaReferenceSequence.model.js` generate SEPA references. See the
`aib-sepa-pain-files` skill for the AIB-specific XML format and reconciliation rules.

# Reconciliation

`reconciliation.service.js` + `reconciliationRecord.model.js`, exposed via `finance.routes.js` (seed,
import bank statement, auto-match, manual match, suspense, settle, dashboard).

# Key models

- `payment.model.js`, `refund.model.js` — Stripe payment tracking
- `journal.model.js`, `glTransaction.model.js`, `balance.model.js`, `materializedBalance.model.js` —
  double-entry accounting / GL
- `journalAdjustment.model.js` — manual GL adjustments
- `creditNote.model.js` — credit notes (Draft → Approved/Cancelled)
- `coa.model.js` — Chart of Accounts
- `directDebitMandate.model.js`, `directDebitRun.model.js`, `directDebitRunItem.model.js`,
  `sepaReferenceSequence.model.js` — SEPA Direct Debit
- `reconciliationRecord.model.js` — bank reconciliation
- `batch.detail.model.js` — uploaded batch job tracking
- `template.model.js` — saved grid filter/column templates (see `request-pipeline.md`)
- `user.model.js` — CRM user sync (from `user.events`)
- `product.model.js`, `productType.model.js`, `pricing.model.js` — synced from product-service via
  events
- `reportSnapshot.model.js` — pre-computed report snapshots
