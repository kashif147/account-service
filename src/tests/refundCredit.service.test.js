import { describe, expect, test } from "@jest/globals";
import { matBalMemberKeyFromPayment } from "../services/refundCredit.service.js";

describe("matBalMemberKeyFromPayment", () => {
  test("uses memberId when only memberId is set", () => {
    expect(matBalMemberKeyFromPayment({ memberId: "B00004" })).toEqual({
      key: "B00004",
      memberId: "B00004",
      applicationId: null,
    });
  });

  test("uses app key when only applicationId is set", () => {
    expect(
      matBalMemberKeyFromPayment({ applicationId: "9cd7bf3b-6750-4d58-9cf1-f1f929336170" })
    ).toEqual({
      key: "app:9cd7bf3b-6750-4d58-9cf1-f1f929336170",
      memberId: null,
      applicationId: "9cd7bf3b-6750-4d58-9cf1-f1f929336170",
    });
  });

  test("prefers memberId when both memberId and applicationId are set", () => {
    expect(
      matBalMemberKeyFromPayment({
        memberId: "B00004",
        applicationId: "9cd7bf3b-6750-4d58-9cf1-f1f929336170",
      })
    ).toEqual({
      key: "B00004",
      memberId: "B00004",
      applicationId: null,
    });
  });

  test("reads memberId from metadata when document field missing", () => {
    expect(
      matBalMemberKeyFromPayment({
        metadata: new Map([["memberId", "M1"]]),
        applicationId: "app-1",
      })
    ).toEqual({
      key: "M1",
      memberId: "M1",
      applicationId: null,
    });
  });

  test("returns null when neither id is present", () => {
    expect(matBalMemberKeyFromPayment({ metadata: new Map() })).toBeNull();
  });
});
