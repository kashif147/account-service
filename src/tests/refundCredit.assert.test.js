import { describe, expect, test, jest, beforeEach } from "@jest/globals";

const glFindOneMock = jest.fn();
const matBalFindMock = jest.fn();

await jest.unstable_mockModule("../models/glTransaction.model.js", () => ({
  default: { findOne: glFindOneMock },
}));

await jest.unstable_mockModule("../models/materializedBalance.model.js", () => ({
  default: { find: matBalFindMock },
}));

const { assertRefundWithinCredit } = await import(
  "../services/refundCredit.service.js"
);

describe("assertRefundWithinCredit with CLAIM fallback", () => {
  beforeEach(() => {
    glFindOneMock.mockReset();
    matBalFindMock.mockReset();
  });

  test("uses member 2020 credit when app bucket is empty but CLAIM exists", async () => {
    glFindOneMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        entries: [
          {
            accountCode: "2020",
            dc: "D",
            amount: 8150,
            applicationId: "app-uuid-1",
            periodBucket: "current",
          },
          {
            accountCode: "2020",
            dc: "C",
            amount: 8150,
            memberId: "B00004",
            periodBucket: "current",
          },
        ],
      }),
    });

    matBalFindMock.mockImplementation((query) => {
      const mid = query?.memberId;
      if (mid === "app:app-uuid-1") {
        return { lean: jest.fn().mockResolvedValue([{ amount: 0 }]) };
      }
      if (mid === "B00004") {
        return { lean: jest.fn().mockResolvedValue([{ amount: -8150 }]) };
      }
      return { lean: jest.fn().mockResolvedValue([]) };
    });

    await expect(
      assertRefundWithinCredit(
        8150,
        { applicationId: "app-uuid-1", metadata: new Map() },
        2026
      )
    ).resolves.toBeUndefined();
  });

  test("still fails when neither app nor claimed member has credit", async () => {
    glFindOneMock.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });
    matBalFindMock.mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ amount: 0 }]),
    });

    await expect(
      assertRefundWithinCredit(
        100,
        { applicationId: "app-uuid-1", metadata: new Map() },
        2026
      )
    ).rejects.toMatchObject({ message: "Refund exceeds available credit on account 2020" });
  });
});
