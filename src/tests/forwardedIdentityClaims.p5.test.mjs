// P5 #19 pre-merge proofs: HS256 allow-list, exp required, nbf when present, required claims,
// header/claim contradictions on both identity paths, internal headers never rescue an invalid
// user token, and no unverified identity on the no-token internal path.
//   node --test --test-force-exit src/tests/forwardedIdentityClaims.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-fwdclaims-"));
process.env.JWT_SECRET = "p5-forwarded-claims-test-secret";
const SECRET = process.env.JWT_SECRET;

const { ensureAuthenticated } = await import("../middlewares/auth.js");
const { forwardedInternalContext } = await import("../middlewares/context.js");
const { isTrustedInternalCall } = await import("../middlewares/callerScope.middleware.js");

const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const STAFF = "staff-1";
const nowS = () => Math.floor(Date.now() / 1000);
const BASE = { id: STAFF, tenantId: TA, userType: "CRM", roles: ["MO"], permissions: ["profiles:read"] };

function sign(claims = BASE, { algorithm = "HS256", expiresIn = "1h", secret = SECRET } = {}) {
  return jwt.sign(claims, secret, expiresIn ? { algorithm, expiresIn } : { algorithm });
}
function gw(extra = {}) {
  return { "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": STAFF, "x-tenant-id": TA, "x-user-type": "CRM", ...extra };
}
function mkReq(headers) {
  return { headers: { ...headers }, header(n) { return this.headers[String(n).toLowerCase()]; } };
}
async function auth(headers) {
  const req = mkReq(headers);
  let err = null;
  await ensureAuthenticated(req, {}, (e) => { err = e || null; });
  return { req, status: err ? err.status : 200, code: err?.code ?? null };
}
function internal(headers) {
  const req = mkReq(headers);
  let sent = null;
  let passed = false;
  const res = { appError(e) { sent = e; return this; } };
  forwardedInternalContext(req, res, () => { passed = true; });
  return { req, passed, status: sent ? sent.status : 200, code: sent?.code ?? null };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const without = (k) => Object.fromEntries(Object.entries(BASE).filter(([x]) => x !== k));

test("C1 explicit HS256 allow-list: HS384/HS512/none refused on both paths", async () => {
  for (const algorithm of ["HS384", "HS512"]) {
    const t = sign(BASE, { algorithm });
    assert.equal((await auth({ ...gw(), ...bearer(t) })).status, 401, algorithm);
    assert.equal((await auth(bearer(t))).status, 401, algorithm);
  }
  const [, p] = sign().split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
  assert.equal((await auth({ ...gw(), ...bearer(none) })).status, 401);
  assert.equal((await auth(bearer(none))).status, 401);
});

test("C2 signature and exp: wrong secret, expired and NO-exp tokens refused on both paths", async () => {
  for (const t of [sign(BASE, { secret: "other" }), sign({ ...BASE, exp: nowS() - 5 }, { expiresIn: null }), sign(BASE, { expiresIn: null })]) {
    assert.equal((await auth({ ...gw(), ...bearer(t) })).status, 401);
    assert.equal((await auth(bearer(t))).status, 401);
  }
});

test("C3 nbf validated when present: future nbf refused, past nbf accepted", async () => {
  const future = sign({ ...BASE, nbf: nowS() + 600 });
  const past = sign({ ...BASE, nbf: nowS() - 600 });
  assert.equal((await auth({ ...gw(), ...bearer(future) })).status, 401);
  assert.equal((await auth(bearer(future))).status, 401);
  assert.equal((await auth({ ...gw(), ...bearer(past) })).status, 200);
  assert.equal((await auth(bearer(past))).status, 200);
});

test("C4 required principal, tenant and caller claims: missing any -> 401 on both paths", async () => {
  for (const k of ["id", "tenantId", "userType"]) {
    const claims = without(k);
    const t = sign(claims);
    const g = await auth({ ...gw(), ...bearer(t) });
    assert.equal(g.status, 401, `gateway missing ${k}`);
    assert.equal(g.req.user, undefined);
    const b = await auth(bearer(t));
    assert.equal(b.status, 401, `bearer missing ${k}`);
    assert.equal(b.req.user, undefined);
  }
  // only `tenantId` is a tenant claim: aliases never stand in for it
  for (const alias of ["tid", "tenantID", "tenant_id"]) {
    const t = sign({ ...without("tenantId"), [alias]: TA });
    assert.equal((await auth(bearer(t))).status, 401, alias);
  }
  // sub is an accepted principal claim
  const sub = sign({ ...without("id"), sub: STAFF });
  assert.equal((await auth(bearer(sub))).status, 200);
});

test("C5 bearer path: contradicting identity headers rejected; agreeing ones rewritten", async () => {
  const t = sign();
  assert.equal((await auth({ ...bearer(t), "x-user-id": "someone-else" })).code, "IDENTITY_MISMATCH");
  assert.equal((await auth({ ...bearer(t), "x-user-type": "PORTAL" })).code, "IDENTITY_MISMATCH");
  const tm = await auth({ ...bearer(t), "x-tenant-id": TB });
  assert.equal(tm.status, 403);
  assert.equal(tm.code, "TENANT_CONTEXT_MISMATCH");
  const ok = await auth({ ...bearer(t), "x-tenant-id": TA, "x-user-permissions": JSON.stringify(["*"]), "x-user-roles": JSON.stringify(["ASU"]) });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.req.headers["x-user-permissions"]), ["profiles:read"]);
  assert.deepEqual(ok.req.permissions, ["profiles:read"]);
  assert.deepEqual(ok.req.roles, ["MO"]);
  assert.equal(ok.req.user.userType, "CRM");
});

test("C6 internal headers never rescue an invalid user token", async () => {
  const bad = [sign(BASE, { secret: "other" }), sign({ ...BASE, exp: nowS() - 5 }, { expiresIn: null }), "not-a-jwt"];
  for (const t of bad) {
    const g = await auth({ ...gw({ "x-internal-request": "true" }), ...bearer(t) });
    assert.equal(g.status, 401);
    const b = await auth({ "x-internal-request": "true", "x-tenant-id": TA, ...bearer(t) });
    assert.equal(b.status, 401);
    assert.equal(isTrustedInternalCall(b.req), false);
  }
  // a non-Bearer Authorization header is not an identity source either
  assert.equal((await auth({ "x-internal-request": "true", "x-tenant-id": TA, authorization: "Basic Zm9vOmJhcg==" })).status, 401);
});

test("C7 no unverified identity on the no-token internal path", async () => {
  for (const h of ["x-user-id", "x-user-type", "x-user-email", "x-user-roles", "x-user-permissions"]) {
    const r = internal({ "x-internal-request": "true", "x-tenant-id": TA, [h]: h.endsWith("s") ? "[\"*\"]" : "CRM" });
    assert.equal(r.passed, false, h);
    assert.equal(r.status, 401, h);
    assert.equal(r.code, "UNVERIFIED_IDENTITY");
    assert.equal(r.req.user, undefined);
  }
  // a genuine service call (tenant only, no identity) is unchanged
  const ok = internal({ "x-internal-request": "true", "x-tenant-id": TA });
  assert.equal(ok.passed, true);
  assert.equal(isTrustedInternalCall(ok.req), true);
  assert.equal(ok.req.user.id, null);
});

test("C8 no fallback: EasyAuth / AAD / non-gateway x-jwt-verified headers yield no identity", async () => {
  const principal = Buffer.from(JSON.stringify({ claims: [{ typ: "tid", val: TA }] })).toString("base64");
  for (const h of [{ "x-ms-client-principal": principal }, { "x-ms-token-aad-access-token": "opaque" }, { "x-jwt-verified": "true" }, { "x-jwt-verified": "true", "x-auth-source": "azure" }]) {
    const r = await auth(h);
    assert.equal(r.status, 401);
    assert.equal(r.req.user, undefined);
    assert.equal(r.req.tenantId, undefined);
  }
});
