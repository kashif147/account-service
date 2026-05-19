import { describe, expect, test } from "@jest/globals";
import {
  hasFinancePermission,
  collectRequestPermissions,
} from "../helpers/financePermissions.js";

describe("financePermissions", () => {
  test("payments:read satisfies accounts.journals read", () => {
    expect(
      hasFinancePermission(["payments:read"], "accounts.journals", "read"),
    ).toBe(true);
  });

  test("payments:write satisfies accounts.journals write", () => {
    expect(
      hasFinancePermission(["payments:write"], "accounts.journals", "write"),
    ).toBe(true);
  });

  test("collectRequestPermissions merges user, ctx, and query", () => {
    const req = {
      user: { permissions: ["payments:read"] },
      ctx: { permissions: ["accounts.reports:read"] },
      query: { permissions: "payments:write" },
    };
    const merged = collectRequestPermissions(req);
    expect(merged).toContain("payments:read");
    expect(merged).toContain("accounts.reports:read");
    expect(merged).toContain("payments:write");
  });
});
