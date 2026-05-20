import { describe, expect, test } from "@jest/globals";
import {
  assertPaymentBelongsToMember,
  buildReassignAuditMemo,
  extractBatchContextFromMemo,
  extractReceiptReassignContext,
  normalizeReassignPaymentItems,
  reassignedReceiptDocNo,
  reassignedRetainDocNo,
  reassignedToDocNo,
  receiptReversalDocNo,
  resolveCorrectionDate,
  allocateTotalMoveAcrossPayments,
  resolvePartialMoveAmounts,
  summarizePriorYearPayments,
} from "../helpers/paymentReassignment.helper.js";
import { memberPaymentCreditCents } from "../helpers/memberLastPayment.js";

describe("paymentReassignment.helper", () => {
  test("reassignedReceiptDocNo is stable and prefixed", () => {
    expect(reassignedReceiptDocNo("RCP-abc")).toBe("RAS-RCP-abc");
    expect(receiptReversalDocNo("RCP-abc")).toBe("RVR-RCP-abc");
  });

  test("assertPaymentBelongsToMember", () => {
    const txn = {
      docNo: "RCP-1",
      entries: [
        { memberId: "M1", accountCode: "1400", dc: "C", amount: 5000 },
      ],
    };
    expect(assertPaymentBelongsToMember(txn, "M1").ok).toBe(true);
    expect(assertPaymentBelongsToMember(txn, "M2").ok).toBe(false);
  });

  test("extractReceiptReassignContext from stripe-style receipt", () => {
    const txn = {
      docNo: "RCP-1",
      docType: "Receipt",
      entries: [
        { accountCode: "1220", dc: "D", amount: 10000 },
        { memberId: "M1", accountCode: "1400", dc: "C", amount: 8000, periodBucket: "current" },
        { memberId: "M1", accountCode: "2020", dc: "C", amount: 2000, periodBucket: "advance" },
        { accountCode: "5100", dc: "D", amount: 150 },
        { accountCode: "1220", dc: "C", amount: 150 },
      ],
    };
    expect(memberPaymentCreditCents("M1", txn)).toBe(10000);
    const ctx = extractReceiptReassignContext(txn, "M1");
    expect(ctx.ok).toBe(true);
    expect(ctx.amountCents).toBe(10000);
    expect(ctx.clearingCode).toBe("1220");
  });

  test("buildReassignAuditMemo includes reason and batch context", () => {
    const memo = buildReassignAuditMemo({
      fromMemberId: "A",
      toMemberId: "B",
      originalDocNo: "RCP-x",
      userMemo: "Wrong membership number in batch file",
      correctionDate: "2026-05-20",
      originalTxnMemo:
        "Batch: May payroll | Ref: PR-001 | Member: A Row: 12",
    });
    expect(memo).toContain("A");
    expect(memo).toContain("B");
    expect(memo).toContain("Wrong membership number");
    expect(memo).toContain("2026-05-20");
    expect(memo).toContain("Batch: May payroll");
  });

  test("extractBatchContextFromMemo", () => {
    const ctx = extractBatchContextFromMemo(
      "Batch: SO May | Ref: 99 | Member: 1 Row: 3 | extra",
    );
    expect(ctx).toContain("Batch:");
    expect(ctx).toContain("Row:");
  });

  test("resolveCorrectionDate defaults to today and blocks prior years", () => {
    const currentYear = new Date().getFullYear();
    const today = resolveCorrectionDate();
    expect(today.startsWith(String(currentYear))).toBe(true);
    expect(() => resolveCorrectionDate(`${currentYear - 1}-06-01`)).toThrow(
      /Correction date must be/,
    );
  });

  test("resolvePartialMoveAmounts", () => {
    const full = resolvePartialMoveAmounts(10000, null);
    expect(full.ok).toBe(true);
    expect(full.moveCents).toBe(10000);
    expect(full.isPartial).toBe(false);

    const part = resolvePartialMoveAmounts(10000, 3000);
    expect(part.ok).toBe(true);
    expect(part.moveCents).toBe(3000);
    expect(part.retainCents).toBe(7000);
    expect(part.isPartial).toBe(true);

    const bad = resolvePartialMoveAmounts(10000, 15000);
    expect(bad.ok).toBe(false);
  });

  test("partial doc numbers", () => {
    expect(reassignedToDocNo("batch-1")).toBe("RAS-batch-1-TO");
    expect(reassignedRetainDocNo("batch-1")).toBe("RAS-batch-1-RET");
  });

  test("normalizeReassignPaymentItems", () => {
    const fromPayments = normalizeReassignPaymentItems({
      payments: [
        { receiptDocNo: "A", amountCents: 500 },
        { receiptDocNo: "B" },
      ],
    });
    expect(fromPayments).toHaveLength(2);
    expect(fromPayments[0].amountCents).toBe(500);
    expect(fromPayments[1].amountCents).toBeNull();

    const fromNos = normalizeReassignPaymentItems({
      receiptDocNos: ["X", "Y"],
    });
    expect(fromNos).toHaveLength(2);
    expect(fromNos[0].amountCents).toBeNull();
  });

  test("buildReassignAuditMemo partial and retain legs", () => {
    const partial = buildReassignAuditMemo({
      fromMemberId: "A",
      toMemberId: "B",
      originalDocNo: "RCP-1",
      correctionDate: "2026-05-20",
      moveCents: 3000,
      totalCents: 10000,
    });
    expect(partial).toContain("partial");
    expect(partial).toContain("30.00");

    const retain = buildReassignAuditMemo({
      fromMemberId: "A",
      toMemberId: "B",
      originalDocNo: "RCP-1",
      correctionDate: "2026-05-20",
      moveCents: 7000,
      leg: "retain",
    });
    expect(retain).toContain("retain");
    expect(retain).toContain("70.00");
  });

  test("allocateTotalMoveAcrossPayments — oldest first, partial last", () => {
    const payments = Array.from({ length: 5 }, (_, i) => ({
      receiptDocNo: `batch-${i}`,
      totalCents: 2492,
      date: `2026-01-0${i + 1}`,
    }));
    const result = allocateTotalMoveAcrossPayments(payments, 10000);
    expect(result.ok).toBe(true);
    expect(result.plan.filter((p) => p.action === "full")).toHaveLength(4);
    const partial = result.plan.find((p) => p.action === "partial");
    expect(partial).toBeDefined();
    expect(partial.moveCents).toBe(10000 - 4 * 2492);
    expect(partial.retainCents).toBe(2492 - partial.moveCents);
  });

  test("allocateTotalMoveAcrossPayments — leaves trailing payments untouched", () => {
    const payments = [
      { receiptDocNo: "a", totalCents: 5000, date: "2026-01-01" },
      { receiptDocNo: "b", totalCents: 5000, date: "2026-01-02" },
      { receiptDocNo: "c", totalCents: 5000, date: "2026-01-03" },
    ];
    const result = allocateTotalMoveAcrossPayments(payments, 6000);
    expect(result.ok).toBe(true);
    expect(result.plan.filter((p) => p.action === "full")).toHaveLength(1);
    expect(result.plan.filter((p) => p.action === "partial")).toHaveLength(1);
    expect(result.plan.filter((p) => p.action === "skip")).toHaveLength(1);
  });

  test("summarizePriorYearPayments", () => {
    const prior = summarizePriorYearPayments(
      [
        { docNo: "batch-1", date: new Date("2024-03-01") },
        { docNo: "RCP-2", date: new Date("2026-01-01") },
      ],
      "2026-05-20",
    );
    expect(prior).toHaveLength(1);
    expect(prior[0].docNo).toBe("batch-1");
    expect(prior[0].originalYear).toBe(2024);
  });
});
