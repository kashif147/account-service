// POST /api/reports/gl-journal-replication caller matrix over the REAL app router.
// Allowed: (A) a genuine internal S2S call (x-internal-request: true, NO user identity, an
// explicit 24-hex x-tenant-id) - reporting-service scripts/sync-gl-journal-entries.js; or
// (B) CRM staff with accounts.reports:read (PDP). Everything else is denied.
// No database: GL.find is faked; the PDP (POLICY_SERVICE_URL) is an in-process fake that
// PERMITs iff the test-signed token's permissions contain `${resource}:${action}`.
//
//   node --test --test-force-exit src/tests/glJournalReplication.internal.http.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-glrep-http-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "gl-replication-internal-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_glrep";
delete process.env.AUTH_BYPASS_ENABLED;
mongoose.set("bufferCommands", false);

const SECRET = process.env.JWT_SECRET;
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_C = "cccccccccccccccccccccccc";
const URL = "/api/reports/gl-journal-replication";

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
  const permit = Boolean(claims && (claims.permissions || []).includes(perm));
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
const { default: GL } = await import("../models/glTransaction.model.js");

// Fake GL: records each query's tenant, returns no documents.
const glQueries = [];
const origFind = GL.find;
GL.find = (query = {}) => {
  glQueries.push(query);
  const p = Promise.resolve([]);
  const o = { sort: () => o, limit: () => o, lean: () => o, select: () => o, then: (a, b) => p.then(a, b), catch: (b) => p.catch(b) };
  return o;
};

after(() => {
  GL.find = origFind;
  pdp.close();
});

function bearer({ tenantId = TENANT_A, userType, roles = [], permissions = [], id }) {
  return `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET)}`;
}
const PORTAL_A1 = bearer({ userType: "PORTAL", id: "member-a1", roles: ["MEMBER"], permissions: ["accounts.reports:read", "payments:read"] });
const CRM_REPORTS = bearer({ userType: "CRM", id: "staff-rep", roles: ["MO"], permissions: ["accounts.reports:read"] });
const CRM_MO = bearer({ userType: "CRM", id: "staff-mo", roles: ["MO"], permissions: ["profiles:read"] });
const UNKNOWN_TYPE = bearer({ id: "who", permissions: ["accounts.reports:read"] });
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TENANT_A };
// What sync-gl-journal-entries.js used to send (self-asserted gateway headers, no user).
const OLD_SCRIPT = {
  "x-tenant-id": TENANT_A,
  "x-internal-request": "true",
  "x-jwt-verified": "true",
  "x-auth-source": "gateway",
};

async function call({ auth, headers = {}, body = { limit: 50 } } = {}) {
  const server = app.listen(0);
  const before = glQueries.length;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`${base}${URL}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const q = glQueries.slice(before);
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, json, glTenants: q.map((x) => String(x.tenantId)) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const reachedFeed = (r, tenant, msg) => {
  assert.equal(r.status, 200, `${msg}: expected 200, got ${r.status} ${r.code}`);
  assert.deepEqual(r.glTenants, [tenant], `${msg}: feed must query exactly tenant ${tenant}`);
};
const blocked = (r, msg) => {
  assert.ok(r.status === 401 || r.status === 403 || r.status === 400, `${msg}: expected deny, got ${r.status}`);
  assert.deepEqual(r.glTenants, [], `${msg}: feed must not run`);
};

test("A: genuine internal call (x-internal-request + 24-hex x-tenant-id, no user identity) reaches the feed, no PDP call", async () => {
  const n = pdpCalls.length;
  reachedFeed(await call({ headers: INTERNAL }), TENANT_A, "internal A");
  reachedFeed(await call({ headers: { ...INTERNAL, "x-tenant-id": TENANT_C } }), TENANT_C, "internal C");
  assert.equal(pdpCalls.length, n, "internal call must not consult the PDP");
});

test("old script pattern (self-asserted gateway headers, no verified user) is denied", async () => {
  const r = await call({ headers: OLD_SCRIPT });
  blocked(r, "old script headers");
  assert.equal(r.status, 401);
  // ... also with an arbitrary / foreign-signed Bearer (old SYNC_AUTH_TOKEN usage)
  blocked(await call({ headers: OLD_SCRIPT, auth: "Bearer not-a-jwt" }), "old script + junk bearer");
  const forged = `Bearer ${jwt.sign({ id: "svc", sub: "svc", tenantId: TENANT_A, userType: "CRM", permissions: ["accounts.reports:read"] }, "not-the-secret")}`;
  blocked(await call({ headers: OLD_SCRIPT, auth: forged }), "old script + forged bearer");
});

test("gateway-style headers alone (x-jwt-verified / x-auth-source / x-user-*) never take the internal branch", async () => {
  for (const extra of [
    { "x-jwt-verified": "true" },
    { "x-auth-source": "gateway" },
    { "x-user-id": "staff-rep" },
    { "x-user-type": "CRM" },
    { "x-user-permissions": JSON.stringify(["accounts.reports:read"]) },
  ]) {
    blocked(await call({ headers: { ...INTERNAL, ...extra } }), `internal + ${Object.keys(extra)[0]}`);
  }
});

test("portal / unknown-type callers denied, with or without a spoofed x-internal-request", async () => {
  for (const headers of [{}, INTERNAL]) {
    const p = await call({ auth: PORTAL_A1, headers });
    blocked(p, "portal");
    assert.equal(p.status, 403);
    assert.equal(p.code, "CRM_ONLY");
    const u = await call({ auth: UNKNOWN_TYPE, headers });
    blocked(u, "unknown type");
    assert.equal(u.status, 403);
  }
});

test("B: CRM + accounts.reports:read reaches the feed for its own trusted tenant", async () => {
  reachedFeed(await call({ auth: CRM_REPORTS }), TENANT_A, "CRM reports");
  // user token + internal header (other tenant): judged as the user; tenant stays the token's
  const r = await call({ auth: CRM_REPORTS, headers: { ...INTERNAL, "x-tenant-id": TENANT_C } });
  assert.ok(!r.glTenants.includes(TENANT_C), "a user call must never be scoped to a header tenant");
  reachedFeed(r, TENANT_A, "CRM token (tenant A) + internal header for tenant C stays tenant A");
});

test("CRM without accounts.reports:read denied (PDP), also when sending x-internal-request", async () => {
  for (const headers of [{}, INTERNAL]) {
    const r = await call({ auth: CRM_MO, headers });
    blocked(r, "CRM MO");
    assert.equal(r.status, 403);
  }
});

test("internal tenant: missing -> 400 TENANT_ID_REQUIRED; malformed -> 400 INVALID_TENANT_ID", async () => {
  const missing = await call({ headers: { "x-internal-request": "true" } });
  blocked(missing, "missing tenant");
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "TENANT_ID_REQUIRED");
  for (const bad of ["abc", "tenant-A", `${TENANT_A}0`, "zzzzzzzzzzzzzzzzzzzzzzzz", `${TENANT_A.slice(0, 23)} `]) {
    const r = await call({ headers: { "x-internal-request": "true", "x-tenant-id": bad } });
    blocked(r, `malformed ${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.code, "INVALID_TENANT_ID", bad);
  }
});

test("no identity at all, or x-internal-request not exactly true -> 401", async () => {
  for (const headers of [{}, { "x-tenant-id": TENANT_A }, { ...INTERNAL, "x-internal-request": "false" }, { ...INTERNAL, "x-internal-request": "1" }]) {
    const r = await call({ headers });
    blocked(r, JSON.stringify(headers));
    assert.equal(r.status, 401);
  }
});
