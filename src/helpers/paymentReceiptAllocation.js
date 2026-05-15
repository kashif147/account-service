import MaterializedBalance from "../models/materializedBalance.model.js";

/**
 * Split a member cash receipt (cents) across 1400 buckets then 2020 advance.
 * Uses materialized 1400 debit balances per bucket (amount > 0 = member owes).
 * When nothing is owed on 1400 arrears+current, the full payment credits 2020 advance.
 *
 * @param {number} amountCents
 * @param {number} owedArrearsCents
 * @param {number} owedCurrentCents
 */
export function allocateMemberReceiptAmounts(
  amountCents,
  owedArrearsCents,
  owedCurrentCents,
) {
  const pay = Math.max(0, Math.floor(Number(amountCents) || 0));
  const a = Math.max(0, Math.floor(Number(owedArrearsCents) || 0));
  const c = Math.max(0, Math.floor(Number(owedCurrentCents) || 0));
  const totalOwed = a + c;
  if (totalOwed <= 0) {
    return { toArrears1400: 0, toCurrent1400: 0, toAdvance2020: pay };
  }
  let rem = pay;
  const toArrears1400 = Math.min(rem, a);
  rem -= toArrears1400;
  const toCurrent1400 = Math.min(rem, c);
  rem -= toCurrent1400;
  return { toArrears1400, toCurrent1400, toAdvance2020: rem };
}

/**
 * @param {string} memberId
 * @param {number} year
 * @returns {Promise<{ arrears: number, current: number }>}
 */
export async function memberOwed1400ByBucket(memberId, year) {
  const mid = String(memberId || "").trim();
  if (!mid || !Number.isFinite(year))
    return { arrears: 0, current: 0 };

  const rows = await MaterializedBalance.find({
    memberId: mid,
    accountCode: "1400",
    year,
    bucket: { $in: ["arrears", "current"] },
  }).lean();

  let arrears = 0;
  let current = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    const owed = amt > 0 ? amt : 0;
    if (r.bucket === "arrears") arrears += owed;
    else if (r.bucket === "current") current += owed;
  }
  return { arrears, current };
}

/**
 * GL credit lines (member-tracked) for a member receipt; amounts sum to amountCents.
 * @param {string} memberId
 * @param {number} amountCents
 * @param {string|Date} dateInput
 * @returns {Promise<object[]>}
 */
export async function buildMemberReceiptCreditEntries(
  memberId,
  amountCents,
  dateInput,
) {
  const mid = String(memberId || "").trim();
  const cents = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!mid || cents <= 0) return [];

  const year = new Date(dateInput).getFullYear();
  const { arrears, current } = await memberOwed1400ByBucket(mid, year);
  const { toArrears1400, toCurrent1400, toAdvance2020 } =
    allocateMemberReceiptAmounts(cents, arrears, current);

  const lines = [];
  if (toArrears1400 > 0) {
    lines.push({
      accountCode: "1400",
      dc: "C",
      amount: toArrears1400,
      memberId: mid,
      periodBucket: "arrears",
    });
  }
  if (toCurrent1400 > 0) {
    lines.push({
      accountCode: "1400",
      dc: "C",
      amount: toCurrent1400,
      memberId: mid,
      periodBucket: "current",
    });
  }
  if (toAdvance2020 > 0) {
    lines.push({
      accountCode: "2020",
      dc: "C",
      amount: toAdvance2020,
      memberId: mid,
      periodBucket: "advance",
    });
  }
  return lines;
}

/**
 * Apply member credit (2020) to outstanding AR (1400) — no cash clearing leg.
 */
export async function buildMemberApplyCreditEntries(
  memberId,
  amountCents,
  dateInput,
) {
  const mid = String(memberId || "").trim();
  const requested = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!mid || requested <= 0) return [];

  const year = new Date(dateInput).getFullYear();
  const available = await member2020AdvanceCreditCents(mid, year);
  const apply = Math.min(requested, available);
  if (apply <= 0) return [];

  const { arrears, current } = await memberOwed1400ByBucket(mid, year);
  const owed = Math.max(0, arrears) + Math.max(0, current);
  if (owed <= 0) return [];

  const capped = Math.min(apply, owed);
  const { toArrears1400, toCurrent1400 } = allocateMemberReceiptAmounts(
    capped,
    arrears,
    current,
  );
  const to1400 = toArrears1400 + toCurrent1400;
  if (to1400 <= 0) return [];

  const lines = [
    {
      accountCode: "2020",
      dc: "D",
      amount: to1400,
      memberId: mid,
      periodBucket: "advance",
    },
  ];
  if (toArrears1400 > 0) {
    lines.push({
      accountCode: "1400",
      dc: "C",
      amount: toArrears1400,
      memberId: mid,
      periodBucket: "arrears",
    });
  }
  if (toCurrent1400 > 0) {
    lines.push({
      accountCode: "1400",
      dc: "C",
      amount: toCurrent1400,
      memberId: mid,
      periodBucket: "current",
    });
  }
  return lines;
}

/**
 * Credit balance on 2020 advance (cents). MatBal amount < 0 means credit.
 * @param {string} memberId
 * @param {number} year
 */
export async function member2020AdvanceCreditCents(memberId, year) {
  const mid = String(memberId || "").trim();
  if (!mid || !Number.isFinite(year)) return 0;
  const rows = await MaterializedBalance.find({
    memberId: mid,
    accountCode: "2020",
    bucket: "advance",
    year,
  }).lean();
  let credit = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (amt < 0) credit += -amt;
  }
  return credit;
}

/**
 * GL debit lines for a member refund (mirror receipt): DR 2020 advance up to credit there,
 * then DR 1400 arrears / current using the same split as receipts (remainder overflow → current).
 * @param {string} memberId
 * @param {number} amountCents
 * @param {string|Date} dateInput
 * @returns {Promise<object[]>}
 */
export async function buildMemberRefundDebitEntries(
  memberId,
  amountCents,
  dateInput,
) {
  const mid = String(memberId || "").trim();
  const cents = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!mid || cents <= 0) return [];

  const year = new Date(dateInput).getFullYear();
  const advCredit = await member2020AdvanceCreditCents(mid, year);
  const d2020Adv = Math.min(cents, advCredit);
  const rem = cents - d2020Adv;

  const { arrears: owedArrears, current: owedCurrent } =
    await memberOwed1400ByBucket(mid, year);
  const alloc = allocateMemberReceiptAmounts(rem, owedArrears, owedCurrent);
  const to1400Arr = alloc.toArrears1400;
  const to1400Cur = alloc.toCurrent1400 + alloc.toAdvance2020;

  const lines = [];
  if (d2020Adv > 0) {
    lines.push({
      accountCode: "2020",
      dc: "D",
      amount: d2020Adv,
      memberId: mid,
      periodBucket: "advance",
    });
  }
  if (to1400Arr > 0) {
    lines.push({
      accountCode: "1400",
      dc: "D",
      amount: to1400Arr,
      memberId: mid,
      periodBucket: "arrears",
    });
  }
  if (to1400Cur > 0) {
    lines.push({
      accountCode: "1400",
      dc: "D",
      amount: to1400Cur,
      memberId: mid,
      periodBucket: "current",
    });
  }
  return lines;
}
