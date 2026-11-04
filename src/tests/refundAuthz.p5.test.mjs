// POST /api/payments/refunds - authorization boundary, payment ownership, remaining-amount and
// concurrency proofs. REAL app (real payment router) + REAL throwaway mongod; Stripe
// refunds.create stubbed and counted (no network, optional delay to force overlap). Identity:
// HS256 tokens signed with a random secret generated in this process.
//
//   node --test --test-force-exit src/tests/refundAuthz.p5.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-authz-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = `refund-authz-test-${crypto.randomBytes(24).toString("hex")}`;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_refund_authz";
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-authz-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/refund_authz_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const stripeRefundCalls = [];
let stripeDelayMs = 0;
stripeClient.refunds.create = async (params, opts = {}) => {
  stripeRefundCalls.push({ params, idempotencyKey: opts.idempotencyKey || null });
  const n = stripeRefundCalls.length; // id fixed at call time (concurrent calls get distinct ids)
  if (stripeDelayMs) await new Promise((r) => setTimeout(r, stripeDelayMs));
  return { id: `re_test_${n}`, charge: params.charge || "ch_test" };
};
const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { default: app } = await import("../app.js");
const { default: request } = await import("supertest");
const appServer = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });

after(async () => {
  await new Promise((r) => appServer.close(r));
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  if (mongodProc) mongodProc.kill("SIGKILL");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

const sign = (claims) => `Bearer ${jwt.sign(claims, SECRET, { expiresIn: "1h" })}`;
const bearer = ({ tenantId = TA, userType = "CRM", id = "staff-am", roles = ["AM"], permissions = ["payments:write"] } = {}) =>
  sign({ id, sub: id, tenantId, userType, roles, permissions });
const CRM_AM = bearer();

async function postRefund(body, { auth = CRM_AM, headers = {} } = {}) {
  let r = request(appServer).post("/api/payments/refunds").set("content-type", "application/json");
  if (auth) r = r.set("authorization", auth);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  const res = await r.send(body);
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = null; }
  return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text: res.text };
}

const oid = () => new mongoose.Types.ObjectId();
let seq = 0;
async function seed({ tenantId = TA, amount = 5000, applicationId, memberId, status = "succeeded" } = {}) {
  seq += 1;
  const _id = oid();
  const pi = `pi_authz_${seq}`;
  const doc = {
    _id, tenantId, purpose: "applicationFee", ledgerDomain: "membership", amount, currency: "eur", status,
    attemptNumber: 1, isActiveAttempt: true, source: "portal", mode: "stripe",
    stripe: { paymentIntentId: pi, chargeId: `ch_authz_${seq}`, status: "succeeded" },
    audit: { createdBy: "member-x" }, webhookEventIds: [], auditHistory: [], createdAt: new Date(), updatedAt: new Date(),
  };
  if (applicationId) doc.applicationId = applicationId;
  if (memberId) doc.memberId = memberId;
  await Payment.collection.insertOne(doc);
  return { _id, pi, charge: `ch_authz_${seq}` };
}
const reservedOf = (row) => (row?.refundReservations || []).reduce((t, r) => t + (Number(r.amount) || 0), 0);
const body = (pi, extra = {}) => ({ mode: "stripe", paymentIntentId: pi, payoutMethod: "credit_card", amount: 5000, ...extra });

async function noMoneyMoved(p, before) {
  assert.equal(stripeRefundCalls.length, before, "stripe.refunds.create not called");
  assert.equal(await Refund.countDocuments({ paymentId: p._id }), 0, "no Refund row");
  const row = await Payment.findById(p._id).lean();
  assert.equal(row.status, "succeeded");
  assert.equal(reservedOf(row), 0, "no reservation left behind");
}

if (!skip) {
  await mongoose.connect(uri);
  await Payment.init();
  await Refund.init();
}

test("permitted CRM finance caller (AM + payments:write) is allowed: one Stripe refund, Refund row, reservation released", { skip }, async () => {
  const p = await seed({ applicationId: "APP-1" });
  const before = stripeRefundCalls.length;
  const r = await postRefund(body(p.pi, { applicationId: "APP-1" }));
  assert.equal(r.status, 200, r.text);
  assert.equal(stripeRefundCalls.length, before + 1);
  assert.equal(await Refund.countDocuments({ paymentId: p._id }), 1);
  const row = await Payment.findById(p._id).lean();
  assert.equal(row.status, "refunded");
  assert.equal(reservedOf(row), 0);
});

test("PORTAL caller is denied even with finance role + permission text in the token", { skip }, async () => {
  const p = await seed({ applicationId: "APP-2" });
  const before = stripeRefundCalls.length;
  const r = await postRefund(body(p.pi), { auth: bearer({ userType: "PORTAL", id: "member-1", roles: ["AM", "ASU"], permissions: ["payments:write", "accounts.admin:write", "*"] }) });
  assert.equal(r.status, 403);
  assert.equal(r.code, "CRM_ONLY");
  await noMoneyMoved(p, before);
});

test("unknown or missing caller type is denied; forged internal headers never authorise a refund", { skip }, async () => {
  const p = await seed({ applicationId: "APP-3" });
  const before = stripeRefundCalls.length;
  const unknown = await postRefund(body(p.pi), { auth: bearer({ userType: "SERVICE", id: "svc" }) });
  assert.equal(unknown.status, 403);
  const missing = await postRefund(body(p.pi), { auth: sign({ id: "nt", sub: "nt", tenantId: TA, roles: ["AM"], permissions: ["payments:write"] }) });
  assert.equal(missing.status, 401);
  const internal = await postRefund(body(p.pi), {
    auth: null,
    headers: { "x-internal-request": "true", "x-tenant-id": TA, "x-user-id": "staff-am", "x-user-type": "CRM", "x-user-roles": "AM", "x-user-permissions": "payments:write" },
  });
  assert.ok(internal.status === 401 || internal.status === 403, `internal: ${internal.status}`);
  const badSig = await postRefund(body(p.pi), { auth: `Bearer ${jwt.sign({ id: "staff-am", sub: "staff-am", tenantId: TA, userType: "CRM", roles: ["AM"], permissions: ["payments:write"] }, "not-the-secret")}` });
  assert.equal(badSig.status, 401);
  // finance role/permission requirement unchanged: CRM without the role, or without the permission
  assert.equal((await postRefund(body(p.pi), { auth: bearer({ roles: ["MO"] }) })).status, 403);
  assert.equal((await postRefund(body(p.pi), { auth: bearer({ permissions: ["payments:read"] }) })).status, 403);
  await noMoneyMoved(p, before);
});

test("cross-tenant and foreign payment ids are denied; body identifiers must match the payment", { skip }, async () => {
  const b = await seed({ tenantId: TB, applicationId: "APP-B" });
  const a = await seed({ applicationId: "APP-A" });
  const a2 = await seed({ applicationId: "APP-A2" });
  const before = stripeRefundCalls.length;
  // tenant-B payment intent / payment id from a tenant-A caller: not found
  assert.equal((await postRefund(body(b.pi))).status, 400);
  assert.equal((await postRefund({ mode: "stripe", paymentId: String(b._id), payoutMethod: "credit_card", amount: 100 })).status, 400);
  // a tenant-B caller cannot refund tenant A's payment
  assert.equal((await postRefund(body(a.pi), { auth: bearer({ tenantId: TB, id: "staff-b" }) })).status, 400);
  // mismatched identifiers next to a real tenant-A payment
  for (const [extra, field] of [
    [{ paymentId: String(a2._id) }, "paymentId"],
    [{ chargeId: "ch_someone_else" }, "chargeId"],
    [{ applicationId: "APP-OTHER" }, "applicationId"],
    [{ memberId: "M-STRANGER" }, "memberId"],
  ]) {
    const r = await postRefund(body(a.pi, extra));
    assert.equal(r.status, 409, `${field}: ${r.text}`);
    assert.equal(r.code, "REFUND_TARGET_MISMATCH");
  }
  assert.equal(stripeRefundCalls.length, before);
  for (const p of [a, a2]) await noMoneyMoved(p, before);
  assert.equal(await Refund.countDocuments({ paymentId: b._id }), 0);
});

test("post-approval member refund: body memberId accepted only when it is the application's CLAIM recipient", { skip }, async () => {
  const p = await seed({ applicationId: "APP-CLAIMED" });
  await GLTransaction.collection.insertOne({
    tenantId: TA, date: new Date(), docType: "Claim", docNo: "CLAIM-APP-CLAIMED", claimMemberId: "M-100",
    entries: [{ accountCode: "2020", dc: "D", amount: 5000, applicationId: "APP-CLAIMED" }, { accountCode: "2020", dc: "C", amount: 5000, memberId: "M-100" }],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const before = stripeRefundCalls.length;
  const wrong = await postRefund(body(p.pi, { memberId: "M-999", amount: 1000 }));
  assert.equal(wrong.status, 409);
  assert.equal(wrong.code, "REFUND_TARGET_MISMATCH");
  assert.equal(stripeRefundCalls.length, before);
  const ok = await postRefund(body(p.pi, { memberId: "M-100", amount: 1000 }));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(stripeRefundCalls.length, before + 1);
});

test("over-refund and previous refunds: remaining amount counts tenant-scoped Refund rows; status is cumulative", { skip }, async () => {
  const p = await seed({ applicationId: "APP-OVER" });
  const before = stripeRefundCalls.length;
  assert.equal((await postRefund(body(p.pi, { amount: 6000 }))).status, 400, "more than captured");
  // a foreign-tenant Refund row for this payment id is never counted
  await Refund.collection.insertOne({ tenantId: TB, paymentId: p._id, mode: "stripe", amount: 4000, currency: "eur", createdAt: new Date() });
  const first = await postRefund(body(p.pi, { amount: 3000 }));
  assert.equal(first.status, 200, first.text);
  assert.equal((await Payment.findById(p._id).lean()).status, "partially_refunded");
  assert.equal((await postRefund(body(p.pi, { amount: 3000 }))).status, 400, "3000 + 3000 > 5000");
  const second = await postRefund(body(p.pi, { amount: 2000 }));
  assert.equal(second.status, 200, second.text);
  const row = await Payment.findById(p._id).lean();
  assert.equal(row.status, "refunded", "status from the cumulative Refund rows, not the last amount");
  assert.equal(reservedOf(row), 0);
  assert.equal(stripeRefundCalls.length, before + 2);
  assert.equal((await postRefund(body(p.pi, { amount: 1 }))).status, 400, "fully refunded");
});

test("two concurrent refunds when only one fits: exactly one succeeds, one 409, one Stripe call", { skip }, async () => {
  const p = await seed({ applicationId: "APP-RACE" });
  const before = stripeRefundCalls.length;
  stripeDelayMs = 60; // keep the first refund in flight while the second arrives
  try {
    const rs = await Promise.all([postRefund(body(p.pi, { amount: 3000 })), postRefund(body(p.pi, { amount: 3000 }))]);
    const statuses = rs.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409], rs.map((r) => r.text).join(" | "));
    assert.equal(rs.find((r) => r.status === 409).code, "REFUND_AMOUNT_UNAVAILABLE");
  } finally {
    stripeDelayMs = 0;
  }
  assert.equal(stripeRefundCalls.length, before + 1);
  assert.equal(await Refund.countDocuments({ tenantId: TA, paymentId: p._id }), 1);
  const row = await Payment.findById(p._id).lean();
  assert.equal(reservedOf(row), 0);
  assert.equal(row.status, "partially_refunded");
});

test("two concurrent refunds that both fit both succeed (no false refusal)", { skip }, async () => {
  const p = await seed({ applicationId: "APP-BOTH" });
  const before = stripeRefundCalls.length;
  stripeDelayMs = 30;
  try {
    const rs = await Promise.all([postRefund(body(p.pi, { amount: 2000 })), postRefund(body(p.pi, { amount: 2000 }))]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200], rs.map((r) => r.text).join(" | "));
  } finally {
    stripeDelayMs = 0;
  }
  assert.equal(stripeRefundCalls.length, before + 2);
  const row = await Payment.findById(p._id).lean();
  assert.equal(reservedOf(row), 0);
  assert.equal(row.status, "partially_refunded");
});

test("idempotent retry (same Idempotency-Key) returns the original result; no second refund", { skip }, async () => {
  const p = await seed({ applicationId: "APP-IDEM" });
  const before = stripeRefundCalls.length;
  const key = `idem-refund-${crypto.randomBytes(6).toString("hex")}`;
  const first = await postRefund(body(p.pi, { amount: 2500 }), { headers: { "Idempotency-Key": key } });
  assert.equal(first.status, 200, first.text);
  const retry = await postRefund(body(p.pi, { amount: 2500 }), { headers: { "Idempotency-Key": key } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.refundDocId, first.data.refundDocId);
  assert.equal(stripeRefundCalls.length, before + 1, "one Stripe refund");
  // P5 revision: the Stripe idempotency key is derived server-side from the RefundOperation id,
  // never the client's key.
  const sent = stripeRefundCalls[stripeRefundCalls.length - 1].idempotencyKey;
  assert.match(sent, /^refundop:[a-f0-9]{24}$/);
  assert.notEqual(sent, key);
  assert.equal(await Refund.countDocuments({ paymentId: p._id }), 1);
});

test("definitive Stripe failure releases the reservation; a later refund still fits", { skip }, async () => {
  const p = await seed({ applicationId: "APP-STRIPEFAIL" });
  const real = stripeClient.refunds.create;
  stripeClient.refunds.create = async () => { throw Object.assign(new Error("charge already refunded (test)"), { type: "StripeInvalidRequestError", statusCode: 400, code: "charge_already_refunded" }); };
  try {
    const r = await postRefund(body(p.pi, { amount: 5000 }));
    assert.equal(r.status, 502, r.text);
    assert.equal(r.code, "REFUND_PROVIDER_REJECTED");
  } finally {
    stripeClient.refunds.create = real;
  }
  let row = await Payment.findById(p._id).lean();
  assert.equal(reservedOf(row), 0);
  assert.equal(row.refundCommittedCents || 0, 0);
  assert.equal(await Refund.countDocuments({ paymentId: p._id }), 0);
  const ok = await postRefund(body(p.pi, { amount: 5000 }));
  assert.equal(ok.status, 200, ok.text);
  row = await Payment.findById(p._id).lean();
  assert.equal(row.refundCommittedCents, 5000);
  assert.equal(reservedOf(row), 0);
});
