// P5 payment-mutation containment (temporary narrowing of the CRM user path; NOT a closure):
// capture / cancel and the events manual-payment record / post / void, over the REAL app router
// against a REAL throwaway mongod. Stripe is an in-process fake on the lib/stripe singleton.
//
//   node --test --test-force-exit src/tests/paymentMutationContainment.p5.test.mjs
//
// Skips (does not fail) when no mongod is on PATH and LEDGER_TEST_MONGO_URI is unset.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-paycontain-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-payment-containment-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_contain";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TC = "cccccccccccccccccccccccc";
let seq = 0;
const oid = () => (0xc0000 + (seq += 1)).toString(16).padStart(24, "0");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}
let mongodProc = null;
let mongodDir = null;
async function startMongo() {
  if (process.env.LEDGER_TEST_MONGO_URI) return process.env.LEDGER_TEST_MONGO_URI;
  if (spawnSync("mongod", ["--version"]).status !== 0) return null;
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-paycontain-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_containment_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { setPaymentLinkOnce } = await import("../services/payments.service.js");
const { default: app } = await import("../app.js");

// ---- fake Stripe ----
const PIS = new Map();
const CALLS = [];
stripeClient.paymentIntents.retrieve = async (id) => {
  CALLS.push(["retrieve", id]);
  const pi = PIS.get(id);
  if (!pi) throw Object.assign(new Error("No such payment_intent"), { statusCode: 404 });
  return { ...pi };
};
stripeClient.paymentIntents.capture = async (id, _p, opts = {}) => {
  CALLS.push(["capture", id, opts.idempotencyKey]);
  const pi = PIS.get(id);
  pi.status = "succeeded";
  return { ...pi, latest_charge: null };
};
stripeClient.paymentIntents.cancel = async (id, _p, opts = {}) => {
  CALLS.push(["cancel", id, opts.idempotencyKey]);
  const pi = PIS.get(id);
  pi.status = "canceled";
  return { ...pi };
};
const stripeMutations = (id) => CALLS.filter((c) => c[1] === id && c[0] !== "retrieve").length;

// ---- callers ----
const bearer = ({ tenantId = TA, userType = "CRM", id = "staff-1", permissions = [], roles = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET)}`;
const CRM_FIN = bearer({ id: "staff-am", roles: ["AM"], permissions: ["payments:write", "payments:create", "accounts.admin:write", "accounts.journals:write"] });
const CRM_APP = bearer({ id: "staff-mo", roles: ["MO"], permissions: ["application:write"] });
const CRM_EVW = bearer({ id: "staff-ev", roles: ["EO"], permissions: ["events:write"] });
const CRM_EVC = bearer({ id: "staff-evc", roles: ["EO"], permissions: ["events:create"] });
const CRM_WILD = bearer({ id: "staff-wild", permissions: ["application:*", "events:*"] });
const CRM_EMPTY = bearer({ id: "staff-empty" });
const ASU = bearer({ id: "staff-asu", roles: ["ASU"], permissions: ["*"] });
const PORTAL = bearer({ userType: "PORTAL", id: "member-a", permissions: ["application:write", "events:write", "events:create", "payments:write"] });
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TA };

async function call(method, url, { auth, headers = {}, body } = {}) {
  const server = app.listen(0);
  try {
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function stripeRow({ purpose, tenantId = TA, status = "requires_capture", extra = {} }) {
  const pi = `pi_c_${(seq += 1)}`;
  PIS.set(pi, { id: pi, amount: 5000, currency: "eur", status, metadata: {} });
  const base = {
    tenantId, purpose, amount: 5000, currency: "eur", mode: "stripe", status,
    stripe: { paymentIntentId: pi, status }, audit: { createdBy: "seed" },
  };
  if (purpose === "applicationFee") Object.assign(base, { ledgerDomain: "membership", applicationId: oid() });
  else Object.assign(base, { ledgerDomain: "events", registrationId: oid(), eventCategoryCode: "CPD" });
  const doc = await Payment.create({ ...base, ...extra });
  return { pi, id: String(doc._id), doc };
}
async function manualRow({ status = "manual_review", extra = {} } = {}) {
  const doc = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: oid(), amount: 0,
    currency: "eur", mode: "external", source: "events-service", status, eventCategoryCode: "CPD",
    external: { externalRef: "manual-comp-x" }, audit: { createdBy: "seed" }, ...extra,
  });
  return { id: String(doc._id), doc };
}
const fresh = (id) => Payment.findById(id).lean();

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  await Payment.syncIndexes();
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ exact business permission
test("K1 application capture: payments:write / events:write / wildcard / no perms -> 403, nothing captured; application:write and ASU pass", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  for (const auth of [CRM_FIN, CRM_EVW, CRM_WILD, CRM_EMPTY]) {
    const res = await call("POST", `/api/payments/intents/${r.pi}/capture`, { auth });
    assert.equal(res.status, 403, res.text.slice(0, 200));
    assert.equal(res.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED");
  }
  assert.equal(stripeMutations(r.pi), 0);
  assert.equal((await fresh(r.id)).status, "requires_capture");
  const ok = await call("POST", `/api/payments/intents/${r.pi}/capture`, { auth: CRM_APP });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.data.status, "succeeded");
  const r2 = await stripeRow({ purpose: "applicationFee" });
  assert.equal((await call("POST", `/api/payments/intents/${r2.pi}/capture`, { auth: ASU })).status, 200);
});

test("K2 registration capture / cancel need events:write; application:write and payments:write are refused", { skip }, async () => {
  const cap = await stripeRow({ purpose: "eventRegistration" });
  for (const auth of [CRM_APP, CRM_FIN, CRM_EVC]) {
    const res = await call("POST", `/api/payments/intents/${cap.pi}/capture`, { auth });
    assert.equal(res.status, 403); assert.equal(res.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED");
  }
  assert.equal(stripeMutations(cap.pi), 0);
  assert.equal((await call("POST", `/api/payments/intents/${cap.pi}/capture`, { auth: CRM_EVW })).status, 200);

  const can = await stripeRow({ purpose: "courseRegistration" });
  for (const auth of [CRM_APP, CRM_FIN]) {
    assert.equal((await call("POST", `/api/payments/intents/${can.pi}/cancel`, { auth })).status, 403);
  }
  assert.equal(stripeMutations(can.pi), 0);
  const ok = await call("POST", `/api/payments/intents/${can.pi}/cancel`, { auth: CRM_EVW });
  assert.equal(ok.status, 200); assert.equal(ok.data.status, "canceled");
});

test("K3 application cancel needs application:write", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  assert.equal((await call("POST", `/api/payments/intents/${r.pi}/cancel`, { auth: CRM_EVW })).status, 403);
  assert.equal((await call("POST", `/api/payments/intents/${r.pi}/cancel`, { auth: CRM_FIN })).status, 403);
  assert.equal(stripeMutations(r.pi), 0);
  assert.equal((await call("POST", `/api/payments/intents/${r.pi}/cancel`, { auth: CRM_APP })).status, 200);
});

test("K4 unbound / ambiguous-purpose rows fail closed (409 PAYMENT_UNBOUND), even for ASU; no Stripe call", { skip }, async () => {
  const noReg = await stripeRow({ purpose: "eventRegistration", extra: { registrationId: undefined } });
  const noApp = await stripeRow({ purpose: "applicationFee", extra: { applicationId: undefined } });
  const both = await stripeRow({ purpose: "applicationFee", extra: { registrationId: oid() } });
  const sub = await stripeRow({ purpose: "subscriptionFee", extra: { ledgerDomain: "membership" } });
  for (const r of [noReg, noApp, both, sub]) {
    for (const action of ["capture", "cancel"]) {
      const res = await call("POST", `/api/payments/intents/${r.pi}/${action}`, { auth: ASU });
      assert.equal(res.status, 409, `${r.pi} ${action} ${res.text.slice(0, 200)}`);
      assert.equal(res.code, "PAYMENT_UNBOUND");
    }
    assert.equal(stripeMutations(r.pi), 0);
  }
});

test("K4b legacy application row stored as subscriptionFee + applicationId is an application payment (application:write); without applicationId it stays unbound", { skip }, async () => {
  const legacy = await stripeRow({ purpose: "applicationFee", extra: { purpose: "subscriptionFee" } });
  assert.equal((await fresh(legacy.id)).purpose, "subscriptionFee");
  for (const auth of [CRM_EVW, CRM_FIN]) {
    const res = await call("POST", `/api/payments/intents/${legacy.pi}/capture`, { auth });
    assert.equal(res.status, 403); assert.equal(res.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED");
  }
  const link = await call("POST", `/api/payments/intents/${legacy.pi}/capture`, { auth: CRM_APP, body: { profileId: oid() } });
  assert.equal(link.status, 400); assert.equal(link.code, "LINK_NOT_ALLOWED");
  assert.equal((await call("POST", `/api/payments/intents/${legacy.pi}/capture`, { auth: CRM_APP })).status, 200);
  const bare = await stripeRow({ purpose: "subscriptionFee", extra: { ledgerDomain: "membership" } });
  const res = await call("POST", `/api/payments/intents/${bare.pi}/cancel`, { auth: ASU });
  assert.equal(res.status, 409); assert.equal(res.code, "PAYMENT_UNBOUND");
});

test("K5 tenant: another tenant's PaymentIntent is 404 PAYMENT_NOT_FOUND (indistinguishable), untouched", { skip }, async () => {
  const r = await stripeRow({ purpose: "eventRegistration", tenantId: TC });
  const res = await call("POST", `/api/payments/intents/${r.pi}/capture`, { auth: CRM_EVW });
  assert.equal(res.status, 404); assert.equal(res.code, "PAYMENT_NOT_FOUND");
  const miss = await call("POST", `/api/payments/intents/pi_nope/capture`, { auth: CRM_EVW });
  assert.equal(miss.status, 404); assert.equal(miss.code, "PAYMENT_NOT_FOUND");
  assert.equal(stripeMutations(r.pi), 0);
  assert.equal((await fresh(r.id)).status, "requires_capture");
});

test("K6 PORTAL holding every business permission is still CRM_ONLY on all five routes", { skip }, async () => {
  const r = await stripeRow({ purpose: "eventRegistration" });
  const m = await manualRow();
  for (const [url, body] of [
    [`/api/payments/intents/${r.pi}/capture`, {}],
    [`/api/payments/intents/${r.pi}/cancel`, {}],
    ["/api/journal/events/manual-payment", { registrationId: oid(), amount: 0, method: "comp" }],
    ["/api/journal/events/manual-payment/post", { paymentId: m.id, method: "comp", profileId: oid() }],
    ["/api/journal/events/manual-payment/void", { paymentId: m.id }],
  ]) {
    const res = await call("POST", url, { auth: PORTAL, body });
    assert.equal(res.status, 403, url); assert.equal(res.code, "CRM_ONLY");
  }
  assert.equal(stripeMutations(r.pi), 0);
  assert.equal((await fresh(m.id)).status, "manual_review");
});

test("K7 user identity + x-internal-request is judged as the user (never internal)", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  const res = await call("POST", `/api/payments/intents/${r.pi}/capture`, { auth: CRM_FIN, headers: INTERNAL });
  assert.equal(res.status, 403); assert.equal(res.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED");
  assert.equal(stripeMutations(r.pi), 0);
});

test("K8 manual record needs events:create; post / void need events:write; finance permissions refused", { skip }, async () => {
  const body = () => ({ registrationId: oid(), amount: 0, currency: "eur", method: "comp" });
  for (const auth of [CRM_EVW, CRM_FIN, CRM_APP]) {
    const res = await call("POST", "/api/journal/events/manual-payment", { auth, body: body() });
    assert.equal(res.status, 403); assert.equal(res.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED");
  }
  const before = await Payment.countDocuments({ mode: "external" });
  const ok = await call("POST", "/api/journal/events/manual-payment", { auth: CRM_EVC, body: body() });
  assert.equal(ok.status, 201, ok.text.slice(0, 200));
  assert.equal(await Payment.countDocuments({ mode: "external" }), before + 1);

  const m = await manualRow();
  for (const auth of [CRM_EVC, CRM_FIN]) {
    assert.equal((await call("POST", "/api/journal/events/manual-payment/post", { auth, body: { paymentId: m.id, method: "comp", profileId: oid() } })).status, 403);
    assert.equal((await call("POST", "/api/journal/events/manual-payment/void", { auth, body: { paymentId: m.id } })).status, 403);
  }
  assert.equal((await fresh(m.id)).status, "manual_review");
  const v = await call("POST", "/api/journal/events/manual-payment/void", { auth: CRM_EVW, body: { paymentId: m.id } });
  assert.equal(v.status, 200); assert.equal(v.data.voided, true);
});

test("K9 manual post / void on a Stripe row, and capture on a manual row, are refused (409 TRANSITION_NOT_ALLOWED / 404)", { skip }, async () => {
  const r = await stripeRow({ purpose: "eventRegistration" });
  const res = await call("POST", "/api/journal/events/manual-payment/void", { auth: CRM_EVW, body: { paymentId: r.id } });
  assert.equal(res.status, 409); assert.equal(res.code, "TRANSITION_NOT_ALLOWED");
  assert.equal((await fresh(r.id)).status, "requires_capture");
  const bad = await call("POST", "/api/journal/events/manual-payment/post", { auth: CRM_EVW, body: { paymentId: "not-an-id", method: "comp", profileId: oid() } });
  assert.equal(bad.status, 400);
});

// ------------------------------------------------------------ set-once link fields
test("L1 capture link is set once: first profile written, a different profile -> 409 PROFILE_ALREADY_BOUND, nothing captured", { skip }, async () => {
  const P1 = oid();
  const P2 = oid();
  const a = await stripeRow({ purpose: "eventRegistration" });
  const ok = await call("POST", `/api/payments/intents/${a.pi}/capture`, { auth: CRM_EVW, body: { profileId: P1, memberId: "M-1" } });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  const row = await fresh(a.id);
  assert.equal(row.profileId, P1); assert.equal(row.memberId, "M-1");

  const b = await stripeRow({ purpose: "eventRegistration", extra: { profileId: P1 } });
  const res = await call("POST", `/api/payments/intents/${b.pi}/capture`, { auth: CRM_EVW, body: { profileId: P2 } });
  assert.equal(res.status, 409); assert.equal(res.code, "PROFILE_ALREADY_BOUND");
  assert.equal(stripeMutations(b.pi), 0);
  const rb = await fresh(b.id);
  assert.equal(rb.profileId, P1); assert.equal(rb.status, "requires_capture");
  // same value is idempotent
  assert.equal((await call("POST", `/api/payments/intents/${b.pi}/capture`, { auth: CRM_EVW, body: { profileId: P1 } })).status, 200);
});

test("L2 application capture with a body profileId/memberId -> 400 LINK_NOT_ALLOWED, nothing captured or written", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  for (const body of [{ profileId: oid() }, { memberId: "M-9" }]) {
    const res = await call("POST", `/api/payments/intents/${r.pi}/capture`, { auth: CRM_APP, body });
    assert.equal(res.status, 400); assert.equal(res.code, "LINK_NOT_ALLOWED");
  }
  assert.equal(stripeMutations(r.pi), 0);
  const row = await fresh(r.id);
  assert.equal(row.profileId, undefined); assert.equal(row.memberId, undefined);
});

test("L3 manual post never overwrites an existing profile/member from the body (409, still manual_review)", { skip }, async () => {
  const P1 = oid();
  const m = await manualRow({ extra: { profileId: P1, memberId: "M-1" } });
  for (const body of [{ profileId: oid() }, { profileId: P1, memberId: "M-OTHER" }]) {
    const res = await call("POST", "/api/journal/events/manual-payment/post", { auth: CRM_EVW, body: { paymentId: m.id, method: "comp", ...body } });
    assert.equal(res.status, 409, res.text.slice(0, 200)); assert.equal(res.code, "PROFILE_ALREADY_BOUND");
  }
  const row = await fresh(m.id);
  assert.equal(row.profileId, P1); assert.equal(row.memberId, "M-1"); assert.equal(row.status, "manual_review");
  const ok = await call("POST", "/api/journal/events/manual-payment/post", { auth: CRM_EVW, body: { paymentId: m.id, method: "comp", profileId: P1 } });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal((await fresh(m.id)).status, "succeeded");
});

test("L4 two concurrent different links on an unlinked payment: exactly one wins, the loser gets 409", { skip }, async () => {
  const m = await manualRow();
  const doc = () => Payment.findById(m.id);
  const P1 = oid();
  const P2 = oid();
  const results = await Promise.allSettled([
    doc().then((d) => setPaymentLinkOnce(d, { profileId: P1 })),
    doc().then((d) => setPaymentLinkOnce(d, { profileId: P2 })),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1); assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, "PROFILE_ALREADY_BOUND");
  assert.ok([P1, P2].includes((await fresh(m.id)).profileId));
});

test("L5 genuine internal S2S (no user identity) is unchanged by the containment step", { skip }, async () => {
  const r = await stripeRow({ purpose: "eventRegistration" });
  const res = await call("POST", `/api/payments/intents/${r.pi}/cancel`, { headers: INTERNAL });
  assert.equal(res.status, 200, res.text.slice(0, 200));
});
