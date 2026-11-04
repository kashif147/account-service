// P5 record-external: CRM finance write only. The bare x-internal-request branch is removed - no
// service calls POST /payments/record-external, and a header-only call could create a succeeded
// Payment (any applicationId) plus its GL journal outside the signed payment authority boundary.
// REAL app router, no database: Payment.create is replaced by a recorder so "reached the handler"
// is observable without writing anything (the GL post that follows fails fast, bufferCommands off).
//
//   node --test --test-force-exit src/tests/recordExternalCrmOnly.p5.test.mjs
import test, { after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-p5-recext-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "p5-record-external-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_p5";
delete process.env.AUTH_BYPASS_ENABLED;
mongoose.set("bufferCommands", false);

const SECRET = process.env.JWT_SECRET;
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";

const { default: app } = await import("../app.js");
const { default: Payment } = await import("../models/payment.model.js");

const origCreate = Payment.create;
let created = [];
beforeEach(() => {
  created = [];
  Payment.create = async (doc) => {
    created.push(doc);
    return { ...doc, _id: new mongoose.Types.ObjectId() };
  };
});
after(() => {
  Payment.create = origCreate;
});

function bearer({ userType, roles = [], permissions = [], id }) {
  return `Bearer ${jwt.sign({ id, sub: id, tenantId: TENANT_A, userType, roles, permissions }, SECRET, { expiresIn: "1h" })}`;
}
const CRM_FIN_WRITE = bearer({ userType: "CRM", id: "staff-am", roles: ["AM"], permissions: ["payments:read", "payments:write"] });
const CRM_MO = bearer({ userType: "CRM", id: "staff-mo", roles: ["MO"], permissions: ["payments:write"] });
const PORTAL = bearer({ userType: "PORTAL", id: "member-a1", roles: ["AM"], permissions: ["payments:write"] });
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TENANT_A };

const IN_BODY = { direction: "in", amount: 1000, currency: "eur", applicationId: "app-1", reason: "probe" };
const OUT_BODY = { direction: "out", amount: 300, currency: "eur", memberId: "M-A1", reason: "probe" };

async function call({ auth, headers = {}, body }) {
  const server = app.listen(0);
  try {
    const { port, family } = server.address();
    const host = family === "IPv6" ? "[::1]" : "127.0.0.1";
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`http://${host}:${port}/api/payments/record-external`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body || {}),
    });
    let json = null;
    try {
      json = JSON.parse(await res.text());
    } catch {
      json = null;
    }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("R1 bare internal call (no user identity) is refused 403 CRM_ONLY and creates nothing - both directions", async () => {
  for (const body of [IN_BODY, OUT_BODY, { direction: "sideways" }]) {
    const r = await call({ headers: INTERNAL, body });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.code, "CRM_ONLY");
  }
  assert.equal(created.length, 0);
});

test("R2 bare internal call with x-user-* but no token is refused before the route (401, #19)", async () => {
  const r = await call({ headers: { ...INTERNAL, "x-user-id": "staff-am", "x-user-type": "CRM" }, body: IN_BODY });
  assert.equal(r.status, 401);
  assert.equal(created.length, 0);
});

test("R3 CRM finance write is unchanged: guards pass (invalid body -> 400 validation; valid body reaches the handler)", async () => {
  const bad = await call({ auth: CRM_FIN_WRITE, body: { direction: "sideways" } });
  assert.equal(bad.status, 400);
  assert.equal(created.length, 0);
  const ok = await call({ auth: CRM_FIN_WRITE, body: IN_BODY });
  assert.notEqual(ok.status, 401);
  assert.notEqual(ok.status, 403);
  assert.equal(created.length, 1, "the CRM finance-write call reached recordExternal");
  assert.equal(created[0].tenantId, TENANT_A, "tenant is the verified token tenant");
  assert.equal(created[0].status, "succeeded");
});

test("R4 mixed identity: a CRM token plus x-internal-request is judged as that user, never as internal", async () => {
  const fin = await call({ auth: CRM_FIN_WRITE, headers: INTERNAL, body: { direction: "sideways" } });
  assert.equal(fin.status, 400, "finance-write user passes as the user");
  const mo = await call({ auth: CRM_MO, headers: INTERNAL, body: IN_BODY });
  assert.equal(mo.status, 403, "no finance role: the internal header does not rescue it");
  const portal = await call({ auth: PORTAL, headers: INTERNAL, body: IN_BODY });
  assert.equal(portal.status, 403);
  assert.equal(created.length, 0);
});

test("R5 CRM without the finance role, portal and no-auth callers are refused and create nothing", async () => {
  assert.equal((await call({ auth: CRM_MO, body: IN_BODY })).status, 403);
  assert.equal((await call({ auth: PORTAL, body: IN_BODY })).status, 403);
  assert.equal((await call({ body: IN_BODY })).status, 401);
  assert.equal(created.length, 0);
});
