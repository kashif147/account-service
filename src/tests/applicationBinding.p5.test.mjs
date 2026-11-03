// P5 b7: authoritative application binding on Payment creation (POST /api/payments/intents),
// over the REAL app router against a REAL throwaway mongod (fake Stripe, stubbed portal-service).
//
//   node --test --test-force-exit src/tests/applicationBinding.p5.test.mjs
//
// A portal application intent is stored with purpose "subscriptionFee" (the portal's own value,
// which subscription-service reads for balances). It becomes an application payment for
// mutation authority ONLY because the intent guard verified the caller's own application and
// the row was written with applicationBinding. A CRM-created row with the same shape gets no
// binding and every mutation fails closed.
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

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-appbind-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.PORTAL_SERVICE_URL = "http://portal.invalid";
process.env.JWT_SECRET = "p5-application-binding-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_appbind";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const APP_ID = "a1a1a1a1a1a1a1a1a1a1a1a1";
const APP_ID2 = "a6a6a6a6a6a6a6a6a6a6a6a6"; // b8: purpose-switch cases
const APP_ID3 = "a7a7a7a7a7a7a7a7a7a7a7a7";
const ANNUAL = 29900;

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-appbind-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/application_binding_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: app } = await import("../app.js");

// ---- fake Stripe ----
let piSeq = 0;
const PIS = new Map();
stripeClient.paymentIntents.create = async (params) => {
  const id = `pi_ab_${(piSeq += 1)}`;
  const pi = { id, client_secret: `${id}_secret_x`, status: "requires_payment_method", amount: params.amount, currency: params.currency, metadata: params.metadata || {}, capture_method: params.capture_method };
  PIS.set(id, pi);
  return { ...pi };
};
stripeClient.paymentIntents.retrieve = async (id) => ({ ...PIS.get(id) });
stripeClient.paymentIntents.capture = async (id) => { const pi = PIS.get(id); pi.status = "succeeded"; return { ...pi, latest_charge: null }; };
stripeClient.paymentIntents.cancel = async (id) => { const pi = PIS.get(id); pi.status = "canceled"; return { ...pi }; };

// ---- stubbed portal-service: the caller's own application (only APP_ID exists) ----
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("http://portal.invalid/api/subscription-details/")) {
    const id = decodeURIComponent(u.split("/").pop());
    if (![APP_ID, APP_ID2, APP_ID3].includes(id)) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({ data: { applicationId: id, subscriptionDetails: { membershipCategory: "General All Grades", paymentType: "Credit Card" } } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, opts);
};

const bearer = ({ userType, id, permissions = [], roles = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId: TA, userType, roles, permissions }, SECRET, { expiresIn: "10m" })}`;
const PORTAL = bearer({ userType: "PORTAL", id: "member-ab", permissions: ["payments:create", "payments:write", "portal:write"] });
const CRM_PAY = bearer({ userType: "CRM", id: "staff-pay", permissions: ["payments:create", "payments:write"] });
const CRM_APP = bearer({ userType: "CRM", id: "staff-mo", roles: ["MO"], permissions: ["application:write"] });

async function call(method, url, { auth, headers = {}, body } = {}) {
  const server = app.listen(0);
  try {
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await realFetch(`http://127.0.0.1:${server.address().port}${url}`, {
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

const intentBody = (applicationId) => ({
  purpose: "subscriptionFee",
  amount: ANNUAL,
  currency: "eur",
  applicationId,
  metadata: { applicationId },
});

test("AB1 portal application intent (guard-verified own application) is stored subscriptionFee WITH applicationBinding", { skip }, async () => {
  const res = await call("POST", "/api/payments/intents", { auth: PORTAL, body: intentBody(APP_ID), headers: { "Idempotency-Key": "ab1-portal-app-intent" } });
  assert.ok(res.status === 200 || res.status === 201, res.text.slice(0, 300));
  const row = await Payment.findOne({ tenantId: TA, applicationId: APP_ID }).sort({ createdAt: -1 }).lean();
  assert.ok(row, "payment row created");
  assert.equal(row.purpose, "subscriptionFee"); // purpose is never rewritten
  assert.equal(row.applicationBinding, APP_ID);
});

test("AB2 portal intent for an application that is not the caller's is refused; nothing written", { skip }, async () => {
  const other = "b2b2b2b2b2b2b2b2b2b2b2b2";
  const res = await call("POST", "/api/payments/intents", { auth: PORTAL, body: intentBody(other) });
  assert.equal(res.status, 404, res.text.slice(0, 200));
  assert.equal(await Payment.countDocuments({ tenantId: TA, applicationId: other }), 0);
});

test("AB3 CRM-created subscriptionFee + applicationId row gets NO binding, so capture/cancel fail closed", { skip }, async () => {
  const appId = "c3c3c3c3c3c3c3c3c3c3c3c3";
  const res = await call("POST", "/api/payments/intents", { auth: CRM_PAY, body: intentBody(appId), headers: { "Idempotency-Key": "ab3-crm-app-intent" } });
  assert.ok(res.status === 200 || res.status === 201, res.text.slice(0, 300));
  const row = await Payment.findOne({ tenantId: TA, applicationId: appId }).lean();
  assert.ok(row);
  assert.equal(row.applicationBinding, undefined);
  const pi = row.stripe.paymentIntentId;
  PIS.get(pi).status = "requires_capture";
  for (const action of ["capture", "cancel"]) {
    const r = await call("POST", `/api/payments/intents/${pi}/${action}`, { auth: CRM_APP });
    assert.equal(r.status, 409, r.text.slice(0, 200));
    assert.equal(r.code, "PAYMENT_APPLICATION_BINDING_UNVERIFIED");
  }
  assert.equal(PIS.get(pi).status, "requires_capture");
});

test("AB4 the bound row from AB1 is capturable with application:write", { skip }, async () => {
  const row = await Payment.findOne({ tenantId: TA, applicationId: APP_ID, applicationBinding: APP_ID }).lean();
  const pi = row.stripe.paymentIntentId;
  PIS.get(pi).status = "requires_capture";
  await Payment.updateOne({ _id: row._id }, { $set: { status: "requires_capture", "stripe.status": "requires_capture" } });
  const r = await call("POST", `/api/payments/intents/${pi}/capture`, { auth: CRM_APP });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.data.status, "succeeded");
});

test("AB5 Stripe reconciliation never creates a Payment and never creates an application binding from metadata", { skip }, async () => {
  const payments = await import("../services/payments.service.js");
  const ev = (pi, metadata) => ({
    eventId: `evt_${pi}`, type: "payment_intent.succeeded",
    payment: { paymentIntentId: pi, amount: ANNUAL, currency: "eur", status: "succeeded", metadata },
  });
  const before = await Payment.countDocuments({});
  // Unknown PaymentIntent, unscoped (webhook) and scoped (HTTP reconcile): nothing is inserted.
  const r1 = await payments.reconcileStripeEvent(ev("pi_ab_unknown", { tenantId: TA, applicationId: APP_ID }), { metadataTenantId: TA });
  assert.deepEqual(r1, { ok: false, rejected: "unknown_payment_intent" });
  await assert.rejects(() => payments.reconcileStripeEvent(ev("pi_ab_unknown2", { applicationId: APP_ID }), { tenantId: TA, scopeToTenantId: TA }));
  assert.equal(await Payment.countDocuments({}), before);
  // Metadata may fill a missing applicationId on an existing row, but that is never a binding.
  const piId = "pi_ab_fill";
  PIS.set(piId, { id: piId, status: "requires_capture", amount: ANNUAL, currency: "eur", metadata: {} });
  const row = await Payment.create({ tenantId: TA, purpose: "subscriptionFee", ledgerDomain: "membership", amount: ANNUAL, currency: "eur", mode: "stripe", status: "requires_action", stripe: { paymentIntentId: piId }, audit: { createdBy: "seed" } });
  await payments.reconcileStripeEvent({ ...ev(piId, { tenantId: TA, applicationId: APP_ID }), type: "payment_intent.amount_capturable_updated", payment: { paymentIntentId: piId, amount: ANNUAL, currency: "eur", status: "requires_capture", metadata: { tenantId: TA, applicationId: APP_ID } } }, { metadataTenantId: TA });
  const after = await Payment.findById(row._id).lean();
  assert.equal(after.applicationId, APP_ID);
  assert.equal(after.applicationBinding, undefined);
  const r = await call("POST", `/api/payments/intents/${piId}/capture`, { auth: CRM_APP });
  assert.equal(r.status, 409); assert.equal(r.code, "PAYMENT_APPLICATION_BINDING_UNVERIFIED");
  assert.equal(PIS.get(piId).status, "requires_capture");
});

test("AB6 an existing unbound attempt reused by a guard-verified portal call adopts the binding; a CRM reuse does not", { skip }, async () => {
  const appId = APP_ID;
  // Legacy-shaped open attempt for the caller's own application, created before applicationBinding.
  const piId = "pi_ab_legacy_reuse";
  PIS.set(piId, { id: piId, client_secret: `${piId}_secret_x`, status: "requires_payment_method", amount: ANNUAL, currency: "eur", metadata: { applicationId: appId } });
  await Payment.updateMany({ tenantId: TA, applicationId: appId }, { $set: { isActiveAttempt: false } });
  const legacy = await Payment.create({ tenantId: TA, purpose: "subscriptionFee", ledgerDomain: "membership", amount: ANNUAL, currency: "eur", mode: "stripe", status: "requires_action", applicationId: appId, attemptNumber: 9, isActiveAttempt: true, stripe: { paymentIntentId: piId, status: "requires_payment_method" }, audit: { createdBy: "seed" } });
  // CRM continuation: no verification -> no binding.
  const crm = await call("POST", "/api/payments/intents", { auth: CRM_PAY, body: intentBody(appId) });
  assert.ok(crm.status === 200 || crm.status === 201, crm.text.slice(0, 200));
  assert.equal((await Payment.findById(legacy._id).lean()).applicationBinding, undefined);
  // Portal continuation for its own application: guard verifies -> the reused row is bound.
  const res = await call("POST", "/api/payments/intents", { auth: PORTAL, body: intentBody(appId) });
  assert.ok(res.status === 200 || res.status === 201, res.text.slice(0, 300));
  // the portal call continued an EXISTING unbound attempt (the legacy row, or the attempt the
  // CRM call left unbound) - it did not create a fresh row
  assert.ok([String(legacy._id), crm.data.id].includes(res.data.id), `reused ${res.data.id}`);
  const bound = await Payment.findById(res.data.id).lean();
  assert.equal(bound.applicationId, appId);
  assert.equal(bound.applicationBinding, appId);
});

// ---- P5 b8: portal switches application intents to the explicit purpose "applicationFee" ----
const appFeeBody = (applicationId, amount = ANNUAL) => ({ purpose: "applicationFee", amount, currency: "eur", applicationId, metadata: { applicationId } });
const activeAttempts = (applicationId) =>
  Payment.find({ tenantId: TA, applicationId, mode: "stripe", isActiveAttempt: { $ne: false } }).lean();

test("AB8 applicationFee portal intent: stored applicationFee with binding (no compatibility exception needed)", { skip }, async () => {
  const appId = APP_ID3;
  const res = await call("POST", "/api/payments/intents", { auth: PORTAL, body: appFeeBody(appId), headers: { "Idempotency-Key": "ab8-appfee" } });
  assert.ok(res.status === 200 || res.status === 201, res.text.slice(0, 300));
  const rows = await activeAttempts(appId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, "applicationFee");
  assert.equal(rows[0].applicationBinding, appId);
  const pi = rows[0].stripe.paymentIntentId;
  PIS.get(pi).status = "requires_capture";
  await Payment.updateOne({ _id: rows[0]._id }, { $set: { status: "requires_capture", "stripe.status": "requires_capture" } });
  const cap = await call("POST", `/api/payments/intents/${pi}/capture`, { auth: CRM_APP });
  assert.equal(cap.status, 200, cap.text.slice(0, 300));
});

test("AB9 switch: an earlier reusable subscriptionFee attempt is REUSED by an applicationFee request (one live intent)", { skip }, async () => {
  const appId = APP_ID2;
  const first = await call("POST", "/api/payments/intents", { auth: PORTAL, body: intentBody(appId), headers: { "Idempotency-Key": "ab9-old-attempt" } });
  assert.ok(first.status === 200 || first.status === 201, first.text.slice(0, 300));
  const [old] = await activeAttempts(appId);
  assert.equal(old.purpose, "subscriptionFee");
  const piCountBefore = PIS.size;
  const second = await call("POST", "/api/payments/intents", { auth: PORTAL, body: appFeeBody(appId), headers: { "Idempotency-Key": "ab9-new-attempt" } });
  assert.ok(second.status === 200 || second.status === 201, second.text.slice(0, 300));
  assert.equal(PIS.size, piCountBefore, "no second PaymentIntent created");
  const live = await activeAttempts(appId);
  assert.equal(live.length, 1);
  assert.equal(String(live[0]._id), String(old._id));
});

test("AB10 switch: a non-reusable earlier subscriptionFee attempt is SUPERSEDED, never left active beside the new one", { skip }, async () => {
  const appId = APP_ID2;
  // different amount -> not reusable -> replacement attempt
  const res = await call("POST", "/api/payments/intents", { auth: PORTAL, body: appFeeBody(appId, ANNUAL), headers: { "Idempotency-Key": "ab10-new" } });
  assert.ok(res.status === 200 || res.status === 201, res.text.slice(0, 300));
  const [prev] = await activeAttempts(appId);
  PIS.get(prev.stripe.paymentIntentId).status = "canceled"; // earlier hold gone at Stripe -> not reusable
  const r2 = await call("POST", "/api/payments/intents", { auth: PORTAL, body: appFeeBody(appId), headers: { "Idempotency-Key": "ab10-replacement" } });
  assert.ok(r2.status === 200 || r2.status === 201, r2.text.slice(0, 300));
  const live = await activeAttempts(appId);
  assert.equal(live.length, 1, "exactly one active attempt across both purposes");
  assert.equal(live[0].purpose, "applicationFee");
  assert.notEqual(String(live[0]._id), String(prev._id));
  const superseded = await Payment.findById(prev._id).lean();
  assert.equal(superseded.isActiveAttempt, false);
});
