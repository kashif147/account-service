// P5 portal object-authorization: caller-class / ownership middleware matrix (no DB, no HTTP).
// Route wiring is proven separately over HTTP in portalObjectAuthz.p5.http.test.js (node:test).
import { describe, expect, test } from "@jest/globals";
import {
  requireFinanceRead,
  requireFinanceWrite,
  requireInternalOrFinanceDataRead,
} from "../middlewares/financePermission.middleware.js";
import {
  createRequireCrmOrOwnMember,
  createRequireInternalOrCrmOrIntentOwner,
  requireCrmUser,
  requireInternalOrCrm,
} from "../middlewares/callerScope.middleware.js";

const TENANT_A = "tenant-A";
const TENANT_C = "tenant-C";

function user({ userType, tenantId = TENANT_A, id = "u-1", roles = [], permissions = [] }) {
  return {
    user: { id, userType, tenantId, roles, permissions },
    ctx: { tenantId, userId: id, roles, permissions },
    params: {},
  };
}
const internal = (tenantId = TENANT_A) => ({
  user: { id: null, userType: null, tenantId, roles: [], permissions: [] },
  ctx: { tenantId, userId: null, roles: [], permissions: [], internalRequest: true },
  params: {},
});

async function run(mw, req) {
  let out;
  await mw(req, {}, (err) => {
    out = err;
  });
  if (out === undefined) return { allowed: true };
  return { allowed: false, status: out.status, code: out.code };
}

const PORTAL_A = (extra = {}) => user({ userType: "PORTAL", id: "member-a1", ...extra });
const CRM = (permissions, extra = {}) => user({ userType: "CRM", id: "staff-1", permissions, ...extra });

describe("requireFinanceRead (direct-debit runs, reconciliation, journal adjustments)", () => {
  test("token with NO permission claims is denied (empty-claims bypass removed)", async () => {
    expect((await run(requireFinanceRead, CRM([]))).allowed).toBe(false);
    expect((await run(requireFinanceRead, PORTAL_A())).allowed).toBe(false);
    expect((await run(requireFinanceRead, user({ userType: undefined }))).allowed).toBe(false);
  });

  test("portal member holding accounts.reports:read (and even payments:read) is denied CRM_ONLY", async () => {
    const r = await run(requireFinanceRead, PORTAL_A({ permissions: ["accounts.reports:read", "payments:read"] }));
    expect(r).toEqual({ allowed: false, status: 403, code: "CRM_ONLY" });
  });

  test("CRM with only accounts.reports:read is denied: reports permission does not unlock finance datasets", async () => {
    const r = await run(requireFinanceRead, CRM(["accounts.reports:read"]));
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
  });

  test("CRM + payments:read or accounts.admin:read is allowed", async () => {
    expect((await run(requireFinanceRead, CRM(["payments:read"]))).allowed).toBe(true);
    expect((await run(requireFinanceRead, CRM(["accounts.admin:read"]))).allowed).toBe(true);
  });

  test("missing / unknown userType fails closed even with payments:read", async () => {
    expect((await run(requireFinanceRead, user({ userType: undefined, permissions: ["payments:read"] }))).allowed).toBe(false);
    expect((await run(requireFinanceRead, user({ userType: "system", permissions: ["payments:read"] }))).allowed).toBe(false);
  });

  test("internal-or variant: internal S2S passes, user calls need CRM + claim", async () => {
    expect((await run(requireInternalOrFinanceDataRead, internal())).allowed).toBe(true);
    expect((await run(requireInternalOrFinanceDataRead, PORTAL_A({ permissions: ["payments:read"] }))).allowed).toBe(false);
    expect((await run(requireInternalOrFinanceDataRead, CRM(["payments:read"]))).allowed).toBe(true);
  });
});

describe("requireCrmUser / requireInternalOrCrm", () => {
  test("CRM allowed; PORTAL / unknown denied with CRM_ONLY", async () => {
    expect((await run(requireCrmUser, CRM([]))).allowed).toBe(true);
    expect(await run(requireCrmUser, PORTAL_A({ permissions: ["accounts.reports:read"] }))).toEqual({
      allowed: false,
      status: 403,
      code: "CRM_ONLY",
    });
    expect((await run(requireCrmUser, user({ userType: "" }))).allowed).toBe(false);
  });

  test("requireCrmUser does not admit an internal call; requireInternalOrCrm does", async () => {
    expect((await run(requireCrmUser, internal())).allowed).toBe(false);
    expect((await run(requireInternalOrCrm, internal())).allowed).toBe(true);
    expect((await run(requireInternalOrCrm, CRM([]))).allowed).toBe(true);
    expect((await run(requireInternalOrCrm, PORTAL_A())).allowed).toBe(false);
  });

  test("a user identity carrying internalRequest=false never counts as internal", async () => {
    const r = PORTAL_A();
    r.ctx.internalRequest = false;
    expect((await run(requireInternalOrCrm, r)).allowed).toBe(false);
  });
});

describe("record-external chain (P5: CRM finance write only): requireCrmUser -> requireFinanceWrite", () => {
  const chain = async (req) => {
    const a = await run(requireCrmUser, req);
    if (!a.allowed) return a;
    return run(requireFinanceWrite, req);
  };
  test("portal MEMBER / NON-MEMBER denied, even with payments:write and a finance role name", async () => {
    expect((await chain(PORTAL_A({ roles: ["MEMBER"], permissions: ["payments:write"] }))).allowed).toBe(false);
    expect((await chain(PORTAL_A({ roles: ["NON-MEMBER"], permissions: [] }))).allowed).toBe(false);
    expect((await chain(PORTAL_A({ roles: ["AM"], permissions: ["payments:write"] }))).allowed).toBe(false);
  });
  test("CRM without finance role+permission denied; CRM AM + payments:write allowed; bare internal denied", async () => {
    expect((await chain(CRM(["payments:read"], { roles: ["MO"] }))).allowed).toBe(false);
    expect((await chain(CRM(["payments:write"], { roles: ["MO"] }))).allowed).toBe(false);
    expect((await chain(CRM(["payments:write"], { roles: ["AM"] }))).allowed).toBe(true);
    expect((await chain(internal())).allowed).toBe(false);
  });
});

describe("requireCrmOrOwnMember (member statement / net balance)", () => {
  // Verified principal -> own profile, as profile-service my-profile would return it.
  const profiles = {
    "member-a1": { profileId: "p-a1", membershipNumber: "M-A1" },
    "member-c1": { profileId: "p-c1", membershipNumber: "M-C1" },
  };
  const calls = [];
  const mw = createRequireCrmOrOwnMember({
    fetchMyPortalProfile: async (req) => {
      calls.push(req.ctx.userId);
      return profiles[req.ctx.userId] || null;
    },
  });
  const withTarget = (req, memberId) => ({ ...req, params: { memberId } });

  test("A on own statement (membership number or own profileId) allowed", async () => {
    expect((await run(mw, withTarget(PORTAL_A(), "M-A1"))).allowed).toBe(true);
    expect((await run(mw, withTarget(PORTAL_A(), "p-a1"))).allowed).toBe(true);
  });

  test("A on B (same tenant) denied NOT_OWNER, even holding accounts.reports:read", async () => {
    const r = await run(mw, withTarget(PORTAL_A({ permissions: ["accounts.reports:read"] }), "M-A2"));
    expect(r).toEqual({ allowed: false, status: 403, code: "NOT_OWNER" });
  });

  test("A on C (other tenant member) denied NOT_OWNER", async () => {
    const r = await run(mw, withTarget(PORTAL_A(), "M-C1"));
    expect(r.code).toBe("NOT_OWNER");
  });

  test("portal caller with no linked profile denied; upstream failure -> 503, not a pass", async () => {
    const orphan = user({ userType: "PORTAL", id: "member-none" });
    expect((await run(mw, withTarget(orphan, "M-A1"))).code).toBe("NOT_OWNER");
    const failing = createRequireCrmOrOwnMember({
      fetchMyPortalProfile: async () => {
        throw new Error("down");
      },
    });
    expect((await run(failing, withTarget(PORTAL_A(), "M-A1"))).status).toBe(503);
  });

  test("ownership comes from the verified principal only: body/query memberId is ignored", async () => {
    const req = withTarget(PORTAL_A(), "M-A2");
    req.body = { memberId: "M-A2" };
    req.query = { memberId: "M-A2" };
    expect((await run(mw, req)).allowed).toBe(false);
  });

  test("CRM allowed without a profile lookup (the PDP then applies); unknown userType denied", async () => {
    const before = calls.length;
    expect((await run(mw, withTarget(CRM(["accounts.reports:read"]), "M-A2"))).allowed).toBe(true);
    expect(calls.length).toBe(before);
    expect((await run(mw, withTarget(user({ userType: undefined }), "M-A1"))).code).toBe("CRM_ONLY");
  });
});

describe("requireInternalOrCrmOrIntentOwner (attach-registration, by-stripe)", () => {
  // Payments keyed by tenant + PaymentIntent id; audit.createdBy is the verified creator.
  const store = {
    [`${TENANT_A}|pi_a1`]: { _id: "pay-a1", audit: { createdBy: "member-a1" } },
    [`${TENANT_A}|pi_a2`]: { _id: "pay-a2", audit: { createdBy: "member-a2" } },
    [`${TENANT_C}|pi_c1`]: { _id: "pay-c1", audit: { createdBy: "member-c1" } },
  };
  const lookups = [];
  const mw = createRequireInternalOrCrmOrIntentOwner({
    loadPaymentByIntent: async (tenantId, pi) => {
      lookups.push(tenantId);
      return store[`${tenantId}|${pi}`] || null;
    },
  });
  const onIntent = (req, paymentIntentId) => ({ ...req, params: { paymentIntentId } });

  test("A on own intent allowed", async () => {
    expect((await run(mw, onIntent(PORTAL_A(), "pi_a1"))).allowed).toBe(true);
  });
  test("A on B's intent (same tenant) denied NOT_OWNER", async () => {
    expect(await run(mw, onIntent(PORTAL_A(), "pi_a2"))).toEqual({ allowed: false, status: 403, code: "NOT_OWNER" });
  });
  test("A on C's intent (other tenant) denied with the same NOT_OWNER (no existence leak); lookup pinned to A", async () => {
    lookups.length = 0;
    expect((await run(mw, onIntent(PORTAL_A(), "pi_c1"))).code).toBe("NOT_OWNER");
    expect((await run(mw, onIntent(PORTAL_A(), "pi_missing"))).code).toBe("NOT_OWNER");
    expect(lookups.every((t) => t === TENANT_A)).toBe(true);
  });
  test("CRM and internal pass without ownership; unknown userType denied", async () => {
    expect((await run(mw, onIntent(CRM([]), "pi_a2"))).allowed).toBe(true);
    expect((await run(mw, onIntent(internal(), "pi_a2"))).allowed).toBe(true);
    expect((await run(mw, onIntent(user({ userType: undefined }), "pi_a1"))).code).toBe("CRM_ONLY");
  });
});
