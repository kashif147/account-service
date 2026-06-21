import { describe, expect, test, afterEach, jest } from "@jest/globals";
import {
  allocateMemberReceiptAmounts,
  allocateMemberRefund1400Amounts,
  memberOwed1400AllYears,
  member2020AdvanceCreditCents,
} from "../helpers/paymentReceiptAllocation.js";
import MaterializedBalance from "../models/materializedBalance.model.js";

describe("allocateMemberReceiptAmounts", () => {
  test("full payment to 2020 advance when nothing owed on 1400", () => {
    expect(allocateMemberReceiptAmounts(5000, 0, 0)).toEqual({
      toArrears1400: 0,
      toCurrent1400: 0,
      toAdvance2020: 5000,
    });
  });

  test("clears arrears then current then advance", () => {
    expect(allocateMemberReceiptAmounts(10000, 3000, 4000)).toEqual({
      toArrears1400: 3000,
      toCurrent1400: 4000,
      toAdvance2020: 3000,
    });
  });

  test("payment smaller than arrears: all to arrears", () => {
    expect(allocateMemberReceiptAmounts(2000, 5000, 7000)).toEqual({
      toArrears1400: 2000,
      toCurrent1400: 0,
      toAdvance2020: 0,
    });
  });

  test("payment clears arrears and partial current", () => {
    expect(allocateMemberReceiptAmounts(4000, 3000, 7000)).toEqual({
      toArrears1400: 3000,
      toCurrent1400: 1000,
      toAdvance2020: 0,
    });
  });
});

describe("allocateMemberRefund1400Amounts", () => {
  test("allocates current before arrears", () => {
    expect(allocateMemberRefund1400Amounts(10000, 4000, 3000)).toEqual({
      toCurrent1400: 4000,
      toArrears1400: 3000,
      overflowCurrent: 3000,
    });
  });

  test("fills current then arrears when payment smaller than current", () => {
    expect(allocateMemberRefund1400Amounts(5000, 8000, 2000)).toEqual({
      toCurrent1400: 5000,
      toArrears1400: 0,
      overflowCurrent: 0,
    });
  });

  test("overflow goes to current bucket", () => {
    expect(allocateMemberRefund1400Amounts(9000, 2000, 1000)).toEqual({
      toCurrent1400: 2000,
      toArrears1400: 1000,
      overflowCurrent: 6000,
    });
  });
});

describe("member2020AdvanceCreditCents", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("sums negative advance 2020 balance", async () => {
    jest.spyOn(MaterializedBalance, "find").mockReturnValue({
      lean: jest
        .fn()
        .mockResolvedValue([{ amount: -3000 }, { amount: -2000 }]),
    });
    await expect(
      member2020AdvanceCreditCents("M1", 2026),
    ).resolves.toBe(5000);
  });
});

describe("memberOwed1400AllYears", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("nets later write-off credits against older arrears rows", async () => {
    jest.spyOn(MaterializedBalance, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { bucket: "arrears", amount: 12000 },
        { bucket: "arrears", amount: -12000 },
        { bucket: "current", amount: 3000 },
      ]),
    });

    await expect(memberOwed1400AllYears("M1")).resolves.toEqual({
      arrears: 0,
      current: 3000,
    });
  });
});
