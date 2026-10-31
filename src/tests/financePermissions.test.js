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

  test("collectRequestPermissions merges user and ctx, never the query string or body", () => {
    const req = {
      user: { permissions: ["payments:read"] },
      ctx: { permissions: ["accounts.reports:read"] },
      query: { permissions: "payments:write,accounts.admin:write,*" },
      body: { permissions: ["accounts.journals:write"] },
    };
    const merged = collectRequestPermissions(req);
    expect(merged).toContain("payments:read");
    expect(merged).toContain("accounts.reports:read");
    expect(merged).not.toContain("payments:write");
    expect(merged).not.toContain("accounts.admin:write");
    expect(merged).not.toContain("*");
    expect(merged).not.toContain("accounts.journals:write");
  });

  test("a client query string cannot turn a read-only caller into a finance writer", () => {
    const req = {
      user: { permissions: ["payments:read"], roles: ["AM"] },
      query: { permissions: "payments:write" },
    };
    expect(
      hasFinancePermission(collectRequestPermissions(req), "payments", "write"),
    ).toBe(false);
  });

  test("hasFinanceActionRole allows Accounts Manager role code", () => {
    const req = { user: { roles: ["AM"] } };
    expect(hasFinanceActionRole(req)).toBe(true);
  });

  test("hasFinanceActionRole allows the tenant administrator (ASU); the retired SU grants nothing (Phase B / Z9)", () => {
    expect(hasFinanceActionRole({ user: { roles: ["ASU"] } })).toBe(true);
    expect(hasFinanceActionRole({ user: { roles: [{ name: "Assistant Super User" }] } })).toBe(true);
    expect(hasFinanceActionRole({ user: { roles: ["SU"] } })).toBe(false);
    expect(hasFinanceActionRole({ user: { roles: [{ name: "Super User" }] } })).toBe(false);
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
