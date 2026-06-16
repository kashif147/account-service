# Journal Entries Guide - Accounting Service

## Overview

The accounting service uses a double-entry bookkeeping system with a Chart of Accounts (CoA). All journal entries must be balanced (total debits = total credits).

## Chart of Accounts Structure

Key account codes used in the system:

### Asset Accounts

- **1100**: Cash - Physical cash on hand
- **1160**: VAT recoverable on fees - VAT on expenses that can be reclaimed
- **1200**: Bank - Only accessible via Settlement documents
- **1210**: Undeposited cheques - Temporary account for cheques received but not yet deposited to bank
- **1220**: Card gateway clearing - Temporary account for card payments (Stripe, etc.) before settlement
- **1230**: Salary deduction clearing - Temporary account for payroll/salary deduction payments before settlement
- **1240**: Standing order clearing - Temporary account for standing order payments before settlement
- **1250**: Direct debit clearing - Temporary account for direct debit payments before settlement
- **1300**: Product inventory - Inventory of products for sale
- **1400**: Accounts receivable (Members) - Member-tracked, requires `memberId` and `periodBucket`

### Liability Accounts

- **2020**: Payment on Account (Member credits) - Member-tracked, requires `memberId` and `periodBucket`. Holds unallocated payments until invoiced.

### Income Accounts

- **4000**: Subscription income – General All Grades
- **4010**: Subscription income – Short-term / Relief
- **4040**: Subscription income – Private nursing home
- **4050**: Subscription income – Affiliate members
- **4060**: Subscription income – Lecturing
- **4070**: Subscription income – Associate
- **4080**: Subscription income – Retired Associate
- **4090**: Subscription income – Students
- **4900**: Credit Notes / Discounts (adjSubType: discount, prorata, fee-decrease, fee-increase-credit) - Adjustments, prorata credits, discounts, and other income reductions

### Expense Accounts

- **5100**: Payment processing fees (e.g. Stripe, bank charges) - Payment processing fees
- **5200**: Bad debt / Write-offs - Write-offs for uncollectible receivables

### Clearing Accounts (1210-1250)

Clearing accounts are temporary holding accounts used to record payments before they are settled to the main bank account (1200). They allow for:

- Tracking different payment methods separately
- Reconciliation of payment processing fees
- Settlement processing in batches

**Usage Guidelines:**

- **1210 (Undeposited Cheques)**: Use for cheques received but not yet deposited to the bank account
- **1220 (Card Gateway Clearing)**: Use for all card payments via payment gateways (Stripe, PayPal, etc.) before settlement
- **1230 (Salary Deduction Clearing)**: Use for payroll deductions and salary-based payments before settlement
- **1240 (Standing Order Clearing)**: Use for standing order payments (recurring bank transfers) before settlement
- **1250 (Direct Debit Clearing)**: Use for direct debit payments (authorized recurring bank withdrawals) before settlement

## Core Journal Entry Function

All journal entries go through `postBalancedJournal()` which:

1. Validates account codes exist in CoA
2. Ensures debits = credits
3. Enforces business rules (e.g., 1200 only via Settlement)
4. Requires `memberId` and `periodBucket` for member-tracked accounts (1400, 2020)
5. Handles idempotency via `docNo`

## API Endpoints

### 1. POST `/journal/invoice` - Create Invoice

Creates an invoice when an application is approved or membership is invoiced / renewed.

**Request Body:**

```json
{
  "date": "2024-01-15",
  "docNo": "INV-2024-001",
  "memberId": "M12345",
  "annualFee": 500.0,
  "incomeCode": "4000",
  "categoryName": "General All Grades",
  "periodBucket": "current",
  "joinDate": "2024-06-01" // Optional: for mid-year joins (triggers pro-rata credit)
}
```

**Journal Entry Created:**

- **Debit**: 1400 (Accounts receivable - Members) - `annualFee` amount, with `memberId` and `periodBucket`
- **Credit**: `incomeCode` (e.g., 4000 for General All Grades) - `annualFee` amount

**If `joinDate` provided:**

- Additional Credit Note created for pro-rata adjustment
- **Debit**: 4900 (Credit Notes / Discounts) - reduction amount
- **Credit**: 1400 (Accounts receivable - Members) - reduction amount

**Example Usage:**

```javascript
// When application is approved
POST /journal/invoice
{
  "date": "2024-01-15",
  "docNo": "INV-2024-001",
  "memberId": "M12345",
  "annualFee": 500.00,
  "incomeCode": "4000",
  "categoryName": "General All Grades",
  "periodBucket": "current",
  "joinDate": "2024-06-01"  // If member joined mid-year
}
```

### 2. POST `/journal/receipt` - Record Payment Received

Records payment received against an application ID or membership number.

**Request Body:**

```json
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-001",
  "memberId": "M12345", // OR applicationId (one required)
  "applicationId": "APP-123", // OR memberId (one required)
  "amount": 500.0,
  "clearingCode": "1220", // One of: 1210 (Undeposited Cheques), 1220 (Card Gateway), 1230 (Salary Deduction), 1240 (Standing Order), 1250 (Direct Debit)
  "bucket": "current",
  "provider": "stripe" // Optional: if Stripe payment (adds fee entries)
}
```

**Journal Entry Created:**

- **Debit**: `clearingCode` (e.g., 1220 for card gateway clearing) - `amount`
- **Credit**: 2020 (Payment on Account - Member credits) - `amount`, with `memberId`/`applicationId` and `bucket`

**If `provider === "stripe"`:**

- Additional entries for Stripe fees:
  - **Debit**: 5100 (Payment processing fees) - fee amount (no VAT)
  - **Debit**: 1160 (VAT recoverable on fees) - VAT on fee
  - **Credit**: `clearingCode` - total fee amount

**Example Usage:**

```javascript
// Payment received for application (Card Gateway - Stripe)
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-001",
  "applicationId": "APP-123",
  "amount": 500.00,
  "clearingCode": "1220",
  "bucket": "current",
  "provider": "stripe"
}

// Payment received for existing member (Undeposited Cheque)
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-002",
  "memberId": "M12345",
  "amount": 500.00,
  "clearingCode": "1210",
  "bucket": "current"
}
```

### 3. POST `/journal/claim-credit` - Transfer Application Credit to Member

Transfers payment on account from application ID to member ID when application is approved.

**Request Body:**

```json
{
  "date": "2024-01-21",
  "docNo": "CLAIM-2024-001",
  "applicationId": "APP-123",
  "memberId": "M12345",
  "bucket": "current"
}
```

**Journal Entry Created:**

- **Debit**: 2020 (Payment on Account - Member credits) - amount, with `applicationId` and `bucket`
- **Credit**: 2020 (Payment on Account - Member credits) - amount, with `memberId` and `bucket`

**Example Usage:**

```javascript
// After application approved and memberId assigned
POST /journal/claim-credit
{
  "date": "2024-01-21",
  "docNo": "CLAIM-2024-001",
  "applicationId": "APP-123",
  "memberId": "M12345",
  "bucket": "current"
}
```

## Workflow Examples

### Scenario 1: Application Approved → Invoice Membership

**Step 1: Create Invoice when application is approved**

```javascript
POST /journal/invoice
{
  "date": "2024-01-15",
  "docNo": "INV-2024-001",
  "memberId": "M12345",
  "annualFee": 500.00,
  "incomeCode": "4000",
  "categoryName": "General All Grades",
  "periodBucket": "current"
}
```

This creates:

- **Debit** 1400 (Accounts receivable - Members): €500.00 (member M12345, current period)
- **Credit** 4000 (Subscription income – General All Grades): €500.00

### Scenario 2: Payment Received → Record Receipt

**Step 1: Record payment received (by applicationId)**

```javascript
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-001",
  "applicationId": "APP-123",
  "amount": 500.00,
  "clearingCode": "1220",
  "bucket": "current",
  "provider": "stripe"
}
```

This creates:

- **Debit** 1220 (Card gateway clearing): €500.00
- **Credit** 2020 (Payment on Account - Member credits): €500.00 (app:APP-123, current period)
- **Debit** 5100 (Payment processing fees): €X.XX (if Stripe)
- **Debit** 1160 (VAT recoverable on fees): €X.XX (if Stripe)
- **Credit** 1220 (Card gateway clearing): €X.XX (fee total, if Stripe)

**Step 2: When application approved, claim credit to member**

```javascript
POST /journal/claim-credit
{
  "date": "2024-01-21",
  "docNo": "CLAIM-2024-001",
  "applicationId": "APP-123",
  "memberId": "M12345",
  "bucket": "current"
}
```

This transfers the credit from application to member:

- **Debit** 2020 (Payment on Account - Member credits): €500.00 (app:APP-123)
- **Credit** 2020 (Payment on Account - Member credits): €500.00 (M12345)

### Scenario 3: Payment Received for Existing Member

```javascript
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-002",
  "memberId": "M12345",
  "amount": 500.00,
  "clearingCode": "1210",
  "bucket": "current"
}
```

This creates:

- **Debit** 1210 (Undeposited cheques): €500.00
- **Credit** 2020 (Payment on Account - Member credits): €500.00 (M12345, current period)

## Integration Points

### 1. Payment Service Integration

The payment service (`/payment/reconcile`) automatically calls `postJournalForPayment()` when a payment succeeds. However, this function currently returns a stub. You should integrate it with the receipt endpoint:

```javascript
// In payments.service.js, update postJournalForPayment:
export async function postJournalForPayment(payment, ctx) {
  const { receipt } = await import("../controllers/journal.controller.js");

  // Determine clearing code based on payment method
  // 1220 = Card Gateway Clearing (for Stripe/card payments)
  // 1210 = Undeposited Cheques (for cheques)
  // 1230 = Salary Deduction Clearing
  // 1240 = Standing Order Clearing
  // 1250 = Direct Debit Clearing
  const clearingCode = payment.mode === "stripe" ? "1220" : "1210";

  // Call receipt endpoint logic
  await receipt(
    {
      body: {
        date: new Date().toISOString().split("T")[0],
        docNo: `RCP-${payment._id}`,
        memberId: payment.memberId,
        applicationId: payment.applicationId,
        amount: payment.amount / 100, // Convert cents to currency
        clearingCode,
        bucket: "current",
        provider: payment.mode === "stripe" ? "stripe" : undefined,
      },
    },
    { status: () => {}, created: () => {} },
    () => {}
  );
}
```

### 2. Application Approval Integration

When an application is approved, the system should automatically create an invoice. An example listener is provided in `src/handlers/application.approval.listener.js`.

**To enable automatic invoice creation:**

1. **Set up RabbitMQ consumer** in `src/rabbitMQ/index.js`:

```javascript
import {
  handleApplicationApproved,
  handleMemberCreated,
} from "../handlers/application.approval.listener.js";

export async function setupConsumers() {
  // ... existing code ...

  // Application events queue
  const APPLICATION_QUEUE = "account.application.events";
  await consumer.createQueue(APPLICATION_QUEUE, { durable: true });
  await consumer.bindQueue(APPLICATION_QUEUE, "application.events", [
    "applications.review.processed.v1",
  ]);

  consumer.registerHandler(
    "applications.review.processed.v1",
    async (payload, context) => {
      await handleApplicationApproved(payload);
    }
  );

  await consumer.consume(APPLICATION_QUEUE, { prefetch: 10 });

  // Membership events queue for member created
  const MEMBERSHIP_QUEUE = "account.membership.events";
  await consumer.createQueue(MEMBERSHIP_QUEUE, { durable: true });
  await consumer.bindQueue(MEMBERSHIP_QUEUE, "membership.events", [
    "members.member.created.requested.v1",
  ]);

  consumer.registerHandler(
    "members.member.created.requested.v1",
    async (payload, context) => {
      await handleMemberCreated(payload);
    }
  );

  await consumer.consume(MEMBERSHIP_QUEUE, { prefetch: 10 });
}
```

2. **Manual Invoice Creation** (if not using events):

```javascript
POST /journal/invoice
{
  "date": approvalDate,
  "docNo": `INV-${year}-${memberId}`,
  "memberId": memberId,
  "annualFee": subscriptionFee,
  "incomeCode": determineIncomeCode(category),
  "categoryName": categoryName,
  "periodBucket": "current",
  "joinDate": dateJoined  // If mid-year join
}
```

3. **Claim Application Credit** (if payment was received before approval):

```javascript
POST /journal/claim-credit
{
  "date": approvalDate,
  "docNo": `CLAIM-${applicationId}`,
  "applicationId": applicationId,
  "memberId": memberId,
  "bucket": "current"
}
```

## Important Notes

1. **Idempotency**: All POST endpoints use `docNo` for idempotency. Same `docNo` = same journal entry (returns existing).

2. **Member-Tracked Accounts**: Accounts 1400 (Accounts receivable - Members) and 2020 (Payment on Account - Member credits) require:

   - `memberId` or `applicationId` (for 2020, can use `app:${applicationId}` format)
   - `periodBucket`: "arrears", "current", or "advance"

3. **Clearing Accounts**: Use 1210-1250 for different payment methods/channels:

   - **1210**: Undeposited Cheques
   - **1220**: Card Gateway Clearing
   - **1230**: Salary Deduction Clearing
   - **1240**: Standing Order Clearing
   - **1250**: Direct Debit Clearing

   See "Clearing Accounts (1210-1250)" section above for detailed descriptions.

4. **Balanced Entries**: All entries must balance. The system validates this automatically.

5. **Account Validation**: All account codes must exist in the Chart of Accounts (CoA) collection.

6. **Date Format**: All dates must be ISO 8601 format (YYYY-MM-DD).

## Additional Endpoints

- **POST `/journal/credit-note`**: Create credit notes for discounts/adjustments
- **POST `/journal/writeoff`**: Write off bad debts
- **POST `/journal/change-category`**: Change membership category mid-year
- **GET `/journal/`**: List journal entries with filters

## Complete Transaction Examples

### Example 1: Invoice Creation (Full Year)

**Scenario**: Member M12345 approved for "General All Grades" membership with annual fee of €500.00

**Request:**

```json
POST /journal/invoice
{
  "date": "2024-01-15",
  "docNo": "INV-2024-001",
  "memberId": "M12345",
  "annualFee": 500.00,
  "incomeCode": "4000",
  "categoryName": "General All Grades",
  "periodBucket": "current"
}
```

**Journal Entry Created:**

```
Document: INV-2024-001
Type: Invoice
Date: 2024-01-15
Memo: Subscription 2024 – General All Grades

Debit  1400 (Accounts receivable - Members)  €500.00  [M12345, current]
Credit 4000 (Subscription income – General All Grades)  €500.00
```

**Result**: Member owes €500.00 in Accounts Receivable, and €500.00 income is recognized.

---

### Example 2: Invoice with Pro-Rata (Mid-Year Join)

**Scenario**: Member M12345 joins on June 1st, 2024. Annual fee is €500.00, but only 214 days remain in the year.

**Request:**

```json
POST /journal/invoice
{
  "date": "2024-06-01",
  "docNo": "INV-2024-002",
  "memberId": "M12345",
  "annualFee": 500.00,
  "incomeCode": "4000",
  "categoryName": "General All Grades",
  "periodBucket": "current",
  "joinDate": "2024-06-01"
}
```

**Journal Entries Created:**

**Entry 1 - Full Invoice:**

```
Document: INV-2024-002
Type: Invoice
Date: 2024-06-01

Debit  1400 (Accounts receivable - Members)  €500.00  [M12345, current]
Credit 4000 (Subscription income – General All Grades)  €500.00
```

**Entry 2 - Pro-Rata Credit Note:**

```
Document: INV-2024-002-PRORATA
Type: CreditNote
Date: 2024-06-01
Memo: Credit note – Pro-rata (General All Grades) 2024-06-01 → 2024-12-31

Debit  4900 (Credit Notes / Discounts)  €293.15  [prorata]
Credit 1400 (Accounts receivable - Members)  €293.15  [M12345, current]
```

**Result**: Member owes €206.85 (€500.00 - €293.15) after pro-rata adjustment.

---

### Example 3: Receipt - Card Gateway Payment (1220)

**Scenario**: Payment of €500.00 received via Stripe (card gateway) for application APP-123

**Request:**

```json
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-001",
  "applicationId": "APP-123",
  "amount": 500.00,
  "clearingCode": "1220",
  "bucket": "current",
  "provider": "stripe"
}
```

**Journal Entry Created:**

```
Document: RCP-2024-001
Type: Receipt
Date: 2024-01-20
Memo: Receipt (app APP-123)

Debit  1220 (Card gateway clearing)  €500.00
Debit  5100 (Payment processing fees)  €17.50   [Stripe fee without VAT]
Debit  1160 (VAT recoverable on fees) €3.68    [VAT on Stripe fee]
Credit 2020 (Payment on Account - Member credits)  €500.00  [app:APP-123, current]
Credit 1220 (Card gateway clearing)  €21.18   [Total fees: €17.50 + €3.68]
```

**Result**:

- €500.00 credited to Payment on Account for application
- €21.18 in Stripe fees recorded (€17.50 expense + €3.68 VAT recoverable)
- Net clearing account balance: €478.82 (€500.00 - €21.18)

---

### Example 4: Receipt - Undeposited Cheque (1210)

**Scenario**: Cheque payment of €500.00 received for member M12345 (not yet deposited)

**Request:**

```json
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-002",
  "memberId": "M12345",
  "amount": 500.00,
  "clearingCode": "1210",
  "bucket": "current"
}
```

**Journal Entry Created:**

```
Document: RCP-2024-002
Type: Receipt
Date: 2024-01-20
Memo: Receipt

Debit  1210 (Undeposited cheques)  €500.00
Credit 2020 (Payment on Account - Member credits)  €500.00  [M12345, current]
```

**Result**: €500.00 credited to Payment on Account for member M12345. Cheque will be moved to Bank (1200) when deposited via Settlement.

---

### Example 5: Receipt - Salary Deduction (1230)

**Scenario**: Payment of €300.00 received via salary deduction for member M12345

**Request:**

```json
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-003",
  "memberId": "M12345",
  "amount": 300.00,
  "clearingCode": "1230",
  "bucket": "current"
}
```

**Journal Entry Created:**

```
Document: RCP-2024-003
Type: Receipt
Date: 2024-01-20
Memo: Receipt

Debit  1230 (Salary deduction clearing)  €300.00
Credit 2020 (Payment on Account - Member credits)  €300.00  [M12345, current]
```

**Result**: €300.00 credited to Payment on Account for member M12345. Payment will be moved to Bank (1200) when salary deduction is processed.

---

### Example 6: Receipt - Standing Order (1240)

**Scenario**: Payment of €250.00 received via standing order for member M12345

**Request:**

```json
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-004",
  "memberId": "M12345",
  "amount": 250.00,
  "clearingCode": "1240",
  "bucket": "current"
}
```

**Journal Entry Created:**

```
Document: RCP-2024-004
Type: Receipt
Date: 2024-01-20
Memo: Receipt

Debit  1240 (Standing order clearing)  €250.00
Credit 2020 (Payment on Account - Member credits)  €250.00  [M12345, current]
```

**Result**: €250.00 credited to Payment on Account for member M12345. Payment will be moved to Bank (1200) when standing order is processed.

---

### Example 6b: Receipt - Direct Debit (1250)

**Scenario**: Payment of €200.00 received via direct debit for member M12345

**Request:**

```json
POST /journal/receipt
{
  "date": "2024-01-20",
  "docNo": "RCP-2024-005",
  "memberId": "M12345",
  "amount": 200.00,
  "clearingCode": "1250",
  "bucket": "current"
}
```

**Journal Entry Created:**

```
Document: RCP-2024-005
Type: Receipt
Date: 2024-01-20
Memo: Receipt

Debit  1250 (Direct debit clearing)  €200.00
Credit 2020 (Payment on Account - Member credits)  €200.00  [M12345, current]
```

**Result**: €200.00 credited to Payment on Account for member M12345. Payment will be moved to Bank (1200) when direct debit is processed.

---

### Example 7: Claim Application Credit

**Scenario**: Application APP-123 was approved and assigned memberId M12345. Need to transfer €500.00 credit from application to member.

**Request:**

```json
POST /journal/claim-credit
{
  "date": "2024-01-21",
  "docNo": "CLAIM-2024-001",
  "applicationId": "APP-123",
  "memberId": "M12345",
  "bucket": "current"
}
```

**Journal Entry Created:**

```
Document: CLAIM-2024-001
Type: Claim
Date: 2024-01-21
Memo: Claim app credit APP-123 → M12345

Debit  2020 (Payment on Account - Member credits)  €500.00  [app:APP-123, current]
Credit 2020 (Payment on Account - Member credits)  €500.00  [M12345, current]
```

**Result**: Credit transferred from application to member. Application POA balance: €0.00, Member POA balance: €500.00.

---

### Example 8: Credit Note - Discount

**Scenario**: Member M12345 receives a €50.00 discount on their membership fee

**Request:**

```json
POST /journal/credit-note
{
  "date": "2024-01-22",
  "docNo": "CN-2024-001",
  "memberId": "M12345",
  "amount": 50.00,
  "periodBucket": "current",
  "adjSubType": "discount",
  "categoryName": "General All Grades"
}
```

**Journal Entry Created:**

```
Document: CN-2024-001
Type: CreditNote
Date: 2024-01-22
Memo: Credit note – discount

Debit  4900 (Credit Notes / Discounts)  €50.00  [discount, General All Grades]
Credit 1400 (Accounts receivable - Members)  €50.00  [M12345, current]
```

**Result**: Member's AR balance reduced by €50.00, and income reduced by €50.00.

---

### Example 9: Credit Note - Prorata Adjustment

**Scenario**: Member M12345 receives a prorata credit of €100.00 for unused portion of membership

**Request:**

```json
POST /journal/credit-note
{
  "date": "2024-01-22",
  "docNo": "CN-2024-002",
  "memberId": "M12345",
  "amount": 100.00,
  "periodBucket": "current",
  "adjSubType": "prorata",
  "categoryName": "General All Grades"
}
```

**Journal Entry Created:**

```
Document: CN-2024-002
Type: CreditNote
Date: 2024-01-22
Memo: Credit note – prorata

Debit  4900 (Credit Notes / Discounts)  €100.00  [prorata, General All Grades]
Credit 1400 (Accounts receivable - Members)  €100.00  [M12345, current]
```

**Result**: Member's AR balance reduced by €100.00 due to prorata adjustment.

---

### Example 10: Write-Off (Bad Debt)

**Scenario**: Member M12345's outstanding balance of €200.00 is written off as bad debt

**Request:**

```json
POST /journal/writeoff
{
  "date": "2024-01-25",
  "docNo": "WO-2024-001",
  "memberId": "M12345",
  "amount": 200.00,
  "periodBucket": "current"
}
```

**Journal Entry Created:**

```
Document: WO-2024-001
Type: WriteOff
Date: 2024-01-25
Memo: Bad debt write-off

Debit  5200 (Bad debt / Write-offs)  €200.00  [writeoff]
Credit 1400 (Accounts receivable - Members)  €200.00  [M12345, current]
```

**Result**: Member's AR balance reduced by €200.00, and bad debt expense recognized.

---

### Example 11: Change Category (Mid-Year Upgrade)

**Scenario**: Member M12345 upgrades from "Associate" (€300/year) to "General All Grades" (€500/year) on July 1st, 2024.

**Request:**

```json
POST /journal/change-category
{
  "date": "2024-07-01",
  "docNoBase": "CHG-2024-001",
  "memberId": "M12345",
  "oldIncomeCode": "4070",
  "oldCategoryName": "Associate",
  "oldAnnualFee": 300.00,
  "newIncomeCode": "4000",
  "newCategoryName": "General All Grades",
  "newAnnualFee": 500.00,
  "changeDate": "2024-07-01",
  "periodBucket": "current"
}
```

**Journal Entries Created:**

**Entry 1 - New Category Invoice:**

```
Document: CHG-2024-001-INVNEW
Type: Invoice
Date: 2024-07-01
Memo: Subscription 2024 – General All Grades

Debit  1400 (Accounts receivable - Members)  €500.00  [M12345, current]
Credit 4000 (Subscription income – General All Grades)  €500.00
```

**Entry 2 - Credit Unused Old Category (July 1 - Dec 31):**

```
Document: CHG-2024-001-COLD
Type: CreditNote
Date: 2024-07-01
Memo: Credit note – Unused period (Associate) 2024-07-01 → 2024-12-31

Debit  4900 (Credit Notes / Discounts)  €153.70  [fee-increase-credit, Associate]
Credit 1400 (Accounts receivable - Members)  €153.70  [M12345, current]
```

**Entry 3 - Credit Pre-Change New Category (Jan 1 - June 30):**

```
Document: CHG-2024-001-CNEW
Type: CreditNote
Date: 2024-07-01
Memo: Credit note – Pre-change portion (General All Grades) 2024-01-01 → 2024-06-30

Debit  4900 (Credit Notes / Discounts)  €246.58  [prorata, General All Grades]
Credit 1400 (Accounts receivable - Members)  €246.58  [M12345, current]
```

**Result**:

- New full-year invoice: €500.00
- Credit for unused Associate period: €153.70
- Credit for pre-change General All Grades period: €246.58
- Net AR increase: €99.72 (€500.00 - €153.70 - €246.58)

---

### Example 12: Complete Workflow - Application to Payment

**Scenario**: Complete flow from application payment to approval and invoicing

**Step 1: Payment Received (Before Approval)**

```json
POST /journal/receipt
{
  "date": "2024-01-15",
  "docNo": "RCP-2024-010",
  "applicationId": "APP-456",
  "amount": 500.00,
  "clearingCode": "1220",
  "bucket": "current",
  "provider": "stripe"
}
```

**Step 2: Application Approved - Create Invoice**

```json
POST /journal/invoice
{
  "date": "2024-01-20",
  "docNo": "INV-2024-010",
  "memberId": "M67890",
  "annualFee": 500.00,
  "incomeCode": "4000",
  "categoryName": "General All Grades",
  "periodBucket": "current"
}
```

**Step 3: Claim Application Credit**

```json
POST /journal/claim-credit
{
  "date": "2024-01-20",
  "docNo": "CLAIM-2024-010",
  "applicationId": "APP-456",
  "memberId": "M67890",
  "bucket": "current"
}
```

**Final State:**

- Member M67890 has:
  - Accounts receivable - Members (1400): €500.00 (from invoice)
  - Payment on Account - Member credits (2020): €500.00 (from claimed credit)
  - Net balance: €0.00 (fully paid)

---

## Testing

Test journal entries using the Postman collection or direct API calls. Ensure:

1. Account codes exist in CoA
2. Debits equal credits
3. Member-tracked accounts have required fields
4. `docNo` is unique (or reuse for idempotency)
