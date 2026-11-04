// POST /api/payments/refunds - server-side refund guard for application-linked payments.
// REAL app (real payment router: internalAuth -> requireFinanceWrite -> idempotency -> zod ->
// createRefund) + REAL throwaway mongod; fake profile-service (GET /api/applications/:id);
// Stripe refunds.create stubbed and counted (no network). Identity: HS256 tokens signed with a
// random secret generated in this process.
//
//   node --test --test-force-exit src/tests/refundApplicationGuard.p5.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-guard-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.JWT_SECRET = `refund-guard-test-${crypto.randomBytes(24).toString("hex")}`;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_refund_guard";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TB = "bbbbbbbbbbbbbbbbbbbbbbbb";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-guard-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/refund_application_guard_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const decode = (t) => { try { return jwt.verify(String(t || "").replace(/^Bearer /, ""), SECRET); } catch { return null; } };

// ---- fake profile-service: GET /api/applications/:id ----
const APPS = {
  "APP-APPROVED": { applicationStatus: "processed", membershipNumber: "M-200" },
  "APP-SUBMITTED": { applicationStatus: "submitted" },
  "APP-SUBMITTED-NUM": { applicationStatus: "submitted", membershipNumber: "M-777" }, // number alone never decides
  "APP-REJECTED": { applicationStatus: "rejected" },
  "APP-INPROGRESS": { applicationStatus: "in-progress" },
  "APP-WEIRD": { applicationStatus: "pending-review" },
  "APP-NOSTATUS": {},
};
const profileCalls = [];
const profileSvc = http.createServer((req, res) => {
  const claims = decode(req.headers.authorization);
  profileCalls.push({ url: req.url, tenantHeader: req.headers["x-tenant-id"] || null, tokenTenant: claims?.tenantId || null });
  res.setHeader("content-type", "application/json");
  const m = /^\/api\/applications\/([^/?]+)$/.exec(req.url);
  if (!m) { res.statusCode = 404; return res.end("{}"); }
  const id = decodeURIComponent(m[1]);
  if (id === "APP-500") { res.statusCode = 500; return res.end("{}"); }
  if (id === "APP-WRONGID") return res.end(JSON.stringify({ data: { applicationId: "APP-SOMETHING-ELSE", applicationStatus: "submitted" } }));
  if (id === "APP-OTHERTENANT") return res.end(JSON.stringify({ data: { applicationId: id, applicationStatus: "submitted", tenantId: TB } }));
  const app = APPS[id];
  if (!app) { res.statusCode = 404; return res.end(JSON.stringify({ message: "Application not found" })); }
  return res.end(JSON.stringify({ data: { applicationId: id, ...app } }));
});
await new Promise((r) => profileSvc.listen(0, "127.0.0.1", r));
process.env.PROFILE_SERVICE_URL = `http://127.0.0.1:${profileSvc.address().port}`;

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const stripeRefundCalls = [];
stripeClient.refunds.create = async (params) => {
  stripeRefundCalls.push(params);
  return { id: `re_test_${stripeRefundCalls.length}`, charge: "ch_test" };
};
const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { default: app } = await import("../app.js");
const { default: request } = await import("supertest");
const appServer = app.listen(0, "127.0.0.1"); // explicit IPv4 loopback (see paymentCancelContract.p5)
await new Promise((r) => appServer.once("listening", r));

after(async () => {
  await new Promise((r) => appServer.close(r));
  profileSvc.close();
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  if (mongodProc) mongodProc.kill("SIGKILL");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

const bearer = ({ tenantId = TA, userType = "CRM", id = "staff-am", roles = ["AM"], permissions = ["payments:write"] } = {}) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET, { expiresIn: "1h" })}`;
const CRM_AM = bearer();

async function postRefund(body, auth = CRM_AM) {
  const res = await request(appServer).post("/api/payments/refunds").set("authorization", auth).set("content-type", "application/json").send(body);
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = null; }
  return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text: res.text };
}

// DEV-shaped payment: stripe, succeeded, subscriptionFee, Payment.memberId unset, PENDING GL receipt.
const oid = () => new mongoose.Types.ObjectId();
async function seed(key, { applicationId, memberId, applicationBinding, tenantId = TA } = {}) {
  const _id = oid();
  const doc = {
    _id, tenantId, purpose: "subscriptionFee", ledgerDomain: "membership", amount: 5000, currency: "eur",
    status: "succeeded", attemptNumber: 1, isActiveAttempt: true, source: "portal", mode: "stripe",
    stripe: { paymentIntentId: `pi_${key}`, chargeId: `ch_${key}`, status: "succeeded" },
    audit: { createdBy: "member-x" }, webhookEventIds: [], auditHistory: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  if (applicationId) doc.applicationId = applicationId;
  if (memberId) doc.memberId = memberId;
  if (applicationBinding) doc.applicationBinding = applicationBinding;
  await Payment.collection.insertOne(doc);
  await GLTransaction.collection.insertOne({
    tenantId, date: new Date(), docType: "Receipt", docNo: `RCP-${_id}`, settlement: { provider: "Stripe", status: "PENDING" },
    entries: [
      { accountCode: "1220", dc: "D", amount: 5000 },
      { accountCode: "2020", dc: "C", amount: 5000, ...(applicationId ? { applicationId } : { memberId }) },
    ],
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { _id, pi: `pi_${key}` };
}
const body = (pi, extra = {}) => ({ mode: "stripe", paymentIntentId: pi, payoutMethod: "credit_card", amount: 5000, ...extra });

async function assertRefused(p, r, code) {
  assert.equal(r.status, 409, r.text);
  assert.equal(r.code, code, r.text);
  assert.equal(await Refund.countDocuments({ paymentId: p._id }), 0, "no Refund row");
  const row = await Payment.findById(p._id).lean();
  assert.equal(row.status, "succeeded", "payment status unchanged");
}

if (!skip) {
  await mongoose.connect(uri);
  await Payment.init();
}

test("approved (processed) application -> 409 REFUND_APPLICATION_APPROVED, no Stripe refund, nothing written", { skip }, async () => {
  const p = await seed("approved", { applicationId: "APP-APPROVED" });
  const before = stripeRefundCalls.length;
  profileCalls.length = 0;
  const r = await postRefund(body(p.pi, { applicationId: "APP-APPROVED" }));
  await assertRefused(p, r, "REFUND_APPLICATION_APPROVED");
  assert.equal(stripeRefundCalls.length, before, "stripe.refunds.create not called");
  // the lookup was tenant-scoped with the caller's identity, by the stored application id
  assert.deepEqual(profileCalls.map((c) => c.url), ["/api/applications/APP-APPROVED"]);
  assert.equal(profileCalls[0].tenantHeader, TA);
  assert.equal(profileCalls[0].tokenTenant, TA);
});

test("the request body cannot steer the guard: approved payment + body applicationId of an unapproved app -> still 409", { skip }, async () => {
  const p = await seed("approved2", { applicationId: "APP-APPROVED" });
  const before = stripeRefundCalls.length;
  const r = await postRefund(body(p.pi, { applicationId: "APP-SUBMITTED" }));
  await assertRefused(p, r, "REFUND_APPLICATION_APPROVED");
  assert.equal(stripeRefundCalls.length, before);
});

test("application state not established -> 409 REFUND_APPLICATION_STATE_UNVERIFIED, no Stripe refund", { skip }, async () => {
  for (const id of ["APP-500", "APP-MISSING", "APP-WRONGID", "APP-OTHERTENANT", "APP-WEIRD", "APP-NOSTATUS"]) {
    const p = await seed(`unv-${id}`, { applicationId: id });
    const before = stripeRefundCalls.length;
    const r = await postRefund(body(p.pi));
    await assertRefused(p, r, "REFUND_APPLICATION_STATE_UNVERIFIED");
    assert.equal(stripeRefundCalls.length, before, `${id}: stripe.refunds.create not called`);
  }
  // stored applicationId and applicationBinding disagree -> unverified, without any lookup
  const p = await seed("mismatch", { applicationId: "APP-SUBMITTED", applicationBinding: "APP-APPROVED" });
  profileCalls.length = 0;
  const r = await postRefund(body(p.pi));
  await assertRefused(p, r, "REFUND_APPLICATION_STATE_UNVERIFIED");
  assert.equal(profileCalls.length, 0);
});

test("profile-service unreachable -> refused (fail closed)", { skip }, async () => {
  const p = await seed("down", { applicationId: "APP-SUBMITTED" });
  const saved = process.env.PROFILE_SERVICE_URL;
  process.env.PROFILE_SERVICE_URL = `http://127.0.0.1:${await freePort()}`; // nothing listening
  try {
    const before = stripeRefundCalls.length;
    const r = await postRefund(body(p.pi));
    await assertRefused(p, r, "REFUND_APPLICATION_STATE_UNVERIFIED");
    assert.equal(stripeRefundCalls.length, before);
  } finally {
    process.env.PROFILE_SERVICE_URL = saved;
  }
});

test("genuine unapproved application (submitted / in-progress / rejected) -> existing behaviour: Stripe refund + Refund row", { skip }, async () => {
  for (const id of ["APP-SUBMITTED", "APP-INPROGRESS", "APP-REJECTED", "APP-SUBMITTED-NUM"]) {
    const p = await seed(`ok-${id}`, { applicationId: id });
    const before = stripeRefundCalls.length;
    const r = await postRefund(body(p.pi, { applicationId: id }));
    assert.equal(r.status, 200, `${id}: ${r.text}`);
    assert.equal(stripeRefundCalls.length, before + 1, `${id}: one Stripe refund`);
    assert.equal(stripeRefundCalls[stripeRefundCalls.length - 1].payment_intent, p.pi);
    assert.equal(await Refund.countDocuments({ paymentId: p._id }), 1);
    assert.equal((await Payment.findById(p._id).lean()).status, "refunded");
  }
});

test("payment with no application link (member payment) -> unchanged: no profile lookup, refund proceeds", { skip }, async () => {
  const p = await seed("member", { memberId: "M-5" });
  profileCalls.length = 0;
  const before = stripeRefundCalls.length;
  const r = await postRefund(body(p.pi, { memberId: "M-5" }));
  assert.equal(r.status, 200, r.text);
  assert.equal(stripeRefundCalls.length, before + 1);
  assert.equal(profileCalls.length, 0);
});

test("existing authorization unchanged: no finance role -> 403 before any lookup or Stripe call", { skip }, async () => {
  const p = await seed("norole", { applicationId: "APP-SUBMITTED" });
  profileCalls.length = 0;
  const before = stripeRefundCalls.length;
  const r = await postRefund(body(p.pi), bearer({ roles: ["MO"], permissions: ["payments:write"] }));
  assert.equal(r.status, 403);
  assert.equal(stripeRefundCalls.length, before);
  assert.equal(profileCalls.length, 0);
});
