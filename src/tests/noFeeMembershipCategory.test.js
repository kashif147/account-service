import { describe, expect, test } from "@jest/globals";
import {
  isNoFeeMembershipCategory,
  normalizeMembershipCategoryKey,
} from "../helpers/noFeeMembershipCategory.js";

describe("no fee membership category detection", () => {
  test("normalizes category keys from labels and ids", () => {
    expect(normalizeMembershipCategoryKey("undergraduate_student")).toBe(
      "undergraduate student"
    );
    expect(normalizeMembershipCategoryKey(" Undergraduate-Student ")).toBe(
      "undergraduate student"
    );
  });

  test("treats undergraduate students and honorary as no-fee categories", () => {
    expect(isNoFeeMembershipCategory("undergraduate_student")).toBe(true);
    expect(isNoFeeMembershipCategory("Undergraduate Student")).toBe(true);
    expect(isNoFeeMembershipCategory("Honorary")).toBe(true);
  });

  test("does not treat paid student-like categories as undergraduate no-fee", () => {
    expect(isNoFeeMembershipCategory("Postgraduate Student")).toBe(false);
    expect(isNoFeeMembershipCategory("Short-term/Relief")).toBe(false);
  });
});
