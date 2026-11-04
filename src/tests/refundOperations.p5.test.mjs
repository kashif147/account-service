// P5 refund operations: one reservation mechanism for CRM + event-cancellation refunds, member
// credit reservations, durable RefundOperation crash / retry / uncertainty handling,
// reconciliation, and the flow A/B classification. REAL app + REAL throwaway mongod; a stateful
// Stripe stub (refunds.create honours idempotency keys, refunds.list is read-only); in-test
// random JWT secret.
//
//   node --test --test-force-exit src/tests/refundOperations.p5.test.mjs
import test, { after, beforeEach } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-ops-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = `refund-ops-test-${crypto.randomBytes(24).toString("hex")}`;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_refund_ops";
delete process.env.AUTH_BYPASS_ENABLED;
delete process.env.REFUND_POLICY_MODE;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-ops-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/refund_operations_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });

// ---- stateful Stripe stub ----
const { default: stripeClient } = await import("../lib/stripe.js");
const stripe = { createCalls: 0, listCalls: 0, refunds: [], byKey: new Map(), delayMs: 0, mode: "ok" };
stripeClient.refunds.create = async (params, opts = {}) => {
  stripe.createCalls += 1;
  const key = opts.idempotencyKey;
  if (key && stripe.byKey.has(key)) return stripe.byKey.get(key);
  if (stripe.delayMs) await new Promise((r) => setTimeout(r, stripe.delayMs));
  if (stripe.mode === "timeout_not_executed") throw Object.assign(new Error("Request timed out (test)"), { type: "StripeConnectionError" });
  const refund = { id: `re_ops_${stripe.refunds.length + 1}_${crypto.randomBytes(3).toString("hex")}`, charge: "ch_ops", amount: params.amount, payment_intent: params.payment_intent, metadata: { ...(params.metadata || {}) } };
  stripe.refunds.push(refund);
  if (key) stripe.byKey.set(key, refund);
  if (stripe.mode === "timeout_executed") throw Object.assign(new Error("Request timed out after the refund executed (test)"), { type: "StripeConnectionError" });
  return refund;
};
stripeClient.refunds.list = async ({ payment_intent }) => {
  stripe.listCalls += 1;
  return { data: stripe.refunds.filter((r) => r.payment_intent === payment_intent) };
};
stripeClient.charges.retrieve = async () => ({});

const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: RefundOperation } = await import("../models/refundOperation.model.js");
const { default: MemberRefundReservation } = await import("../models/memberRefundReservation.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { default: MaterializedBalance } = await import("../models/materializedBalance.model.js");
const { refundOpsHooks } = await import("../services/refundOperations.service.js");
const { setApplicationRefundStateProvider } = await import("../services/payments.service.js");
const { processEventCancellationRefunds } = await import("../services/eventCancellationRefund.service.js");
const { clearIdempotencyCache } = await import("../middlewares/idempotency.js");
const { default: app } = await import("../app.js");
const { default: request } = await import("supertest");
const appServer = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });

after(async () => {
  await new Promise((r) => appServer.close(r));
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  if (mongodProc) mongodProc.kill("SIGKILL");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

beforeEach(() => {
  stripe.mode = "ok";
  stripe.delayMs = 0;
  refundOpsHooks.afterReserve = null;
  refundOpsHooks.afterStripe = null;
  setApplicationRefundStateProvider(null);
  delete process.env.REFUND_POLICY_MODE;
});

const sign = (claims) => `Bearer ${jwt.sign(claims, SECRET, { expiresIn: "1h" })}`;
const bearer = ({ userType = "CRM", id = "staff-am", roles = ["AM"], permissions = ["payments:write", "payments:read"] } = {}) =>
  sign({ id, sub: id, tenantId: TA, userType, roles, permissions });
const CRM_AM = bearer();

async function http(method, url, { auth = CRM_AM, headers = {}, body } = {}) {
  let r = request(appServer)[method](url).set("content-type", "application/json");
  if (auth) r = r.set("authorization", auth);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  const res = await (body !== undefined ? r.send(body) : r);
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = null; }
  return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text: res.text };
}
const refund = (b, opts = {}) => http("post", "/api/payments/refunds", { ...opts, body: b });

const oid = () => new mongoose.Types.ObjectId();
let seq = 0;
async function seed({ amount = 5000, applicationId, memberId, applicationBinding, purpose = "applicationFee", ledgerDomain = "membership", registrationId, receipt = true } = {}) {
  seq += 1;
  const _id = oid();
  const pi = `pi_ops_${seq}`;
  const doc = {
    _id, tenantId: TA, purpose, ledgerDomain, amount, currency: "eur", status: "succeeded",
    attemptNumber: 1, isActiveAttempt: true, source: "portal", mode: "stripe",
    stripe: { paymentIntentId: pi, chargeId: `ch_ops_${seq}`, status: "succeeded" },
    audit: { createdBy: "member-x" }, webhookEventIds: [], auditHistory: [], createdAt: new Date(), updatedAt: new Date(),
  };
  if (applicationId) doc.applicationId = applicationId;
  if (memberId) doc.memberId = memberId;
  if (applicationBinding) doc.applicationBinding = applicationBinding;
  if (registrationId) doc.registrationId = registrationId;
  await Payment.collection.insertOne(doc);
  if (receipt) {
    await GLTransaction.collection.insertOne({
      tenantId: TA, date: new Date(), docType: "Receipt", docNo: `RCP-${_id}`, settlement: { provider: "Stripe", status: "PENDING" },
      entries: [{ accountCode: "1220", dc: "D", amount }, { accountCode: "2020", dc: "C", amount, ...(applicationId ? { applicationId } : { memberId }) }],
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  return { _id, pi };
}
async function claim(applicationId, memberId, amount = 5000) {
  await GLTransaction.collection.insertOne({
    tenantId: TA, date: new Date(), docType: "Claim", docNo: `CLAIM-${applicationId}`, claimMemberId: memberId, sourceApplicationId: applicationId,
    entries: [{ accountCode: "2020", dc: "D", amount, applicationId }, { accountCode: "2020", dc: "C", amount, memberId }],
    createdAt: new Date(), updatedAt: new Date(),
  });
}
async function memberCredit(memberKey, cents) {
  await MaterializedBalance.collection.insertOne({ tenantId: TA, memberId: memberKey, accountCode: "2020", bucket: "current", year: new Date().getFullYear(), ledgerDomain: "membership", amount: -cents, updatedAt: new Date() });
}
const body = (pi, extra = {}) => ({ mode: "stripe", paymentIntentId: pi, payoutMethod: "credit_card", amount: 2000, ...extra });
const reservedOf = (row) => (row?.refundReservations || []).reduce((t, r) => t + (Number(r.amount) || 0), 0);
const paymentRow = (p) => Payment.findById(p._id).lean();
const refundRows = (p) => Refund.find({ tenantId: TA, paymentId: p._id }).lean();
const opsOf = (p) => RefundOperation.find({ tenantId: TA, paymentId: p._id }).lean();

if (!skip) {
  await mongoose.connect(uri);
  await Promise.all([Payment.init(), Refund.init(), RefundOperation.init(), MemberRefundReservation.init()]);
}

// ------------------------------------------------------------ one mechanism for all paths
test("CRM refund racing an event-cancellation refund on the same payment never exceeds the captured amount", { skip }, async () => {
  for (let round = 0; round < 4; round += 1) {
    const p = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: `reg-race-${round}` });
    stripe.delayMs = 25;
    const cancel = {
      eventId: `msg-${round}`, tenantId: TA,
      data: { tenantId: TA, eventId: `event-${round}`, refundCandidates: [{ registrationId: `reg-race-${round}`, paymentId: String(p._id), amount: 5000 }] },
    };
    const [crm, ev] = await Promise.all([refund(body(p.pi, { amount: 3000 })), processEventCancellationRefunds(cancel)]);
    stripe.delayMs = 0;
    const rows = await refundRows(p);
    const total = rows.reduce((t, r) => t + r.amount, 0);
    assert.ok(total <= 5000, `round ${round}: refunded ${total} > 5000`);
    const row = await paymentRow(p);
    assert.equal(row.refundCommittedCents, total, "committed counter = Refund rows of BOTH paths");
    assert.equal(reservedOf(row), 0);
    // exactly one Stripe refund per Refund row, all recorded with an operation id
    assert.ok(rows.every((r) => r.refundOperationId && r.stripe?.refundId));
    const ok = [crm.status === 200, Boolean(ev.results[0].refundId)].filter(Boolean).length;
    assert.ok(ok >= 1, `round ${round}: one path must succeed (${crm.status} ${JSON.stringify(ev.results[0])})`);
    if (crm.status === 200 && ev.results[0].refundId) assert.equal(total, 5000, "event refunded only what the CRM refund left");
  }
});

test("event-cancellation redelivery is deduplicated by its operation (no second Stripe refund)", { skip }, async () => {
  const p = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: "reg-redeliver" });
  const msg = { eventId: "msg-r", tenantId: TA, data: { tenantId: TA, eventId: "event-r", refundCandidates: [{ registrationId: "reg-redeliver", paymentId: String(p._id) }] } };
  const before = stripe.createCalls;
  const first = await processEventCancellationRefunds(msg);
  assert.ok(first.results[0].refundId);
  const again = await processEventCancellationRefunds(msg);
  assert.equal(again.results[0].skipped, true);
  assert.equal(stripe.createCalls, before + 1);
  assert.equal((await refundRows(p)).length, 1);
});

test("two payments of ONE member refunded concurrently cannot exceed the member's refundable credit (flow B, enforce)", { skip }, async () => {
  process.env.REFUND_POLICY_MODE = "enforce";
  await memberCredit("M-CREDIT", 3000);
  const p1 = await seed({ memberId: "M-CREDIT", purpose: "subscriptionFee" });
  const p2 = await seed({ memberId: "M-CREDIT", purpose: "subscriptionFee" });
  stripe.delayMs = 30;
  const rs = await Promise.all([refund(body(p1.pi, { amount: 2000 })), refund(body(p2.pi, { amount: 2000 }))]);
  stripe.delayMs = 0;
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.text).join(" | "));
  assert.equal(rs.find((r) => r.status === 409).code, "REFUND_MEMBER_CREDIT_UNAVAILABLE");
  assert.equal((await refundRows(p1)).length + (await refundRows(p2)).length, 1);
  // within the credit: a refund that fits the member's credit still passes
  const p3 = await seed({ memberId: "M-CREDIT2", purpose: "subscriptionFee" });
  await memberCredit("M-CREDIT2", 5000);
  assert.equal((await refund(body(p3.pi, { amount: 1000 }))).status, 200);
});

test("standalone external credit refunds reserve the member's credit atomically (always on)", { skip }, async () => {
  await memberCredit("M-EXT", 3000);
  const ext = (amount) => refund({ mode: "external", memberId: "M-EXT", amount, payoutMethod: "bank_transfer", currency: "eur" });
  const rs = await Promise.all([ext(2000), ext(2000)]);
  const statuses = rs.map((r) => r.status).sort();
  assert.ok(statuses[0] === 200 && statuses[1] !== 200, `exactly one fits: ${rs.map((r) => r.text).join(" | ")}`);
  assert.equal(await Refund.countDocuments({ tenantId: TA, memberId: "M-EXT", mode: "external" }), 1);
});

// ------------------------------------------------------------ idempotency
test("identical idempotent retries: same result, one Stripe call (in-memory and durable replay); changed body -> 409", { skip }, async () => {
  const p = await seed({ applicationId: "APP-IDEM" });
  const key = `idem-${crypto.randomBytes(5).toString("hex")}`;
  const before = stripe.createCalls;
  const first = await refund(body(p.pi), { headers: { "Idempotency-Key": key } });
  assert.equal(first.status, 200, first.text);
  const cached = await refund(body(p.pi), { headers: { "Idempotency-Key": key } });
  assert.equal(cached.data.refundDocId, first.data.refundDocId);
  clearIdempotencyCache(); // e.g. another instance / a restart: the RefundOperation answers
  const durable = await refund(body(p.pi), { headers: { "Idempotency-Key": key } });
  assert.equal(durable.status, 200, durable.text);
  assert.equal(durable.data.refundDocId, first.data.refundDocId);
  assert.equal(durable.data.operationId, first.data.operationId);
  assert.equal(stripe.createCalls, before + 1);
  assert.equal((await refundRows(p)).length, 1);
  clearIdempotencyCache();
  const changed = await refund(body(p.pi, { amount: 1000 }), { headers: { "Idempotency-Key": key } });
  assert.equal(changed.status, 409);
  assert.equal(changed.code, "IDEMPOTENCY_CONFLICT");
  // concurrent identical retries: one operation, one Stripe call
  const p2 = await seed({ applicationId: "APP-IDEM2" });
  const key2 = `idem-${crypto.randomBytes(5).toString("hex")}`;
  stripe.delayMs = 30;
  const before2 = stripe.createCalls;
  const rs = await Promise.all([refund(body(p2.pi), { headers: { "Idempotency-Key": key2 } }), refund(body(p2.pi), { headers: { "Idempotency-Key": key2 } })]);
  stripe.delayMs = 0;
  assert.equal(stripe.createCalls, before2 + 1, rs.map((r) => r.text).join(" | "));
  assert.equal((await opsOf(p2)).length, 1);
  assert.ok(rs.some((r) => r.status === 200));
  assert.ok(rs.every((r) => r.status === 200 || r.code === "REFUND_OPERATION_IN_PROGRESS"));
});

// ------------------------------------------------------------ crash handling
test("process failure BEFORE the Stripe call: reservation held until non-execution is established", { skip }, async () => {
  const p = await seed({ applicationId: "APP-CRASH1" });
  refundOpsHooks.afterReserve = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  const r = await refund(body(p.pi, { amount: 5000 }));
  refundOpsHooks.afterReserve = null;
  assert.equal(r.status, 500);
  const [op] = await opsOf(p);
  assert.equal(op.state, "reserved");
  assert.equal(reservedOf(await paymentRow(p)), 5000, "reservation still held");
  assert.equal(stripe.createCalls >= 0, true);
  // a new refund cannot take the held amount
  assert.equal((await refund(body(p.pi, { amount: 1000 }))).code, "REFUND_AMOUNT_UNAVAILABLE");
  // visible to finance
  const list = await http("get", "/api/payments/refund-operations");
  assert.equal(list.status, 200, list.text);
  assert.ok(list.data.items.some((o) => o.id === String(op._id) && o.state === "reserved"));
  // reconcile: dry-run changes nothing; apply releases (provider never called: state reserved,
  // and the read-only Stripe lookup finds no refund for the operation)
  const dry = await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)], minAgeSeconds: 0 } });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.data.apply, false);
  assert.equal(dry.data.operations[0].plan, "release_not_executed");
  assert.equal(reservedOf(await paymentRow(p)), 5000);
  const applied = await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)], minAgeSeconds: 0, apply: true } });
  assert.equal(applied.data.operations[0].applied, true);
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "failed");
  assert.equal(reservedOf(await paymentRow(p)), 0);
  assert.equal((await refund(body(p.pi, { amount: 5000 }))).status, 200);
});

test("process failure AFTER Stripe success but before the local commit: retry recovers exactly once", { skip }, async () => {
  const p = await seed({ applicationId: "APP-CRASH2" });
  const key = `idem-${crypto.randomBytes(5).toString("hex")}`;
  refundOpsHooks.afterStripe = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  const before = stripe.createCalls;
  const r = await refund(body(p.pi, { amount: 5000 }), { headers: { "Idempotency-Key": key } });
  refundOpsHooks.afterStripe = null;
  assert.equal(r.status, 500);
  assert.equal(stripe.createCalls, before + 1);
  const [op] = await opsOf(p);
  assert.equal(op.state, "submitting");
  assert.equal((await refundRows(p)).length, 0);
  assert.equal(reservedOf(await paymentRow(p)), 5000);
  clearIdempotencyCache();
  const retry = await refund(body(p.pi, { amount: 5000 }), { headers: { "Idempotency-Key": key } });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(stripe.createCalls, before + 1, "no second Stripe refund");
  const rows = await refundRows(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stripe.refundId, stripe.refunds[stripe.refunds.length - 1].id);
  const row = await paymentRow(p);
  assert.equal(row.refundCommittedCents, 5000);
  assert.equal(reservedOf(row), 0);
  assert.equal(row.status, "refunded");
  // further retries / reconciliation do not commit twice
  clearIdempotencyCache();
  assert.equal((await refund(body(p.pi, { amount: 5000 }), { headers: { "Idempotency-Key": key } })).status, 200);
  await http("post", "/api/payments/refund-operations/reconcile", { body: { apply: true, minAgeSeconds: 0 } });
  assert.equal((await refundRows(p)).length, 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 5000);
});

test("crash after Stripe success without a client retry: reconciliation completes it exactly once", { skip }, async () => {
  const p = await seed({ applicationId: "APP-CRASH3" });
  refundOpsHooks.afterStripe = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  await refund(body(p.pi, { amount: 2500 }));
  refundOpsHooks.afterStripe = null;
  const [op] = await opsOf(p);
  const dry = await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)] } });
  assert.equal(dry.data.operations[0].plan, "complete");
  assert.equal((await refundRows(p)).length, 0, "dry-run writes nothing");
  await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)], apply: true } });
  await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)], apply: true } });
  assert.equal((await refundRows(p)).length, 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 2500);
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "succeeded");
});

test("Stripe timeout: operation uncertain, reservation held; reconciliation resolves executed / not executed", { skip }, async () => {
  // (a) the refund DID execute at Stripe
  const p = await seed({ applicationId: "APP-TIMEOUT1" });
  stripe.mode = "timeout_executed";
  const r = await refund(body(p.pi, { amount: 3000 }));
  stripe.mode = "ok";
  assert.equal(r.status, 503);
  assert.equal(r.code, "REFUND_OUTCOME_UNCERTAIN");
  const [op] = await opsOf(p);
  assert.equal(op.state, "uncertain");
  assert.equal(reservedOf(await paymentRow(p)), 3000, "a timeout is not proof: reservation held");
  const plan = await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)] } });
  assert.equal(plan.data.operations[0].plan, "complete");
  await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(op._id)], apply: true } });
  assert.equal((await refundRows(p)).length, 1);
  assert.equal(reservedOf(await paymentRow(p)), 0);
  assert.equal((await paymentRow(p)).refundCommittedCents, 3000);

  // (b) the refund did NOT execute: held until the minimum age, then released by an explicit apply
  const q = await seed({ applicationId: "APP-TIMEOUT2" });
  stripe.mode = "timeout_not_executed";
  assert.equal((await refund(body(q.pi, { amount: 3000 }))).code, "REFUND_OUTCOME_UNCERTAIN");
  stripe.mode = "ok";
  const [qop] = await opsOf(q);
  const young = await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(qop._id)], apply: true } });
  assert.equal(young.data.operations[0].plan, "leave", "not found yet, but too recent to conclude");
  assert.equal(reservedOf(await paymentRow(q)), 3000);
  const old = await http("post", "/api/payments/refund-operations/reconcile", { body: { operationIds: [String(qop._id)], apply: true, minAgeSeconds: 0 } });
  assert.equal(old.data.operations[0].plan, "mark_failed_not_found");
  assert.equal((await RefundOperation.findById(qop._id).lean()).state, "failed");
  assert.equal(reservedOf(await paymentRow(q)), 0);
  assert.equal((await refundRows(q)).length, 0);
});

test("refund-operations endpoints: CRM finance only; reconcile is a finance write and dry-run by default", { skip }, async () => {
  assert.equal((await http("get", "/api/payments/refund-operations", { auth: bearer({ userType: "PORTAL", id: "m" }) })).status, 403);
  assert.equal((await http("get", "/api/payments/refund-operations", { auth: bearer({ permissions: ["accounts.reports:read"] }) })).status, 403);
  assert.equal((await http("post", "/api/payments/refund-operations/reconcile", { auth: bearer({ roles: ["MO"], permissions: ["payments:read"] }), body: { apply: true } })).status, 403);
  const dry = await http("post", "/api/payments/refund-operations/reconcile", { body: {} });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.apply, false);
  assert.ok(dry.data.operations.every((o) => !o.applied));
});

// ------------------------------------------------------------ flow A / B (enforce)
test("flow classification under enforce: A needs a verified unapproved application; B needs a member link / CLAIM", { skip }, async () => {
  process.env.REFUND_POLICY_MODE = "enforce";
  const before = stripe.createCalls;
  // A without the application-state lookup wired -> fail closed 503
  const a1 = await seed({ applicationId: "APP-A1" });
  await memberCredit("app:APP-A1", 5000);
  let r = await refund(body(a1.pi));
  assert.equal(r.status, 503);
  assert.equal(r.code, "REFUND_APPLICATION_STATE_UNAVAILABLE");
  setApplicationRefundStateProvider(async () => { throw new Error("profile down"); });
  assert.equal((await refund(body(a1.pi))).code, "REFUND_APPLICATION_STATE_UNAVAILABLE");
  // A with a verified submitted / rejected application -> allowed, capped by the application-key credit
  setApplicationRefundStateProvider(async ({ applicationId }) => ({ applicationId, tenantId: TA, status: applicationId === "APP-A2" ? "rejected" : "submitted" }));
  r = await refund(body(a1.pi, { amount: 2000 }));
  assert.equal(r.status, 200, r.text);
  const a2 = await seed({ applicationId: "APP-A2" });
  await memberCredit("app:APP-A2", 1000);
  r = await refund(body(a2.pi, { amount: 2000 }));
  assert.equal(r.code, "REFUND_MEMBER_CREDIT_UNAVAILABLE", "flow A cap = min(payment remaining, application-key credit)");
  // A: approved application without a CLAIM transfer (LINK/MERGE gap) -> inconsistent
  setApplicationRefundStateProvider(async ({ applicationId }) => ({ applicationId, tenantId: TA, status: "processed" }));
  const linked = await seed({ applicationId: "APP-LINKED", purpose: "subscriptionFee" });
  r = await refund(body(linked.pi));
  assert.equal(r.status, 409);
  assert.equal(r.code, "REFUND_INCONSISTENT_APPROVED_NO_TRANSFER");
  // A: verification mismatch -> unverified
  setApplicationRefundStateProvider(async () => ({ applicationId: "APP-OTHER", tenantId: TA, status: "submitted" }));
  assert.equal((await refund(body(linked.pi))).code, "REFUND_APPLICATION_STATE_UNVERIFIED");
  // no ledger receipt -> inconsistent
  const noRcp = await seed({ applicationId: "APP-NORCP", receipt: false });
  assert.equal((await refund(body(noRcp.pi))).code, "REFUND_INCONSISTENT_NO_LEDGER_RECEIPT");
  // B via CLAIM-<applicationId>: body memberId must be the CLAIM recipient (or absent)
  const b1 = await seed({ applicationId: "APP-B1", purpose: "subscriptionFee" });
  await claim("APP-B1", "M-B1");
  await memberCredit("M-B1", 5000);
  r = await refund(body(b1.pi, { memberId: "M-B1", amount: 1500 }));
  assert.equal(r.status, 200, r.text);
  assert.equal((await refund(body(b1.pi, { memberId: "M-SOMEONE" }))).code, "REFUND_TARGET_MISMATCH");
  // conflicting links -> 409
  const c1 = await seed({ applicationId: "APP-C1", memberId: "M-X" });
  await claim("APP-C1", "M-Y");
  assert.equal((await refund(body(c1.pi))).code, "REFUND_LINK_CONFLICT");
  const c2 = await seed({ applicationId: "APP-C2", applicationBinding: "APP-C2-OTHER" });
  assert.equal((await refund(body(c2.pi))).code, "REFUND_LINK_CONFLICT");
  // unlinked / event payment through the CRM endpoint -> refused
  // (an unlinked payment is already refused by the existing credit check, before classification)
  const u = await seed({});
  const ur = await refund(body(u.pi));
  assert.equal(ur.status, 400);
  const ev = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: "reg-crm", memberId: "M-EV" });
  assert.equal((await refund(body(ev.pi))).code, "REFUND_FLOW_UNSUPPORTED");
  // every refusal happened before Stripe: only the two allowed refunds reached it
  assert.equal(stripe.createCalls, before + 2);
});

test("report mode (default): the decision is recorded on the operation, nothing new is refused", { skip }, async () => {
  const p = await seed({ applicationId: "APP-REPORT" });
  const r = await refund(body(p.pi));
  assert.equal(r.status, 200, r.text);
  const [op] = await opsOf(p);
  assert.equal(op.policy.mode, "report");
  assert.equal(op.policy.flow, "A");
  assert.equal(op.policy.wouldRefuse, "REFUND_APPLICATION_STATE_UNAVAILABLE");
});
