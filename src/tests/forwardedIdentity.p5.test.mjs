// P5 forwarded identity: gateway-forwarded x-user-* headers are a claim, never authentication.
// The gateway does not sign them; account-service takes identity only from the original
// ProjectShell JWT (forwarded as Authorization), verified here, and the headers must agree.
//   node --test --test-force-exit src/tests/forwardedIdentity.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-fwdid-"));
process.env.JWT_SECRET = "p5-forwarded-identity-test-secret";
const SECRET = process.env.JWT_SECRET;

const { ensureAuthenticated } = await import("../middlewares/auth.js");
const { isTrustedInternalCall, isCrmCaller } = await import("../middlewares/callerScope.middleware.js");

const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const STAFF = "staff-1";
const nowS = () => Math.floor(Date.now() / 1000);

function sign(claims = {}, { secret = SECRET, algorithm = "HS256" } = {}) {
  return jwt.sign({ id: STAFF, tenantId: TA, userType: "CRM", roles: ["MO"], permissions: ["profiles:read"], ...claims }, secret, { algorithm });
}
function gw(extra = {}) {
  return {
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": STAFF,
    "x-tenant-id": TA,
    "x-user-type": "CRM",
    "x-user-roles": JSON.stringify(["MO"]),
    "x-user-permissions": JSON.stringify(["profiles:read"]),
    "x-token-expires-at": String(Date.now() + 3600_000),
    ...extra,
  };
}
async function run(headers) {
  const req = { headers: { ...headers }, header(n) { return this.headers[String(n).toLowerCase()]; } };
  let err = null;
  let called = false;
  await ensureAuthenticated(req, {}, (e) => {
    called = true;
    err = e || null;
  });
  assert.ok(called, "next() must be called");
  return { req, err, status: err ? err.status : 200, code: err?.code ?? null };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

test("1 missing token (gateway headers only) -> 401, no identity", async () => {
  const r = await run(gw());
  assert.equal(r.status, 401);
  assert.equal(r.code, "VERIFIED_TOKEN_REQUIRED");
  assert.equal(r.req.user, undefined);
});

test("2 token signed with another secret -> 401", async () => {
  const r = await run({ ...gw(), ...bearer(sign({}, { secret: "not-the-secret" })) });
  assert.equal(r.status, 401);
  assert.equal(r.code, "INVALID_TOKEN");
});

test("2b algorithm other than HS256 (HS512 / none) -> 401", async () => {
  assert.equal((await run({ ...gw(), ...bearer(sign({}, { algorithm: "HS512" })) })).status, 401);
  const [h, p] = sign().split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
  assert.ok(h);
  assert.equal((await run({ ...gw(), ...bearer(none) })).status, 401);
});

test("3 changed signed fields: tampered token payload -> 401", async () => {
  const [h, , s] = sign().split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ id: STAFF, tenantId: TA, userType: "CRM", permissions: ["*"], exp: nowS() + 3600 })).toString("base64url");
  const r = await run({ ...gw(), ...bearer(`${h}.${forgedPayload}.${s}`) });
  assert.equal(r.status, 401);
  assert.equal(r.code, "INVALID_TOKEN");
});

test("3b headers changed against the verified token: user id / user type -> 401 IDENTITY_MISMATCH", async () => {
  const t = sign();
  for (const extra of [{ "x-user-id": "someone-else" }, { "x-user-type": "PORTAL" }]) {
    const r = await run({ ...gw(extra), ...bearer(t) });
    assert.equal(r.status, 401, JSON.stringify(extra));
    assert.equal(r.code, "IDENTITY_MISMATCH");
  }
  // missing forwarded user id: refused by the gateway-shape check before the token is read
  assert.equal((await run({ ...gw({ "x-user-id": "" }), ...bearer(t) })).status, 401);
  // a PORTAL token cannot be relabelled CRM by the header
  const portal = sign({ id: "member-1", userType: "PORTAL" });
  const r = await run({ ...gw({ "x-user-id": "member-1", "x-user-type": "CRM" }), ...bearer(portal) });
  assert.equal(r.code, "IDENTITY_MISMATCH");
});

test("3c forged roles/permissions/email headers are replaced by the verified claims", async () => {
  const r = await run({
    ...gw({ "x-user-permissions": JSON.stringify(["*", "payments:write"]), "x-user-roles": JSON.stringify(["ASU"]), "x-user-email": "forged" }),
    ...bearer(sign()),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.req.permissions, ["profiles:read"]);
  assert.deepEqual(r.req.roles, ["MO"]);
  assert.equal(r.req.headers["x-user-permissions"], JSON.stringify(["profiles:read"]));
  assert.equal(r.req.headers["x-user-roles"], JSON.stringify(["MO"]));
  assert.notEqual(r.req.headers["x-user-email"], "forged");
});

test("4 expired identity -> 401 even with a future x-token-expires-at header", async () => {
  const expired = sign({ exp: nowS() - 60 });
  const r = await run({ ...gw({ "x-token-expires-at": String(Date.now() + 86_400_000) }), ...bearer(expired) });
  assert.equal(r.status, 401);
  assert.equal(r.code, "INVALID_TOKEN");
  // not-yet-valid token
  assert.equal((await run({ ...gw(), ...bearer(sign({ nbf: nowS() + 600 })) })).status, 401);
});

test("4b self-asserted x-token-expires-at is overwritten from the verified exp", async () => {
  const exp = nowS() + 900;
  const r = await run({ ...gw({ "x-token-expires-at": "99999999999999" }), ...bearer(sign({ exp })) });
  assert.equal(r.status, 200);
  assert.equal(r.req.headers["x-token-expires-at"], String(exp * 1000));
});

test("5 valid supported identity -> authenticated from the verified token", async () => {
  const r = await run({ ...gw({ "x-idempotency-key": "k-1" }), ...bearer(sign()) });
  assert.equal(r.status, 200);
  assert.equal(r.req.userId, STAFF);
  assert.equal(r.req.tenantId, TA);
  assert.equal(r.req.user.userType, "CRM");
  assert.equal(r.req.ctx.idempotencyKey, "k-1");
  assert.ok(isCrmCaller(r.req));
  // gateway sets x-user-type "" for a token without userType: allowed, userType stays unknown
  const noType = jwt.sign({ id: STAFF, tenantId: TA }, SECRET);
  const r2 = await run({ ...gw({ "x-user-type": "" }), ...bearer(noType) });
  assert.equal(r2.status, 200);
  assert.equal(r2.req.user.userType, null);
});

test("6 mixed user + internal headers: never internal; needs the verified token", async () => {
  const withToken = await run({ ...gw({ "x-internal-request": "true" }), ...bearer(sign()) });
  assert.equal(withToken.status, 200);
  assert.equal(isTrustedInternalCall(withToken.req), false);
  assert.equal(withToken.req.ctx.internalRequest, undefined);
  const noToken = await run(gw({ "x-internal-request": "true" }));
  assert.equal(noToken.status, 401);
});

test("7 tenant mismatch between forwarded x-tenant-id and the verified token -> 403", async () => {
  const r = await run({ ...gw({ "x-tenant-id": TB }), ...bearer(sign()) });
  assert.equal(r.status, 403);
  assert.equal(r.code, "TENANT_CONTEXT_MISMATCH");
  assert.equal(r.req.tenantId, undefined);
});

test("8 x-jwt-verified with a non-gateway auth source is not an identity source", async () => {
  const r = await run({ ...gw({ "x-auth-source": "azuread" }) });
  assert.equal(r.status, 401);
  assert.equal(r.req.user, undefined);
});

test("9 unverified EasyAuth principal / bare AAD token are refused", async () => {
  const principal = Buffer.from(JSON.stringify({ claims: [{ typ: "tid", val: TA }, { typ: "oid", val: "x" }] })).toString("base64");
  const a = await run({ "x-ms-client-principal": principal });
  assert.equal(a.status, 401);
  assert.equal(a.req.tenantId, undefined);
  const b = await run({ "x-ms-token-aad-access-token": "opaque" });
  assert.equal(b.status, 401);
  assert.equal(b.req.headers.authorization, undefined);
});

test("10 direct Bearer path: verified HS256 only, invalid -> 401", async () => {
  const ok = await run(bearer(sign()));
  assert.equal(ok.status, 200);
  assert.equal(ok.req.tenantId, TA);
  assert.equal((await run(bearer(sign({}, { secret: "nope" })))).status, 401);
  assert.equal((await run(bearer(sign({ exp: nowS() - 5 })))).status, 401);
});
