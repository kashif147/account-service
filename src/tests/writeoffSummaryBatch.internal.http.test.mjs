// POST /api/internal/members/writeoff (INTERNAL ONLY) and POST /api/reports/members/summary-batch
// (trusted internal branch + unchanged CRM chain) caller matrix over the REAL app router.
//
// Callers proven in subscription-service (origin/develop 12ba4d0): helpers/serviceClient.js
// postMemberOutstandingWriteOff + fetchMemberSummariesByMemberIds, used by
// renewalBatch.service writeOffArchivedMemberBalances / buildBalanceSnapshotMap (tenant = the
// claimed YearEndBatch tenant) and subscription.upsert.listener
// writeOffSuspendedReinstatementBalance (tenant = resolveEventTenant), all with
// createInternalWorkerReq(tenantId) -> headers { x-tenant-id, x-internal-request } only.
//
// No database: CoA / GL / MaterializedBalance statics are faked and record the tenant of every
// query. The PDP (POLICY_SERVICE_URL) is an in-process fake that PERMITs iff the test-signed
// token's permissions contain `${resource}:${action}`.
//
//   node --test --test-force-exit src/tests/writeoffSummaryBatch.internal.http.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-wo-sb-http-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "writeoff-summary-batch-internal-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_wosb";
delete process.env.AUTH_BYPASS_ENABLED;
mongoose.set("bufferCommands", false);

const SECRET = process.env.JWT_SECRET;
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_C = "cccccccccccccccccccccccc";
const WRITEOFF = "/api/internal/members/writeoff";
const SUMMARY = "/api/reports/members/summary-batch";

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}
function decode(token) {
  try {
    return jwt.verify(String(token || "").replace(/^Bearer /, ""), SECRET);
  } catch {
    return null;
  }
}

const pdpCalls = [];
const pdp = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  const claims = decode(body.token);
  const perm = `${body.resource}:${body.action}`;
  pdpCalls.push(perm);
  const permit = Boolean(
    claims && ((claims.permissions || []).includes(perm) || (claims.permissions || []).includes("*")),
  );
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      permit
        ? {
            success: true,
            decision: "PERMIT",
            user: {
              id: claims.id,
              tenantId: claims.tenantId,
              userType: claims.userType,
              roles: claims.roles || [],
              permissions: claims.permissions || [],
            },
          }
        : { success: false, decision: "DENY", reason: "TEST_PDP_DENY" },
    ),
  );
});
await new Promise((r) => pdp.listen(0, "127.0.0.1", r));
process.env.POLICY_SERVICE_URL = `http://127.0.0.1:${pdp.address().port}`;

const { default: app } = await import("../app.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");

// Every faked ledger read records the tenant it was scoped to.
const ledgerTenants = [];
const journalLookups = [];
const chain = (rows) => {
  const p = Promise.resolve(rows);
  const o = { sort: () => o, limit: () => o, lean: () => o, select: () => o, then: (a, b) => p.then(a, b), catch: (b) => p.catch(b) };
  return o;
};
const orig = { coaFind: CoA.find, glFindOne: GL.findOne, glCreate: GL.create, glAggregate: GL.aggregate, matFind: MatBal.find };
CoA.find = (query = {}) => {
  ledgerTenants.push(String(query.tenantId));
  if (query.isMemberTracked) return chain([{ code: "1400" }]);
  return chain([
    { code: "5200", description: "Bad debts written off", tenantId: query.tenantId },
    { code: "1400", description: "Members receivable", tenantId: query.tenantId, isMemberTracked: true },
  ]);
};
// Idempotent replay: postBalancedJournal returns the existing docNo row (no write path needed).
GL.findOne = (query = {}) => {
  ledgerTenants.push(String(query.tenantId));
  journalLookups.push({ tenantId: String(query.tenantId), docNo: query.docNo });
  return chain({ _id: "existing-journal", tenantId: query.tenantId, docNo: query.docNo });
};
GL.create = async () => {
  throw new Error("test: GL.create must not be reached (idempotent replay expected)");
};
GL.aggregate = (pipeline = []) => {
  ledgerTenants.push(String(pipeline?.[0]?.$match?.tenantId));
  return Promise.resolve([]);
};
MatBal.find = (query = {}) => {
  ledgerTenants.push(String(query.tenantId));
  return chain([]);
};

after(() => {
  CoA.find = orig.coaFind;
  GL.findOne = orig.glFindOne;
  GL.create = orig.glCreate;
  GL.aggregate = orig.glAggregate;
  MatBal.find = orig.matFind;
  pdp.close();
});

function bearer({ tenantId = TENANT_A, userType, roles = [], permissions = [], id }) {
  return `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET)}`;
}
const PORTAL_A1 = bearer({ userType: "PORTAL", id: "member-a1", roles: ["MEMBER"], permissions: ["accounts.reports:read", "payments:read", "payments:write"] });
const CRM_REPORTS = bearer({ userType: "CRM", id: "staff-rep", roles: ["MO"], permissions: ["accounts.reports:read"] });
const CRM_MO = bearer({ userType: "CRM", id: "staff-mo", roles: ["MO"], permissions: ["profiles:read"] });
const CRM_AM_FINANCE = bearer({ userType: "CRM", id: "staff-am", roles: ["AM"], permissions: ["payments:write", "payments:read", "accounts.reports:read"] });
const CRM_ASU = bearer({ userType: "CRM", id: "staff-asu", roles: ["ASU"], permissions: ["*"] });
const UNKNOWN_TYPE = bearer({ id: "who", roles: ["AM"], permissions: ["accounts.reports:read", "payments:write"] });
// Exactly what subscription createInternalWorkerReq + buildServiceHeaders send for a pure worker.
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TENANT_A };
const WO_BODY = { date: "2026-01-01", docNo: "WO-YE-2025-ARCHIVE-M-A1-ARREARS", memberId: "M-A1", amount: 1500, periodBucket: "arrears", memo: "test" };
const SB_BODY = { memberIds: ["M-A1", "M-A2"], scope: "all" };
// User identity forwarded next to the internal header (subscription buildServiceHeaders with a
// live CRM req): never internal.
const FORWARDED_USER = {
  "x-user-id": "staff-am",
  "x-user-type": "CRM",
  "x-user-roles": JSON.stringify(["AM"]),
  "x-user-permissions": JSON.stringify(["payments:write"]),
};

async function call(url, { auth, headers = {}, body = {} } = {}) {
  const server = app.listen(0);
  const before = ledgerTenants.length;
  const beforeJ = journalLookups.length;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`${base}${url}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      status: res.status,
      code: json?.code ?? json?.error?.code ?? null,
      json,
      tenants: [...new Set(ledgerTenants.slice(before))],
      journals: journalLookups.slice(beforeJ),
    };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const blocked = (r, msg) => {
  assert.ok([400, 401, 403].includes(r.status), `${msg}: expected deny, got ${r.status} ${r.code}`);
  assert.deepEqual(r.tenants, [], `${msg}: no ledger read/write may run`);
};
const internalOnly = (r, msg) => {
  blocked(r, msg);
  assert.equal(r.status, 403, `${msg}: status`);
  assert.equal(r.code, "INTERNAL_ONLY", `${msg}: code`);
};

// ---------------- POST /api/internal/members/writeoff ----------------

test("W1 worker internal call (x-internal-request + explicit 24-hex tenant, no user identity) posts the write-off in THAT tenant only, no PDP", async () => {
  const n = pdpCalls.length;
  for (const tenant of [TENANT_A, TENANT_C]) {
    const r = await call(WRITEOFF, { headers: { ...INTERNAL, "x-tenant-id": tenant }, body: WO_BODY });
    assert.equal(r.status, 201, `tenant ${tenant}: ${r.status} ${r.code}`);
    assert.deepEqual(r.tenants, [tenant], "every ledger query scoped to the header tenant");
    assert.deepEqual(r.journals, [{ tenantId: tenant, docNo: WO_BODY.docNo }]);
  }
  // with a correlation id (subscription forwards it) still internal
  const c = await call(WRITEOFF, { headers: { ...INTERNAL, "x-correlation-id": "corr-1" }, body: WO_BODY });
  assert.equal(c.status, 201);
  assert.equal(pdpCalls.length, n, "internal write-off must not consult the PDP");
});

test("W2 worker internal call: missing tenant -> 401; malformed tenant -> 400 INVALID_TENANT_ID; nothing posted", async () => {
  const missing = await call(WRITEOFF, { headers: { "x-internal-request": "true" }, body: WO_BODY });
  blocked(missing, "missing tenant");
  assert.equal(missing.status, 401);
  for (const bad of ["tenant-A", "abc", `${TENANT_A}0`, "zzzzzzzzzzzzzzzzzzzzzzzz", "default"]) {
    const r = await call(WRITEOFF, { headers: { "x-internal-request": "true", "x-tenant-id": bad }, body: WO_BODY });
    blocked(r, `malformed ${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.code, "INVALID_TENANT_ID", bad);
  }
});

test("W3 user identity + x-internal-request is judged as the user: 403 INTERNAL_ONLY (CRM finance, ASU, forwarded x-user-*, gateway headers)", async () => {
  internalOnly(await call(WRITEOFF, { auth: CRM_AM_FINANCE, headers: INTERNAL, body: WO_BODY }), "AM finance Bearer + internal");
  internalOnly(await call(WRITEOFF, { auth: CRM_ASU, headers: INTERNAL, body: WO_BODY }), "ASU Bearer + internal");
  // No Bearer, but forwarded user headers next to the internal header (old code: internal grant)
  internalOnly(await call(WRITEOFF, { headers: { ...INTERNAL, ...FORWARDED_USER }, body: WO_BODY }), "forwarded x-user-* + internal");
  for (const [k, v] of Object.entries(FORWARDED_USER)) {
    internalOnly(await call(WRITEOFF, { headers: { ...INTERNAL, [k]: v }, body: WO_BODY }), `internal + ${k}`);
  }
  // Self-asserted gateway headers: never internal (verified as a user or rejected)
  for (const extra of [
    { "x-jwt-verified": "true", "x-auth-source": "gateway", ...FORWARDED_USER },
    { "x-jwt-verified": "true" },
    { "x-auth-source": "gateway" },
  ]) {
    blocked(await call(WRITEOFF, { headers: { ...INTERNAL, ...extra }, body: WO_BODY }), `internal + ${Object.keys(extra).join(",")}`);
  }
});

test("W4 CRM users have no write-off route (was: AM/DAM/ASU + finance write): 403 INTERNAL_ONLY", async () => {
  for (const [name, auth] of [["AM finance", CRM_AM_FINANCE], ["ASU *", CRM_ASU], ["MO", CRM_MO], ["reports", CRM_REPORTS]]) {
    internalOnly(await call(WRITEOFF, { auth, body: WO_BODY }), name);
  }
});

test("W5 portal / unknown userType denied, with or without x-internal-request", async () => {
  for (const headers of [{}, INTERNAL]) {
    internalOnly(await call(WRITEOFF, { auth: PORTAL_A1, headers, body: WO_BODY }), "portal");
    internalOnly(await call(WRITEOFF, { auth: UNKNOWN_TYPE, headers, body: WO_BODY }), "unknown type");
  }
});

test("W6 no identity / x-internal-request not exactly true -> 401; forged Bearer + internal -> rejected by token verification", async () => {
  for (const headers of [{}, { "x-tenant-id": TENANT_A }, { ...INTERNAL, "x-internal-request": "false" }, { ...INTERNAL, "x-internal-request": "1" }]) {
    const r = await call(WRITEOFF, { headers, body: WO_BODY });
    blocked(r, JSON.stringify(headers));
    assert.equal(r.status, 401, `${JSON.stringify(headers)} ${r.code}`);
  }
  const forged = `Bearer ${jwt.sign({ id: "svc", tenantId: TENANT_A, userType: "CRM", roles: ["AM"], permissions: ["payments:write"] }, "not-the-secret")}`;
  const r = await call(WRITEOFF, { auth: forged, headers: INTERNAL, body: WO_BODY });
  // ensureAuthenticated's existing invalid-signature response (400 "Invalid token"): never internal.
  blocked(r, "forged bearer + internal");
  assert.equal(r.status, 400, `forged ${r.code}`);
  assert.equal(r.json?.details?.tokenError, true);
});

// ---------------- POST /api/reports/members/summary-batch ----------------

test("S1 worker internal call reaches the summary batch for the explicit header tenant only, no PDP", async () => {
  const n = pdpCalls.length;
  for (const tenant of [TENANT_A, TENANT_C]) {
    const r = await call(SUMMARY, { headers: { ...INTERNAL, "x-tenant-id": tenant }, body: SB_BODY });
    assert.equal(r.status, 200, `tenant ${tenant}: ${r.status} ${r.code}`);
    assert.deepEqual(r.tenants, [tenant], "every ledger query scoped to the header tenant");
    assert.deepEqual(r.json?.data?.items?.map((x) => x.memberId), SB_BODY.memberIds);
  }
  assert.equal(pdpCalls.length, n, "internal summary batch must not consult the PDP");
});

test("S2 worker internal call: missing tenant -> 400 TENANT_ID_REQUIRED; malformed -> 400 INVALID_TENANT_ID", async () => {
  const missing = await call(SUMMARY, { headers: { "x-internal-request": "true" }, body: SB_BODY });
  blocked(missing, "missing tenant");
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "TENANT_ID_REQUIRED");
  for (const bad of ["tenant-A", "abc", `${TENANT_A}0`, "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
    const r = await call(SUMMARY, { headers: { "x-internal-request": "true", "x-tenant-id": bad }, body: SB_BODY });
    blocked(r, `malformed ${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.code, "INVALID_TENANT_ID", bad);
  }
});

test("S3 CRM chain unchanged: CRM + accounts.reports:read -> 200 in its token tenant, even with x-internal-request + another tenant header", async () => {
  const r = await call(SUMMARY, { auth: CRM_REPORTS, body: SB_BODY });
  assert.equal(r.status, 200, `${r.status} ${r.code}`);
  assert.deepEqual(r.tenants, [TENANT_A]);
  const spoof = await call(SUMMARY, { auth: CRM_REPORTS, headers: { ...INTERNAL, "x-tenant-id": TENANT_C }, body: SB_BODY });
  assert.equal(spoof.status, 200);
  assert.ok(!spoof.tenants.includes(TENANT_C), "a user call is never scoped to a header tenant");
  assert.deepEqual(spoof.tenants, [TENANT_A]);
});

test("S4 CRM without accounts.reports:read -> 403 (PDP), also when sending x-internal-request (no generic authenticated access)", async () => {
  for (const headers of [{}, INTERNAL]) {
    const r = await call(SUMMARY, { auth: CRM_MO, headers, body: SB_BODY });
    blocked(r, "CRM MO");
    assert.equal(r.status, 403);
  }
});

test("S5 portal (holding accounts.reports:read) / unknown userType denied, with or without x-internal-request", async () => {
  for (const headers of [{}, INTERNAL]) {
    const p = await call(SUMMARY, { auth: PORTAL_A1, headers, body: SB_BODY });
    blocked(p, "portal");
    assert.equal(p.status, 403);
    assert.equal(p.code, "CRM_ONLY");
    const u = await call(SUMMARY, { auth: UNKNOWN_TYPE, headers, body: SB_BODY });
    blocked(u, "unknown type");
    assert.equal(u.status, 403);
  }
});

test("S6 forwarded x-user-* / self-asserted gateway headers + x-internal-request never take the internal branch", async () => {
  for (const extra of [
    FORWARDED_USER,
    { "x-user-id": "staff-rep" },
    { "x-user-permissions": JSON.stringify(["accounts.reports:read"]) },
    { "x-jwt-verified": "true" },
    { "x-auth-source": "gateway" },
    { "x-jwt-verified": "true", "x-auth-source": "gateway" },
  ]) {
    blocked(await call(SUMMARY, { headers: { ...INTERNAL, ...extra }, body: SB_BODY }), `internal + ${Object.keys(extra).join(",")}`);
  }
});

test("S7 no identity at all, or x-internal-request not exactly true -> 401", async () => {
  for (const headers of [{}, { "x-tenant-id": TENANT_A }, { ...INTERNAL, "x-internal-request": "false" }, { ...INTERNAL, "x-internal-request": "1" }]) {
    const r = await call(SUMMARY, { headers, body: SB_BODY });
    blocked(r, JSON.stringify(headers));
    assert.equal(r.status, 401);
  }
});
