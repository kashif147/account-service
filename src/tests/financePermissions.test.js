import { describe, expect, test } from "@jest/globals";
import {
  collectRequestPermissions,
  collectRequestRoles,
  hasFinanceActionRole,
  hasFinancePermission,
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

  test("hasFinanceActionRole allows Accounts Manager role code", () => {
    const req = { user: { roles: ["AM"] } };
    expect(hasFinanceActionRole(req)).toBe(true);
  });

  test("hasFinanceActionRole allows Super User roles", () => {
    expect(hasFinanceActionRole({ user: { roles: ["SU"] } })).toBe(true);
    expect(hasFinanceActionRole({ user: { roles: ["ASU"] } })).toBe(true);
  });

  test("hasFinanceActionRole allows Deputy Accounts Manager role name", () => {
    const req = { ctx: { roles: [{ name: "Deputy Accounts Manager" }] } };
    expect(hasFinanceActionRole(req)).toBe(true);
  });

  test("collectRequestRoles normalizes role objects", () => {
    const req = { user: { roles: [{ code: "am" }] } };
    expect(collectRequestRoles(req)).toContain("AM");
  });
});
