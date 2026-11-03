// P5 b10: application payment attempt reuse is scoped to tenant + application, the reused
// intent's clientSecret goes back only to the attempt's effective payer, a superseded attempt is
// never silently reactivated, and a payment-link row is never handed back by createIntent.
// REAL app router against a REAL throwaway mongod (fake Stripe, stubbed portal-service).
//
//   node --test --test-force-exit src/tests/applicationAttemptReuse.p5.test.mjs
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

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-appreuse-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.PORTAL_SERVICE_URL = "http://portal.invalid";
process.env.JWT_SECRET = "p5-application-reuse-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_appreuse";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ANNUAL = 29900;
const MEMBER = "member-ru";
const APPS = {
  tenant: "a1000000000000000000000a",
  other: "a2000000000000000000000a",
  mine: "a3000000000000000000000a",
  legacy: "a4000000000000000000000a",
  superseded: "a5000000000000000000000a",
  link: "a6000000000000000000000a",
  expired: "a7000000000000000000000a",
};

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-appreuse-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/application_reuse_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: app } = await import("../app.js");
const { withholdApplicationAttemptSecret } = await import("../services/payments.service.js");

// ---- fake Stripe ----
let piSeq = 0;
const PIS = new Map();
stripeClient.paymentIntents.create = async (params) => {
  const id = `pi_ru_${(piSeq += 1)}`;
  const pi = { id, client_secret: `${id}_secret_x`, status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: params.metadata || {}, capture_method: params.capture_method };
  PIS.set(id, pi);
  return { ...pi };
};
stripeClient.paymentIntents.retrieve = async (id) => ({ ...PIS.get(id) });
const seedPi = (id, extra = {}) => { PIS.set(id, { id, client_secret: `${id}_secret_x`, status: "requires_payment_method", amount: ANNUAL, currency: "eur", metadata: {}, ...extra }); return id; };
let created = () => piSeq;

// ---- stubbed portal-service: every APPS id is the caller's own application ----
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("http://portal.invalid/api/subscription-details/")) {
    const id = decodeURIComponent(u.split("/").pop());
    if (!Object.values(APPS).includes(id)) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({ data: { applicationId: id, subscriptionDetails: { membershipCategory: "General All Grades", paymentType: "Credit Card" } } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, opts);
};

const bearer = ({ userType, id, permissions = [], roles = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId: TA, userType, roles, permissions }, SECRET, { expiresIn: "10m" })}`;
const PORTAL = bearer({ userType: "PORTAL", id: MEMBER, permissions: ["payments:create", "payments:write", "portal:write"] });
const CRM_PAY = bearer({ userType: "CRM", id: "staff-ru", permissions: ["payments:create", "payments:write"] });

async function call(method, url, { auth, headers = {}, body } = {}) {
  const server = app.listen(0);
  try {
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const addr = server.address();
    const host = addr.family === "IPv6" ? "[::1]" : "127.0.0.1";
    const res = await realFetch(`http://${host}:${addr.port}${url}`, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const db = mongoose.connection.db;
  const productId = "d0d0d0d0d0d0d0d0d0d0d0d0";
  await db.collection("products").insertOne({ _id: productId, tenantId: TA, name: "General All Grades", code: "GENERAL ALL GRADES", productTypeId: "f0f0f0f0f0f0f0f0f0f0f0f0", isActive: true, isDeleted: false, status: "Active" });
  await db.collection("pricings").insertOne({ _id: "e0e0e0e0e0e0e0e0e0e0e0e0", tenantId: TA, productId, currency: "EUR", price: ANNUAL, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, isActive: true, isDeleted: false, status: "Active" });
});
test.after(async () => {
  globalThis.fetch = realFetch;
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) {
    const exited = new Promise((r) => mongodProc.once("exit", r));
    mongodProc.kill("SIGTERM");
    await exited;
  }
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

const body = (applicationId) => ({ purpose: "subscriptionFee", amount: ANNUAL, currency: "eur", applicationId, metadata: { applicationId } });
const active = (tenantId, applicationId) => Payment.find({ tenantId, applicationId, mode: "stripe", isActiveAttempt: { $ne: false } }).lean();
const ok = (r) => assert.ok(r.status === 200 || r.status === 201, r.text.slice(0, 300));
const seedRow = (o) => Payment.create({ purpose: "subscriptionFee", ledgerDomain: "membership", amount: ANNUAL, currency: "eur", mode: "stripe", status: "requires_action", attemptNumber: 1, isActiveAttempt: true, audit: { createdBy: MEMBER }, ...o });

test("RU1 reuse never crosses tenant: a reusable attempt for the same applicationId in another tenant is untouched", { skip }, async () => {
  const pi = seedPi("pi_ru_tenantB");
  const other = await seedRow({ tenantId: TB, applicationId: APPS.tenant, stripe: { paymentIntentId: pi, status: "requires_payment_method" } });
  const n = created();
  const r = await call("POST", "/api/payments/intents", { auth: PORTAL, body: body(APPS.tenant), headers: { "Idempotency-Key": "p5-reuse-ru1" } });
  ok(r);
  assert.equal(created(), n + 1, "a new intent for tenant A");
  assert.notEqual(r.data.id, String(other._id));
  const untouched = await Payment.findById(other._id).lean();
  assert.equal(untouched.isActiveAttempt, true);
  assert.equal(untouched.applicationBinding, undefined);
  assert.equal((await active(TA, APPS.tenant)).length, 1);
});

test("RU2 reuse never crosses application: another application's reusable attempt (same payer) is untouched", { skip }, async () => {
  const pi = seedPi("pi_ru_otherapp");
  const other = await seedRow({ tenantId: TA, applicationId: APPS.other, payer: { userId: MEMBER, userType: "PORTAL" }, stripe: { paymentIntentId: pi, status: "requires_payment_method" } });
  const n = created();
  const r = await call("POST", "/api/payments/intents", { auth: PORTAL, body: body(APPS.mine), headers: { "Idempotency-Key": "p5-reuse-ru2" } });
  ok(r);
  assert.equal(created(), n + 1);
  assert.notEqual(r.data.id, String(other._id));
  assert.equal((await Payment.findById(other._id).lean()).isActiveAttempt, true);
});

test("RU3 legacy attempt (no payer field) reused by a CRM caller: same intent, NO clientSecret; the member gets it", { skip }, async () => {
  const pi = seedPi("pi_ru_legacy");
  const legacy = await seedRow({ tenantId: TA, applicationId: APPS.legacy, stripe: { paymentIntentId: pi, clientSecret: `${pi}_secret_x`, status: "requires_payment_method" } });
  const n = created();
  const crm = await call("POST", "/api/payments/intents", { auth: CRM_PAY, body: body(APPS.legacy), headers: { "Idempotency-Key": "p5-reuse-ru3-crm" } });
  ok(crm);
  assert.equal(created(), n, "no second intent");
  assert.equal(crm.data.id, String(legacy._id));
  assert.equal(crm.data.clientSecret ?? null, null, "member's card secret withheld from CRM");
  assert.ok(!crm.text.includes(`${pi}_secret_x`));
  const row = await Payment.findById(legacy._id).lean();
  assert.equal(row.payer, undefined, "reuse does not rewrite the payer");
  assert.equal(row.applicationBinding, undefined, "a CRM reuse never binds");
  const member = await call("POST", "/api/payments/intents", { auth: PORTAL, body: body(APPS.legacy), headers: { "Idempotency-Key": "p5-reuse-ru3-member" } });
  ok(member);
  assert.equal(member.data.id, String(legacy._id));
  assert.equal(member.data.clientSecret, `${pi}_secret_x`, "the effective payer gets its own secret");
  assert.equal((await active(TA, APPS.legacy)).length, 1);
});

test("RU4 a superseded latest attempt is never silently reactivated: a fresh attempt is created", { skip }, async () => {
  const pi = seedPi("pi_ru_superseded");
  const old = await seedRow({ tenantId: TA, applicationId: APPS.superseded, attemptNumber: 3, isActiveAttempt: false, supersededReason: "amount_or_currency_changed", payer: { userId: MEMBER, userType: "PORTAL" }, stripe: { paymentIntentId: pi, status: "requires_payment_method" } });
  const n = created();
  const r = await call("POST", "/api/payments/intents", { auth: PORTAL, body: body(APPS.superseded), headers: { "Idempotency-Key": "p5-reuse-ru4" } });
  ok(r);
  assert.equal(created(), n + 1, "replacement intent");
  assert.notEqual(r.data.id, String(old._id));
  assert.equal((await Payment.findById(old._id).lean()).isActiveAttempt, false, "still superseded");
  const live = await active(TA, APPS.superseded);
  assert.equal(live.length, 1);
  assert.equal(live[0].attemptNumber, 4);
});

test("RU5 a payment-link attempt is never handed back by createIntent (no secret, no second hold)", { skip }, async () => {
  const pi = seedPi("pi_ru_link");
  const link = await seedRow({ tenantId: TA, applicationId: APPS.link, source: "payment-link", applicationBinding: APPS.link, audit: { createdBy: "staff-ru" }, stripe: { paymentIntentId: pi, clientSecret: `${pi}_secret_x`, status: "requires_payment_method" } });
  const n = created();
  for (const [auth, key] of [[PORTAL, "p5-reuse-ru5-member"], [CRM_PAY, "p5-reuse-ru5-staff"]]) {
    const r = await call("POST", "/api/payments/intents", { auth, body: body(APPS.link), headers: { "Idempotency-Key": key } });
    ok(r);
    assert.equal(r.data.id, String(link._id));
    assert.equal(r.data.clientSecret ?? null, null);
  }
  assert.equal(created(), n, "no second intent");
  assert.equal((await active(TA, APPS.link)).length, 1);
});

test("RU6 an expired authorisation is not reused: superseded, replaced, exactly one active attempt", { skip }, async () => {
  const pi = seedPi("pi_ru_expired", { status: "canceled", cancellation_reason: "expired" });
  const old = await seedRow({ tenantId: TA, applicationId: APPS.expired, payer: { userId: MEMBER, userType: "PORTAL" }, stripe: { paymentIntentId: pi, status: "canceled" } });
  const r = await call("POST", "/api/payments/intents", { auth: PORTAL, body: body(APPS.expired), headers: { "Idempotency-Key": "p5-reuse-ru6" } });
  ok(r);
  assert.notEqual(r.data.id, String(old._id));
  assert.equal((await Payment.findById(old._id).lean()).isActiveAttempt, false);
  assert.equal((await active(TA, APPS.expired)).length, 1);
});

test("RU7 withholdApplicationAttemptSecret: payer-only, legacy createdBy fallback, payment-link always withheld", () => {
  const resp = { clientSecret: "s", checkoutUrl: "u", id: "x" };
  const w = (p, payer) => withholdApplicationAttemptSecret(resp, p, payer).clientSecret;
  assert.equal(w({ payer: { userId: "m1", userType: "PORTAL" } }, { userId: "m1" }), "s");
  assert.equal(w({ payer: { userId: "m1", userType: "PORTAL" } }, { userId: "staff" }), null);
  assert.equal(w({ audit: { createdBy: "m1" } }, { userId: "m1" }), "s");
  assert.equal(w({ audit: { createdBy: "m1" } }, { userId: "staff" }), null);
  assert.equal(w({ source: "payment-link", audit: { createdBy: "staff" } }, { userId: "staff" }), null);
  assert.equal(w({}, { userId: "m1" }), null);
  assert.equal(w({ payer: { userId: "m1" } }, {}), null);
});
