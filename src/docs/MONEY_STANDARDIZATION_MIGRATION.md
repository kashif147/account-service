# Money Standardization Migration Guide

## Overview

This guide documents the migration to store all money as **integer cents (minor units)** throughout the backend, with conversion to euros only for display/API responses.

## Current State (MIXTURE - INCONSISTENT)

### Storage Format

- **Payment**: CENTS (integers) ✅
- **Pricing**: CENTS (integers) ✅
- **GLTransaction**: EUROS (decimals) ❌
- **MaterializedBalance**: EUROS (decimals) ❌

### Conversion Points

1. `postJournalForPayment` (line 1312): Converts cents → euros ❌
2. `application.approval.listener.js` (line 470): Converts cents → euros ❌
3. Display functions: Some use `toFixed(2)` but don't convert from cents ❌

## Target State (CENTS EVERYWHERE)

### Storage Format

- **Payment**: CENTS (integers) ✅
- **Pricing**: CENTS (integers) ✅
- **GLTransaction**: CENTS (integers) ✅
- **MaterializedBalance**: CENTS (integers) ✅

### Conversion Rules

- **Storage**: Always store as integer cents
- **Processing**: Always work with integer cents
- **Display/API**: Convert to euros (divide by 100) only when returning to client

## Migration Steps

### Step 1: Remove Storage Conversions

#### 1.1 Fix `postJournalForPayment` in `payments.service.js`

**Current (line 1312):**

```javascript
// Convert amount from cents to currency units
const amount = payment.amount / 100;
```

**Change to:**

```javascript
// Amount is already in cents (minor units) - use directly
const amount = payment.amount; // Integer in cents
```

#### 1.2 Fix Invoice Creation in `application.approval.listener.js`

**Current (line 470):**

```javascript
// Note: annualFee from pricing is in cents, but invoice function expects base currency
// Convert from cents to base currency (divide by 100)
const annualFeeInBaseCurrency = annualFee / 100;

const invoiceReq = {
  body: {
    annualFee: annualFeeInBaseCurrency,
    // ...
  },
};
```

**Change to:**

```javascript
// annualFee is already in cents (minor units) - use directly
const invoiceReq = {
  body: {
    annualFee: annualFee, // Integer in cents
    // ...
  },
};
```

### Step 2: Update Endpoints to Accept Cents

#### 2.1 Update `invoice` endpoint in `journal.controller.js`

**Current:**

```javascript
export async function invoice(req, res, next) {
  const { annualFee, ... } = req.body;
  // annualFee is expected in euros (decimals)
  // ...
}
```

**Change to:**

```javascript
export async function invoice(req, res, next) {
  const { annualFee, ... } = req.body;

  // Validate annualFee is integer (cents)
  if (!Number.isInteger(annualFee) || annualFee <= 0) {
    throw AppError.badRequest("annualFee must be a positive integer (minor units)");
  }

  // annualFee is now in cents - use directly
  // ...
}
```

#### 2.2 Update `receipt` endpoint in `journal.controller.js`

**Current:**

```javascript
export async function receipt(req, res, next) {
  const { amount, ... } = req.body;
  // amount is expected in euros (decimals)
  // ...
}
```

**Change to:**

```javascript
export async function receipt(req, res, next) {
  const { amount, ... } = req.body;

  // Validate amount is integer (cents)
  if (!Number.isInteger(amount) || amount <= 0) {
    throw AppError.badRequest("amount must be a positive integer (minor units)");
  }

  // amount is now in cents - use directly
  // ...
}
```

#### 2.3 Update `creditNote` endpoint

**Current:**

```javascript
export async function creditNote(req, res, next) {
  const { amount, ... } = req.body;
  // amount is expected in euros
  // ...
}
```

**Change to:**

```javascript
export async function creditNote(req, res, next) {
  const { amount, ... } = req.body;

  // Validate amount is integer (cents)
  if (!Number.isInteger(amount) || amount <= 0) {
    throw AppError.badRequest("amount must be a positive integer (minor units)");
  }

  // amount is now in cents - use directly
  // ...
}
```

### Step 3: Update Helper Functions

#### 3.1 Update `stripeFeeBreakdown` in `helpers/fees.js`

**Current:**

```javascript
function r2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function stripeFeeBreakdown(
  gross,
  { pct = 0.014, fixed = 0.25, vat = 0.23 } = {}
) {
  const feeNoVat = r2(gross * pct + fixed);
  const feeVat = r2(feeNoVat * vat);
  const feeTotal = r2(feeNoVat + feeVat);
  return { feeNoVat, feeVat, feeTotal };
}
```

**Change to:**

```javascript
/**
 * Calculate Stripe fees from gross amount in cents
 * @param {number} grossCents - Gross amount in cents (integer)
 * @param {Object} options - Fee configuration
 * @returns {Object} Fees in cents (integers)
 */
export function stripeFeeBreakdown(
  grossCents,
  { pct = 0.014, fixed = 0.25, vat = 0.23 } = {}
) {
  // Convert fixed fee from euros to cents
  const fixedCents = Math.round(fixed * 100);

  // Calculate fees in cents (maintain precision during calculation)
  const feeNoVatCents = Math.round(grossCents * pct + fixedCents);
  const feeVatCents = Math.round(feeNoVatCents * vat);
  const feeTotalCents = feeNoVatCents + feeVatCents;

  return {
    feeNoVat: feeNoVatCents,
    feeVat: feeVatCents,
    feeTotal: feeTotalCents,
  };
}
```

#### 3.2 Update `prorata` functions in `helpers/prorata.js`

**Current (line 61-62):**

```javascript
const amount = (Number(annualFee) * numDays) / denomDays;
return Math.round((amount + Number.EPSILON) * 100) / 100; // round to 2dp
```

**Change to:**

```javascript
/**
 * Pro-rate an annual fee (in cents) over a period
 * @param {number} annualFeeCents - Annual fee in cents (integer)
 * @param {string} fromISO - Start date
 * @param {string} toISO - End date
 * @returns {number} Pro-rated amount in cents (integer)
 */
export function prorataForPeriod(annualFeeCents, fromISO, toISO) {
  const fromY = dayjs(fromISO).year();
  const toY = dayjs(toISO).year();
  if (fromY !== toY)
    throw AppError.badRequest(
      "Pro-rata period must be within one calendar year",
      { fromISO, toISO, fromYear: fromY, toYear: toY }
    );
  const numDays = diffDaysInclusive(fromISO, toISO);
  const denomDays = daysInYear(fromY);
  // Calculate in cents, maintain precision
  const amountCents = Math.round(
    (Number(annualFeeCents) * numDays) / denomDays
  );
  return amountCents; // Integer in cents
}

/**
 * Pro-rate from join date to year end
 * @param {number} annualFeeCents - Annual fee in cents (integer)
 * @param {string} joinISO - Join date
 * @returns {number} Pro-rated amount in cents (integer)
 */
export function prorataFromJoinToYearEnd(annualFeeCents, joinISO) {
  const { endISO, year } = yearBoundsFrom(joinISO);
  const numDays = diffDaysInclusive(joinISO, endISO);
  const denomDays = daysInYear(year);
  const amountCents = Math.round(
    (Number(annualFeeCents) * numDays) / denomDays
  );
  return amountCents; // Integer in cents
}
```

**Also update `sumArray` in `journal.controller.js` (line 19):**

```javascript
// Current:
return Number(arr.reduce((s, x) => s + sel(x), 0).toFixed(2));

// Change to:
// Amounts are in cents, sum them as integers
return arr.reduce((s, x) => s + sel(x), 0);
```

### Step 4: Add Display Conversions

#### 4.1 Create Helper Function for Display

Create `src/helpers/money.js`:

```javascript
/**
 * Convert cents to euros for display
 * @param {number} cents - Amount in cents (integer)
 * @returns {number} Amount in euros (decimal, 2 decimal places)
 */
export function centsToEuros(cents) {
  if (!Number.isInteger(cents)) {
    throw new Error("cents must be an integer");
  }
  return Number((cents / 100).toFixed(2));
}

/**
 * Convert euros to cents for storage
 * @param {number} euros - Amount in euros (decimal)
 * @returns {number} Amount in cents (integer)
 */
export function eurosToCents(euros) {
  return Math.round(euros * 100);
}
```

#### 4.2 Update Report Endpoints

**Update `memberNetBalance` in `reports.controller.js`:**

**Current (lines 283-290):**

```javascript
res.success({
  memberId,
  year: y,
  net: Number(net.toFixed(2)),
  accounts: Object.entries(byAccount).map(([accountCode, amount]) => ({
    accountCode,
    amount: Number(amount.toFixed(2)),
  })),
  // ...
});
```

**Change to:**

```javascript
import { centsToEuros } from "../helpers/money.js";

res.success({
  memberId,
  year: y,
  net: centsToEuros(net), // Convert from cents to euros for display
  accounts: Object.entries(byAccount).map(([accountCode, amount]) => ({
    accountCode,
    amount: centsToEuros(amount), // Convert from cents to euros
  })),
  buckets: Object.entries(byBucket).map(([key, amount]) => {
    const [accountCode, bucket] = key.split(":");
    return { accountCode, bucket, amount: centsToEuros(amount) };
  }),
});
```

**Update `membersBalancesAsOf` in `reports.controller.js`:**

**Current (lines 196-204):**

```javascript
if (r.accountCode === "1400")
  byMember[r.memberId].ar1400 = Number(r.amount.toFixed(2));
if (r.accountCode === "2020")
  byMember[r.memberId].poa2020 = Number(r.amount.toFixed(2));
// ...
net: Number((v.ar1400 - v.poa2020).toFixed(2)),
```

**Change to:**

```javascript
import { centsToEuros } from "../helpers/money.js";

if (r.accountCode === "1400")
  byMember[r.memberId].ar1400 = centsToEuros(r.amount);
if (r.accountCode === "2020")
  byMember[r.memberId].poa2020 = centsToEuros(r.amount);
// ...
net: centsToEuros(v.ar1400 - v.poa2020),
```

**Update `incomeStatement` in `reports.controller.js`:**

**Current (lines 142-146):**

```javascript
income: Number(sum(income).toFixed(2)),
contraIncome: Number(sum(contraIncome).toFixed(2)),
expenses: Number(sum(expenses).toFixed(2)),
netIncome: Number(
  (sum(income) - sum(contraIncome) - sum(expenses)).toFixed(2)
),
```

**Change to:**

```javascript
import { centsToEuros } from "../helpers/money.js";

income: centsToEuros(sum(income)),
contraIncome: centsToEuros(sum(contraIncome)),
expenses: centsToEuros(sum(expenses)),
netIncome: centsToEuros(sum(income) - sum(contraIncome) - sum(expenses)),
```

#### 4.3 Update API Response Transformers

Create middleware or transformer to convert amounts in API responses:

**Option 1: Manual conversion in each endpoint**

- Convert amounts to euros before sending response

**Option 2: Response transformer middleware**

- Intercept responses and convert amount fields automatically

**Recommended**: Manual conversion for clarity and control.

### Step 5: Data Migration Script

Create `scripts/migrate-money-to-cents.js`:

```javascript
import mongoose from "mongoose";
import GLTransaction from "../src/models/glTransaction.model.js";
import MaterializedBalance from "../src/models/materializedBalance.model.js";
import logger from "../src/config/logger.js";

/**
 * Migrates existing GLTransaction and MaterializedBalance amounts from euros to cents
 *
 * Strategy:
 * 1. Identify entries that are likely in euros (have decimal places, < 1000 for typical amounts)
 * 2. Multiply by 100 to convert to cents
 * 3. Update in batches
 *
 * WARNING: This is a destructive operation. Backup database first!
 */
async function migrateMoneyToCents() {
  const connectionString = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!connectionString) {
    throw new Error("MONGODB_URI or MONGO_URI environment variable required");
  }

  await mongoose.connect(connectionString);
  logger.info("Connected to MongoDB");

  // Step 1: Migrate GLTransaction entries
  logger.info("Starting GLTransaction migration...");
  const glTransactions = await GLTransaction.find({}).lean();
  let glUpdated = 0;
  let glSkipped = 0;

  for (const txn of glTransactions) {
    let needsUpdate = false;
    const updatedEntries = txn.entries.map((entry) => {
      // Check if amount looks like euros (has decimal places and is reasonable)
      // Typical amounts: 326.00, 81.50, etc.
      // If amount is > 10000, it's likely already in cents
      if (entry.amount < 10000 && entry.amount % 1 !== 0) {
        // Has decimal places and is < 10000 - likely euros
        needsUpdate = true;
        return {
          ...entry,
          amount: Math.round(entry.amount * 100), // Convert to cents
        };
      }
      // If amount is already an integer and > 100, assume it's already in cents
      if (Number.isInteger(entry.amount) && entry.amount >= 100) {
        return entry; // Already in cents
      }
      // Small integer amounts (< 100) might be euros - convert
      if (entry.amount < 100 && Number.isInteger(entry.amount)) {
        needsUpdate = true;
        return {
          ...entry,
          amount: Math.round(entry.amount * 100),
        };
      }
      return entry;
    });

    if (needsUpdate) {
      await GLTransaction.updateOne(
        { _id: txn._id },
        { $set: { entries: updatedEntries } }
      );
      glUpdated++;
    } else {
      glSkipped++;
    }
  }

  logger.info(
    { updated: glUpdated, skipped: glSkipped },
    "GLTransaction migration completed"
  );

  // Step 2: Migrate MaterializedBalance
  logger.info("Starting MaterializedBalance migration...");
  const balances = await MaterializedBalance.find({}).lean();
  let balUpdated = 0;
  let balSkipped = 0;

  for (const bal of balances) {
    // Check if amount looks like euros
    if (bal.amount < 10000 && bal.amount % 1 !== 0) {
      // Has decimal places - convert to cents
      await MaterializedBalance.updateOne(
        { _id: bal._id },
        { $set: { amount: Math.round(bal.amount * 100) } }
      );
      balUpdated++;
    } else if (bal.amount < 100 && Number.isInteger(bal.amount)) {
      // Small integer - might be euros
      await MaterializedBalance.updateOne(
        { _id: bal._id },
        { $set: { amount: Math.round(bal.amount * 100) } }
      );
      balUpdated++;
    } else {
      balSkipped++;
    }
  }

  logger.info(
    { updated: balUpdated, skipped: balSkipped },
    "MaterializedBalance migration completed"
  );

  await mongoose.disconnect();
  logger.info("Migration completed");
}

// Run migration
migrateMoneyToCents()
  .then(() => {
    logger.info("Migration script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    logger.error(
      { error: error.message, stack: error.stack },
      "Migration failed"
    );
    process.exit(1);
  });
```

### Step 6: Update Validation Rules

#### 6.1 Update Invoice Validation

**File**: `src/validators/journal.validator.js` (or create if doesn't exist)

```javascript
import { body } from "express-validator";

export const invoiceRules = [
  body("annualFee")
    .isInt({ min: 1 })
    .withMessage(
      "annualFee must be a positive integer (minor units, e.g., 32600 for €326.00)"
    ),
  // ... other rules
];
```

#### 6.2 Update Receipt Validation

```javascript
export const receiptRules = [
  body("amount")
    .isInt({ min: 1 })
    .withMessage(
      "amount must be a positive integer (minor units, e.g., 32600 for €326.00)"
    ),
  // ... other rules
];
```

### Step 7: Update Documentation

#### 7.1 Update API Documentation

Update Swagger/OpenAPI docs to specify amounts are in minor units (cents).

#### 7.2 Update Batch Payment Implementation Guide

Already updated in `BATCH_PAYMENT_IMPLEMENTATION.md` ✅

## Implementation Checklist

### Code Changes

- [ ] Remove conversion in `postJournalForPayment` (payments.service.js line 1312)
- [ ] Remove conversion in `application.approval.listener.js` (line 470)
- [ ] Update `invoice` endpoint to accept/validate cents
- [ ] Update `receipt` endpoint to accept/validate cents
- [ ] Update `creditNote` endpoint to accept/validate cents
- [ ] Update `changeCategory` endpoint to work with cents
- [ ] Update `claimApplicationCredit` to work with cents
- [ ] Update `stripeFeeBreakdown` to work with cents
- [ ] Update `prorata` functions to work with cents
- [ ] Update `sumArray` to work with integer cents
- [ ] Create `money.js` helper with `centsToEuros` and `eurosToCents`
- [ ] Update all report endpoints to convert cents to euros for display
- [ ] Update validation rules to require integers

### Data Migration

- [ ] Create migration script
- [ ] Test migration script on staging
- [ ] Backup production database
- [ ] Run migration on staging
- [ ] Verify data integrity
- [ ] Run migration on production

### Testing

- [ ] Test invoice creation with cents
- [ ] Test receipt creation with cents
- [ ] Test payment processing (Stripe webhooks)
- [ ] Test application approval flow
- [ ] Test batch payment processing
- [ ] Test report endpoints (verify euros display)
- [ ] Test member balance calculations
- [ ] Test pro-rata calculations

## Breaking Changes

### API Changes

**Before:**

```json
POST /api/journal/invoice
{
  "annualFee": 326.00
}
```

**After:**

```json
POST /api/journal/invoice
{
  "annualFee": 32600
}
```

**Response (unchanged - still in euros for display):**

```json
{
  "annualFee": 326.0
}
```

### Frontend Updates Required

1. Update all API calls to send amounts in cents (multiply by 100)
2. Update all API response handling to convert cents to euros (divide by 100)
3. Update form validations to accept integers only
4. Update display formatting to show euros (divide by 100, format to 2 decimals)

## Rollback Plan

If issues occur:

1. **Code Rollback**: Revert code changes (git revert)
2. **Data Rollback**: Run reverse migration (divide by 100)
3. **Database Restore**: Restore from backup if needed

## Verification

After migration, verify:

1. ✅ All amounts stored as integers in database
2. ✅ No decimal amounts in GLTransaction entries
3. ✅ No decimal amounts in MaterializedBalance
4. ✅ API responses show euros (decimals) for display
5. ✅ Calculations work correctly with integer cents
6. ✅ Reports show correct amounts in euros

## Notes

- **Pricing table**: Already stores in cents ✅
- **Payment model**: Already stores in cents ✅
- **GLTransaction**: Needs migration from euros to cents
- **MaterializedBalance**: Needs migration from euros to cents
- **All endpoints**: Need to accept cents instead of euros
- **All displays**: Need to convert cents to euros

## Timeline

1. **Phase 1**: Code changes (remove conversions, update endpoints)
2. **Phase 2**: Testing on staging
3. **Phase 3**: Data migration on staging
4. **Phase 4**: Verify staging
5. **Phase 5**: Deploy to production
6. **Phase 6**: Data migration on production
7. **Phase 7**: Monitor and verify
