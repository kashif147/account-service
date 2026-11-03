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
    if (id !== APP_ID) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({ data: { applicationId: APP_ID, subscriptionDetails: { membershipCategory: "General All Grades", paymentType: "Credit Card" } } }), { status: 200, headers: { "content-type": "application/json" } });
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
