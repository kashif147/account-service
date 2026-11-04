// P5 portal object-authorization: HTTP-level route-wiring matrix over the REAL app router.
// No database (mongoose buffering off; the few model statics the guards touch are faked),
// no live services: the PDP (POLICY_SERVICE_URL) and profile-service my-profile
// (PROFILE_SERVICE_URL) are tiny in-process fakes on 127.0.0.1.
//
// Fake PDP: PERMIT iff the (test-signed) token's permissions contain `${resource}:${action}`.
//
// node:test (jest@25 here cannot load mongoose / the app):
//   node --test --test-force-exit src/tests/portalObjectAuthz.p5.http.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-p5-http-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "p5-object-authz-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_p5";
delete process.env.AUTH_BYPASS_ENABLED;
mongoose.set("bufferCommands", false); // unstubbed DB access fails fast instead of hanging

const SECRET = process.env.JWT_SECRET;
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_C = "cccccccccccccccccccccccc";

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

// ---- fake PDP ----
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

// ---- fake profile-service my-profile (verified principal -> own profile) ----
const PROFILES = {
  "member-a1": { profileId: "pa1000000000000000000001", membershipNumber: "M-A1" },
  "member-a2": { profileId: "pa2000000000000000000002", membershipNumber: "M-A2" },
  "member-c1": { profileId: "pc1000000000000000000001", membershipNumber: "M-C1" },
};
const profileSvc = http.createServer((req, res) => {
  const claims = decode(req.headers.authorization);
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/profile/my-profile")) {
    return res.end(JSON.stringify({ data: (claims && PROFILES[claims.id]) || null }));
  }
  // anything else (e.g. lookup-by-membership used by controllers): empty
  return res.end(JSON.stringify({ data: [] }));
});

await new Promise((r) => pdp.listen(0, "127.0.0.1", r));
await new Promise((r) => profileSvc.listen(0, "127.0.0.1", r));
process.env.POLICY_SERVICE_URL = `http://127.0.0.1:${pdp.address().port}`;
process.env.PROFILE_SERVICE_URL = `http://127.0.0.1:${profileSvc.address().port}`;

const { default: app } = await import("../app.js");
const { default: Payment } = await import("../models/payment.model.js");

after(() => {
  pdp.close();
  profileSvc.close();
});

function bearer({ tenantId = TENANT_A, userType, roles = [], permissions = [], id }) {
  return `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET, { expiresIn: "1h" })}`;
}

// Callers
const PORTAL_A1 = bearer({ userType: "PORTAL", id: "member-a1", roles: ["MEMBER"], permissions: ["accounts.reports:read", "payments:read", "payments:write"] });
const PORTAL_A1_BARE = bearer({ userType: "PORTAL", id: "member-a1", roles: ["NON-MEMBER"] });
const PORTAL_C1 = bearer({ tenantId: TENANT_C, userType: "PORTAL", id: "member-c1", roles: ["MEMBER"], permissions: ["accounts.reports:read"] });
const CRM_EMPTY = bearer({ userType: "CRM", id: "staff-empty" });
const CRM_REPORTS = bearer({ userType: "CRM", id: "staff-rep", roles: ["MO"], permissions: ["accounts.reports:read"] });
const CRM_FIN_READ = bearer({ userType: "CRM", id: "staff-fin", roles: ["AA"], permissions: ["payments:read", "accounts.reports:read", "accounts.journals:read"] });
const CRM_FIN_WRITE = bearer({ userType: "CRM", id: "staff-am", roles: ["AM"], permissions: ["payments:read", "payments:write"] });
const CRM_MO = bearer({ userType: "CRM", id: "staff-mo", roles: ["MO"], permissions: ["profiles:read"] });
// an unrecognised caller class (a token with NO userType is refused earlier, 401)
const UNKNOWN_TYPE = bearer({ id: "who", userType: "SERVICE", permissions: ["payments:read", "accounts.reports:read"] });
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TENANT_A };

function q(result) {
  const p = Promise.resolve(result);
  const o = { lean: () => o, select: () => o, sort: () => o, then: (a, b) => p.then(a, b), catch: (b) => p.catch(b) };
  return o;
}

async function call(method, url, { auth, headers = {}, body } = {}) {
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); }); // explicit IPv4 loopback: matches the 127.0.0.1 fetch target
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`${base}${url}`, {
      method,
      headers: h,
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, code: json?.code ?? null };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const denied = (r, msg) => assert.ok(r.status === 403 || r.status === 401, `${msg}: expected 401/403, got ${r.status}`);
const passed = (r, msg) => assert.ok(r.status !== 403 && r.status !== 401, `${msg}: expected to pass authz, got ${r.status} ${r.code}`);

// Payments owned by a PORTAL user (audit.createdBy = verified id at intent creation).
const PAYMENTS = {
  [`${TENANT_A}|pi_a1`]: { _id: "pay-a1", tenantId: TENANT_A, audit: { createdBy: "member-a1" }, amount: 100, currency: "eur" },
  [`${TENANT_A}|pi_a2`]: { _id: "pay-a2", tenantId: TENANT_A, audit: { createdBy: "member-a2" }, amount: 100, currency: "eur" },
  [`${TENANT_C}|pi_c1`]: { _id: "pay-c1", tenantId: TENANT_C, audit: { createdBy: "member-c1" }, amount: 100, currency: "eur" },
};
async function withPayments(fn) {
  const orig = Payment.findOne;
  Payment.findOne = (f = {}) => q(PAYMENTS[`${f.tenantId}|${f["stripe.paymentIntentId"]}`] || null);
  try {
    return await fn();
  } finally {
    Payment.findOne = orig;
  }
}

const RUN_ID = "65f000000000000000000001";

// ---------------- finance gate: direct-debit runs + finance lists ----------------
const FINANCE_READ_ROUTES = [
  "/api/direct-debit-runs",
  `/api/direct-debit-runs/${RUN_ID}`,
  `/api/direct-debit-runs/${RUN_ID}/items`,
  `/api/direct-debit-runs/${RUN_ID}/prepare-status`,
  `/api/direct-debit-runs/${RUN_ID}/download-pain008`,
  "/api/finance/reconciliation",
  "/api/finance/reconciliation/dashboard",
  "/api/finance/journal-adjustments",
];

test("finance read gate: empty-permissions token denied on every DD / reconciliation / adjustment read", async () => {
  for (const url of FINANCE_READ_ROUTES) denied(await call("GET", url, { auth: CRM_EMPTY }), `CRM empty ${url}`);
});

test("finance read gate: portal member with accounts.reports:read (+payments:*) denied, incl. PAIN.008 download", async () => {
  for (const url of FINANCE_READ_ROUTES) {
    const r = await call("GET", url, { auth: PORTAL_A1 });
    assert.equal(r.status, 403, url);
    assert.equal(r.code, "CRM_ONLY", url);
  }
});

test("finance read gate: CRM with only accounts.reports:read denied; unknown userType denied", async () => {
  for (const url of FINANCE_READ_ROUTES) {
    assert.equal((await call("GET", url, { auth: CRM_REPORTS })).status, 403, url);
    assert.equal((await call("GET", url, { auth: UNKNOWN_TYPE })).status, 403, url);
  }
});

test("finance read gate: CRM + payments:read passes authz", async () => {
  for (const url of FINANCE_READ_ROUTES) {
    // PDP P3 (Q2): the PAIN.008 file additionally needs payments.bank:read (see directDebitBankData.p3.test.mjs);
    // finance read alone now gets 403 BANK_DATA_PERMISSION_REQUIRED there, i.e. it passed the finance gate.
    if (url.endsWith("/download-pain008")) {
      const r = await call("GET", url, { auth: CRM_FIN_READ });
      assert.equal(r.status, 403, url);
      assert.equal(r.code, "BANK_DATA_PERMISSION_REQUIRED", url);
      continue;
    }
    passed(await call("GET", url, { auth: CRM_FIN_READ }), url);
  }
});

// ---------------- reports ----------------
const STAFF_ONLY_REPORTS = [
  ["GET", "/api/reports/general-ledger"],
  ["GET", "/api/reports/refunds"],
  ["POST", "/api/reports/creditors-list"],
  ["POST", "/api/reports/gl-journal-replication"],
  ["POST", "/api/reports/members/summary-batch"],
  ["GET", "/api/reports/balances/snapshot"],
  ["GET", "/api/reports/balances/as-of?asOf=2026-01-01"],
  ["GET", "/api/reports/member/M-A1/summary"],
  ["GET", "/api/reports/member/M-A1/ledger"],
  ["GET", "/api/reports/member/M-A1/credit-notes"],
  ["GET", "/api/reports/member/M-A1/ledger-actions"],
];

test("reports: portal member (accounts.reports:read) denied CRM_ONLY on GL / creditors / snapshots / ledgers, even its own ledger", async () => {
  for (const [m, url] of STAFF_ONLY_REPORTS) {
    const r = await call(m, url, { auth: PORTAL_A1 });
    assert.equal(r.status, 403, url);
    assert.equal(r.code, "CRM_ONLY", url);
  }
});

test("reports: CRM + accounts.reports:read passes; CRM without it denied by the PDP", async () => {
  for (const [m, url] of STAFF_ONLY_REPORTS) {
    passed(await call(m, url, { auth: CRM_REPORTS }), `CRM reports ${url}`);
    assert.equal((await call(m, url, { auth: CRM_MO })).status, 403, `CRM MO ${url}`);
  }
});

test("member statement / net-balance: A on own allowed; A on B same tenant and A on C other tenant denied NOT_OWNER", async () => {
  for (const kind of ["statement", "net-balance"]) {
    passed(await call("GET", `/api/reports/member/M-A1/${kind}`, { auth: PORTAL_A1 }), `own ${kind}`);
    const ab = await call("GET", `/api/reports/member/M-A2/${kind}`, { auth: PORTAL_A1 });
    assert.equal(ab.status, 403);
    assert.equal(ab.code, "NOT_OWNER");
    const ac = await call("GET", `/api/reports/member/M-C1/${kind}`, { auth: PORTAL_A1 });
    assert.equal(ac.status, 403);
    assert.equal(ac.code, "NOT_OWNER");
    // C (tenant C) on A's member number: not theirs either
    assert.equal((await call("GET", `/api/reports/member/M-A1/${kind}`, { auth: PORTAL_C1 })).code, "NOT_OWNER");
  }
});

test("member statement: CRM + accounts.reports:read passes for any member; CRM without permission denied; unknown type denied", async () => {
  passed(await call("GET", "/api/reports/member/M-A2/statement", { auth: CRM_REPORTS }), "CRM statement");
  assert.equal((await call("GET", "/api/reports/member/M-A2/statement", { auth: CRM_MO })).status, 403);
  assert.equal((await call("GET", "/api/reports/member/M-A1/statement", { auth: UNKNOWN_TYPE })).status, 403);
});

test("member statement: portal own-statement still needs the PDP permission (owner without accounts.reports:read denied)", async () => {
  assert.equal((await call("GET", "/api/reports/member/M-A1/statement", { auth: PORTAL_A1_BARE })).status, 403);
});

// ---------------- payments ----------------
test("record-external: portal MEMBER / NON-MEMBER denied; CRM without finance write denied; CRM AM + payments:write passes; bare internal refused (P5)", async () => {
  const body = { direction: "in", amount: 1000, currency: "eur", memberId: "M-A2" };
  for (const auth of [PORTAL_A1, PORTAL_A1_BARE, PORTAL_C1, UNKNOWN_TYPE]) {
    assert.equal((await call("POST", "/api/payments/record-external", { auth, body })).status, 403);
  }
  assert.equal((await call("POST", "/api/payments/record-external", { auth: CRM_MO, body })).status, 403);
  assert.equal((await call("POST", "/api/payments/record-external", { auth: CRM_FIN_READ, body })).status, 403);
  // Allowed callers are sent an invalid body (400 from validation) so nothing is created.
  assert.equal((await call("POST", "/api/payments/record-external", { auth: CRM_FIN_WRITE, body: { direction: "sideways" } })).status, 400);
  // P5: the bare x-internal-request branch is removed (no service caller) - refused before validation.
  assert.equal((await call("POST", "/api/payments/record-external", { headers: INTERNAL, body: { direction: "sideways" } })).status, 403);
});

test("record-external: a user JWT + spoofed x-internal-request does not get the internal grant", async () => {
  const r = await call("POST", "/api/payments/record-external", {
    auth: PORTAL_A1,
    headers: INTERNAL,
    body: { direction: "in", amount: 1000, currency: "eur", memberId: "M-A1" },
  });
  assert.equal(r.status, 403);
});

test("capture / cancel: portal denied even on its own intent; CRM (profile/events approver) and internal pass", async () => {
  await withPayments(async () => {
    for (const action of ["capture", "cancel"]) {
      const url = `/api/payments/intents/pi_a1/${action}`;
      const r = await call("POST", url, { auth: PORTAL_A1 });
      assert.equal(r.status, 403, url);
      assert.equal(r.code, "CRM_ONLY");
      assert.equal((await call("POST", url, { auth: UNKNOWN_TYPE })).status, 403);
      passed(await call("POST", url, { auth: CRM_MO }), `CRM ${action}`);
      passed(await call("POST", url, { headers: INTERNAL }), `internal ${action}`);
    }
  });
});

test("attach-registration / by-stripe: A on own intent passes; A on B (same tenant) and A on C (other tenant) denied NOT_OWNER", async () => {
  await withPayments(async () => {
    passed(await call("POST", "/api/payments/intents/pi_a1/attach-registration", { auth: PORTAL_A1, body: { registrationId: "r1" } }), "own attach");
    const own = await call("GET", "/api/payments/by-stripe/pi_a1", { auth: PORTAL_A1 });
    assert.equal(own.status, 200);
    for (const pi of ["pi_a2", "pi_c1", "pi_missing"]) {
      const a = await call("POST", `/api/payments/intents/${pi}/attach-registration`, { auth: PORTAL_A1, body: { registrationId: "r1" } });
      assert.equal(a.status, 403, pi);
      assert.equal(a.code, "NOT_OWNER", pi);
      const b = await call("GET", `/api/payments/by-stripe/${pi}`, { auth: PORTAL_A1 });
      assert.equal(b.status, 403, pi);
      assert.equal(b.code, "NOT_OWNER", pi);
    }
    passed(await call("GET", "/api/payments/by-stripe/pi_a2", { auth: CRM_MO }), "CRM by-stripe");
    passed(await call("GET", "/api/payments/by-stripe/pi_a2", { headers: INTERNAL }), "internal by-stripe");
  });
});

test("batch / associate-member / refunds list / application latest: portal denied; legitimate callers pass", async () => {
  for (const [m, url, body] of [
    ["POST", "/api/payments/batch", { memberIds: ["M-A2"] }],
    ["POST", "/api/payments/associate-member", {}],
    ["GET", "/api/payments/refunds"],
    ["GET", "/api/payments/applications/app-1/latest"],
  ]) {
    assert.equal((await call(m, url, { auth: PORTAL_A1, body })).status, 403, `portal ${url}`);
    assert.equal((await call(m, url, { auth: UNKNOWN_TYPE, body })).status, 403, `unknown ${url}`);
  }
  // CRM subscription grid aggregation / internal worker
  passed(await call("POST", "/api/payments/batch", { auth: CRM_MO, body: { memberIds: ["M-A2"] } }), "CRM batch");
  passed(await call("POST", "/api/payments/batch", { headers: INTERNAL, body: { memberIds: ["M-A2"] } }), "internal batch");
  // refunds list: finance claim required
  assert.equal((await call("GET", "/api/payments/refunds", { auth: CRM_REPORTS })).status, 403);
  passed(await call("GET", "/api/payments/refunds", { auth: CRM_FIN_READ }), "CRM refunds");
  // associate-member: CRM finance write only
  assert.equal((await call("POST", "/api/payments/associate-member", { auth: CRM_MO, body: {} })).status, 403);
  assert.equal((await call("POST", "/api/payments/associate-member", { auth: CRM_FIN_WRITE, body: {} })).status, 400);
});

test("POST /payments/intents stays reachable for portal self-pay (paymentIntentGuard binds ownership)", async () => {
  // Another member's number: rejected by the existing ownership guard, not by a caller-class gate.
  const r = await call("POST", "/api/payments/intents", {
    auth: PORTAL_A1,
    body: { amount: 1000, currency: "eur", purpose: "subscriptionFee", memberId: "M-A2" },
  });
  assert.notEqual(r.code, "CRM_ONLY");
  assert.equal(r.status, 403);
});

// ---------------- journal: events manual payment ----------------
test("events manual-payment (+post, +void): portal denied; CRM event staff and internal pass", async () => {
  // P5 containment: CRM callers also need the exact events business permission
  // (events:create to record, events:write to post / void).
  const CRM_EVENTS = bearer({ userType: "CRM", id: "staff-ev", roles: ["EO"], permissions: ["events:create", "events:write"] });
  for (const url of ["/api/journal/events/manual-payment", "/api/journal/events/manual-payment/post", "/api/journal/events/manual-payment/void"]) {
    const r = await call("POST", url, { auth: PORTAL_A1, body: { method: "comp" } });
    assert.equal(r.status, 403, url);
    assert.equal(r.code, "CRM_ONLY", url);
    assert.equal((await call("POST", url, { auth: UNKNOWN_TYPE, body: {} })).status, 403, url);
    if (url.endsWith("/manual-payment")) {
      const mo = await call("POST", url, { auth: CRM_MO, body: {} });
      assert.equal(mo.status, 403, `CRM without events:create ${url}`);
      assert.equal(mo.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED", url);
    }
    // empty body -> validation 400 proves authz passed without writing anything
    assert.equal((await call("POST", url, { auth: CRM_EVENTS, body: {} })).status, 400, `CRM ${url}`);
    assert.equal((await call("POST", url, { headers: INTERNAL, body: {} })).status, 400, `internal ${url}`);
  }
});

// ---------------- batch-details ----------------
test("batch-details GET /:id (and list / queue-stats): portal denied CRM_ONLY; CRM without permission denied; CRM + accounts.journals:read passes", async () => {
  for (const url of [`/api/batch-details/${RUN_ID}`, "/api/batch-details", "/api/batch-details/queue-stats"]) {
    const r = await call("GET", url, { auth: PORTAL_A1 });
    assert.equal(r.status, 403, url);
    assert.equal(r.code, "CRM_ONLY", url);
    assert.equal((await call("GET", url, { auth: CRM_MO })).status, 403, url);
    passed(await call("GET", url, { auth: CRM_FIN_READ }), url);
  }
});

// ---------------- gateway-header path: verified Bearer userType fallback ----------------
function gatewayHeaders({ userId, tenantId = TENANT_A, userType, permissions = [] }) {
  const h = {
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": userId,
    "x-tenant-id": tenantId,
    "x-user-roles": "[]",
    "x-user-permissions": JSON.stringify(permissions),
  };
  if (userType !== undefined) h["x-user-type"] = userType;
  return h;
}

test("gateway headers without x-user-type (profile-service style forward): identity only from a verified matching Bearer", async () => {
  const url = "/api/payments/intents/pi_a1/capture";
  await withPayments(async () => {
    const mo = bearer({ userType: "CRM", id: "staff-mo" });
    // matching verified Bearer -> CRM -> passes
    passed(await call("POST", url, { auth: mo, headers: gatewayHeaders({ userId: "staff-mo" }) }), "verified fallback");
    // no Bearer -> the forwarded headers are not an identity -> 401
    assert.equal((await call("POST", url, { headers: gatewayHeaders({ userId: "staff-mo" }) })).status, 401);
    // Bearer for a different user than the gateway identity -> 401
    assert.equal((await call("POST", url, { auth: mo, headers: gatewayHeaders({ userId: "member-a1" }) })).status, 401);
    // Bearer signed with another secret -> 401
    const forged = `Bearer ${jwt.sign({ id: "staff-mo", sub: "staff-mo", tenantId: TENANT_A, userType: "CRM" }, "not-the-secret")}`;
    assert.equal((await call("POST", url, { auth: forged, headers: gatewayHeaders({ userId: "staff-mo" }) })).status, 401);
    // x-user-type disagreeing with the verified token -> 401
    assert.equal((await call("POST", url, { auth: mo, headers: gatewayHeaders({ userId: "staff-mo", userType: "PORTAL" }) })).status, 401);
    // forwarded tenant disagreeing with the verified token -> 403
    assert.equal((await call("POST", url, { auth: mo, headers: gatewayHeaders({ userId: "staff-mo", tenantId: TENANT_C }) })).status, 403);
    // stored/forged headers + x-internal-request, no token: not internal, not a user -> 401
    assert.equal((await call("POST", url, { headers: { ...gatewayHeaders({ userId: "staff-mo", userType: "CRM" }), "x-internal-request": "true" } })).status, 401);
  });
});

// ---------------- journal: POST /online-payment (batch 2) ----------------
// No service, CRM screen or portal flow calls this route (online card receipts are posted by
// payments.service on Stripe capture), so its only legitimate caller is CRM finance staff.
// PORTAL is denied by caller class BEFORE the PDP: holding accounts.journals:create (or "*")
// must not matter, so these tokens carry every finance permission string.
const EVERY_PERMISSION = [
  "*",
  "admin",
  "accounts.journals:create",
  "accounts.journals:read",
  "accounts.journals:write",
  "accounts.admin:*",
  "accounts.reports:read",
  "payments:*",
  "payments:read",
  "payments:write",
];
const PORTAL_MEMBER_ALL = bearer({ userType: "PORTAL", id: "member-a1", roles: ["MEMBER"], permissions: EVERY_PERMISSION });
const PORTAL_NONMEMBER_ALL = bearer({ userType: "PORTAL", id: "member-a2", roles: ["NON-MEMBER"], permissions: EVERY_PERMISSION });
const PORTAL_OTHER_TENANT_ALL = bearer({ tenantId: TENANT_C, userType: "PORTAL", id: "member-c1", roles: ["MEMBER"], permissions: EVERY_PERMISSION });
const UNKNOWN_TYPE_ALL = bearer({ id: "who-all", userType: "SERVICE", permissions: EVERY_PERMISSION });
const MISSING_TYPE_ALL = bearer({ id: "who-none", permissions: EVERY_PERMISSION });
const CRM_JOURNALS = bearer({ userType: "CRM", id: "staff-aa", roles: ["AA"], permissions: ["accounts.journals:create", "accounts.journals:read"] });

const ONLINE_PAYMENT = "/api/journal/online-payment";
const ONLINE_PAYMENT_BODY = { date: "2026-01-01", docNo: "OP-X", memberId: "M-A2", amount: 1000, clearingCode: "1220", provider: "stripe" };

test("online-payment: PORTAL MEMBER / NON-MEMBER / other tenant with every permission incl. accounts.journals:create -> 403 CRM_ONLY before the PDP", async () => {
  for (const auth of [PORTAL_MEMBER_ALL, PORTAL_NONMEMBER_ALL, PORTAL_OTHER_TENANT_ALL]) {
    const before = pdpCalls.length;
    const r = await call("POST", ONLINE_PAYMENT, { auth, body: ONLINE_PAYMENT_BODY });
    assert.equal(r.status, 403);
    assert.equal(r.code, "CRM_ONLY");
    assert.equal(pdpCalls.length, before, "caller-class gate must deny before any PDP call");
  }
});

test("online-payment: unknown userType with every permission -> 403; missing userType -> 401", async () => {
  const r = await call("POST", ONLINE_PAYMENT, { auth: UNKNOWN_TYPE_ALL, body: ONLINE_PAYMENT_BODY });
  assert.equal(r.status, 403);
  assert.equal(r.code, "CRM_ONLY");
  const m = await call("POST", ONLINE_PAYMENT, { auth: MISSING_TYPE_ALL, body: ONLINE_PAYMENT_BODY });
  assert.equal(m.status, 401);
});

test("online-payment: user token + spoofed x-internal-request is judged as that user (PORTAL -> 403)", async () => {
  const r = await call("POST", ONLINE_PAYMENT, { auth: PORTAL_MEMBER_ALL, headers: INTERNAL, body: ONLINE_PAYMENT_BODY });
  assert.equal(r.status, 403);
  assert.equal(r.code, "CRM_ONLY");
});

test("online-payment: bare x-internal-request (no user identity) is not a caller of this route -> 401", async () => {
  const r = await call("POST", ONLINE_PAYMENT, { headers: INTERNAL, body: ONLINE_PAYMENT_BODY });
  assert.equal(r.status, 401);
});

test("online-payment: CRM + accounts.journals:create passes authz; CRM without the permission denied by the PDP", async () => {
  // Invalid body -> 400 from validation proves authz passed without posting anything.
  const ok = await call("POST", ONLINE_PAYMENT, { auth: CRM_JOURNALS, body: {} });
  assert.equal(ok.status, 400);
  for (const auth of [CRM_MO, CRM_EMPTY, CRM_REPORTS]) {
    assert.equal((await call("POST", ONLINE_PAYMENT, { auth, body: ONLINE_PAYMENT_BODY })).status, 403);
  }
});

// ---------------- journal reads: CRM finance screens only (batch 2) ----------------
// GET /journal (CRM Write-offs summary), /stripe-payments (CRM online payments grid),
// /credit-notes (CRM credit notes summary / member finance tab), /credit-notes/:docNo (no
// caller). No portal flow reads these; a member reads their own account via
// /reports/member/:memberId/statement | net-balance only.
const JOURNAL_READS = [
  "/api/journal",
  "/api/journal/stripe-payments",
  "/api/journal/credit-notes",
  "/api/journal/credit-notes/CN-X",
];

test("journal reads: PORTAL (MEMBER / NON-MEMBER, every permission) and unknown userType -> 403 CRM_ONLY", async () => {
  for (const url of JOURNAL_READS) {
    for (const auth of [PORTAL_MEMBER_ALL, PORTAL_NONMEMBER_ALL, PORTAL_A1, UNKNOWN_TYPE_ALL]) {
      const r = await call("GET", url, { auth });
      assert.equal(r.status, 403, url);
      assert.equal(r.code, "CRM_ONLY", url);
    }
  }
});

test("journal reads: CRM + accounts.journals:read passes authz; CRM without it denied by the PDP", async () => {
  for (const url of JOURNAL_READS) {
    passed(await call("GET", url, { auth: CRM_JOURNALS }), `CRM journals ${url}`);
    assert.equal((await call("GET", url, { auth: CRM_MO })).status, 403, `CRM MO ${url}`);
  }
});
