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
const stripe = { createCalls: 0, listCalls: 0, refunds: [], byKey: new Map(), delayMs: 0, mode: "ok", status: "succeeded" };
stripeClient.refunds.create = async (params, opts = {}) => {
  stripe.createCalls += 1;
  const key = opts.idempotencyKey;
  if (key && stripe.byKey.has(key)) return stripe.byKey.get(key);
  if (stripe.delayMs) await new Promise((r) => setTimeout(r, stripe.delayMs));
  if (stripe.mode === "timeout_not_executed") throw Object.assign(new Error("Request timed out (test)"), { type: "StripeConnectionError" });
  const refund = { id: `re_ops_${stripe.refunds.length + 1}_${crypto.randomBytes(3).toString("hex")}`, object: "refund", status: stripe.status, charge: "ch_ops", amount: params.amount, payment_intent: params.payment_intent, metadata: { ...(params.metadata || {}) } };
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
stripeClient.refunds.retrieve = async (id) => {
  const r = stripe.refunds.find((x) => x.id === id);
  if (!r) throw Object.assign(new Error("No such refund"), { type: "StripeInvalidRequestError", statusCode: 404 });
  return { ...r };
};
/** Provider-side status change of a stored refund + the webhook Stripe would send for it. */
async function providerSets(refundId, status, { eventType = "refund.updated", deliver = true } = {}) {
  const r = stripe.refunds.find((x) => x.id === refundId);
  r.status = status;
  if (deliver) await handleRefundEvent({ id: `evt_${refundId}_${status}_${crypto.randomBytes(2).toString("hex")}`, type: eventType, data: { object: { ...r } } });
  return r;
}

const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: RefundOperation } = await import("../models/refundOperation.model.js");
const { default: MemberRefundReservation } = await import("../models/memberRefundReservation.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { default: MaterializedBalance } = await import("../models/materializedBalance.model.js");
const { refundOpsHooks } = await import("../services/refundOperations.service.js");
const { setApplicationRefundStateProvider, setApplicationCreditHoldChecker } = await import("../services/payments.service.js");
const { handleRefundEvent } = await import("../services/stripeLifecycle.service.js");
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
  stripe.status = "succeeded";
  stripe.delayMs = 0;
  refundOpsHooks.afterReserve = null;
  refundOpsHooks.afterStripe = null;
  setApplicationRefundStateProvider(null);
  setApplicationCreditHoldChecker(null);
  delete process.env.REFUND_POLICY_MODE;
  delete process.env.REFUND_OPERATION_LEASE_MS;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortLease = () => { process.env.REFUND_OPERATION_LEASE_MS = "150"; };
const reconcile = (b) => http("post", "/api/payments/refund-operations/reconcile", { body: b });

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
async function seed({ amount = 5000, applicationId, memberId, applicationBinding, purpose = "applicationFee", ledgerDomain = "membership", registrationId, receipt = true, credit, mode = "stripe" } = {}) {
  seq += 1;
  const _id = oid();
  const pi = `pi_ops_${seq}`;
  const doc = {
    _id, tenantId: TA, purpose, ledgerDomain, amount, currency: "eur", status: "succeeded",
    attemptNumber: 1, isActiveAttempt: true, source: "portal", mode,
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
  // the 2020 credit the receipt created, as the GL rollup holds it (credit: 0 -> none)
  const key = memberId || (applicationId ? `app:${applicationId}` : null);
  const c = credit === undefined ? (ledgerDomain === "membership" ? amount : 0) : credit;
  if (key && c > 0) await memberCredit(key, c);
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
  // Chart of accounts so refund journals actually post (and their reversals can be proven).
  const { default: CoA } = await import("../models/coa.model.js");
  for (const [code, type] of [["1200", "Asset"], ["1210", "Asset"], ["1220", "Asset"], ["1400", "Asset"], ["2020", "Liability"], ["4500", "Income"], ["4510", "Income"], ["4520", "Income"], ["5100", "Expense"]]) {
    await CoA.create({ tenantId: TA, code, description: `acct ${code}`, type });
  }
}

// ======================================================= one balance mechanism for every path
test("coverage: CRM refund racing an event-cancellation refund on one payment never exceeds the captured amount", { skip }, async () => {
  for (let round = 0; round < 4; round += 1) {
    const p = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: `reg-race-${round}`, memberId: `M-EVRACE-${round}`, credit: 5000 });
    stripe.delayMs = 25;
    const cancel = { eventId: `msg-${round}`, tenantId: TA, data: { tenantId: TA, eventId: `event-${round}`, refundCandidates: [{ registrationId: `reg-race-${round}`, paymentId: String(p._id), amount: 5000 }] } };
    const [crm, ev] = await Promise.all([refund(body(p.pi, { amount: 3000 })), processEventCancellationRefunds(cancel)]);
    stripe.delayMs = 0;
    assert.equal(crm.code, "REFUND_FLOW_UNSUPPORTED", "CRM refunds of event payments are refused in every mode");
    assert.ok(ev.results[0].refundId, "the event accounting path refunds it");
    const rows = await refundRows(p);
    const total = rows.reduce((t, r) => t + r.amount, 0);
    assert.ok(total <= 5000, `round ${round}: refunded ${total} > 5000`);
    const row = await paymentRow(p);
    assert.equal(row.refundCommittedCents, total, "one counter for both paths");
    assert.equal(reservedOf(row), 0);
    assert.equal(stripe.refunds.filter((r) => r.payment_intent === p.pi).length, rows.length, "one Stripe refund per Refund row");
    assert.ok(crm.status === 200 || ev.results[0].refundId, `round ${round}: one path succeeds`);
  }
});

test("coverage: event-cancellation redelivery is deduplicated by its operation (no second Stripe refund)", { skip }, async () => {
  const p = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: "reg-redeliver" });
  const msg = { eventId: "msg-r", tenantId: TA, data: { tenantId: TA, eventId: "event-r", refundCandidates: [{ registrationId: "reg-redeliver", paymentId: String(p._id) }] } };
  const before = stripe.createCalls;
  assert.ok((await processEventCancellationRefunds(msg)).results[0].refundId);
  assert.equal((await processEventCancellationRefunds(msg)).results[0].skipped, true);
  assert.equal(stripe.createCalls, before + 1);
  assert.equal((await refundRows(p)).length, 1);
});

test("coverage: event-cancellation refunds consume the event payment, never member credit (no member reservation)", { skip }, async () => {
  // Event money is recognised as event income (RCP-EVT -> POA 2020/events -> AR 1400 -> income);
  // its refund reverses income (DR income / CR clearing). A member with NO credit is still refunded.
  const p = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: "reg-nocredit", memberId: "M-EV-NOCREDIT", credit: 0 });
  const out = await processEventCancellationRefunds({ eventId: "msg-nc", tenantId: TA, data: { tenantId: TA, eventId: "event-nc", refundCandidates: [{ registrationId: "reg-nocredit", paymentId: String(p._id) }] } });
  assert.ok(out.results[0].refundId, JSON.stringify(out.results[0]));
  assert.equal(await MemberRefundReservation.countDocuments({ tenantId: TA, memberKey: "M-EV-NOCREDIT" }), 0);
  const [op] = await opsOf(p);
  assert.equal(op.memberKey, null);
  assert.equal((await paymentRow(p)).refundCommittedCents, 5000);
});

test("coverage: payment-linked Stripe refunds of two payments of ONE member cannot exceed the member's credit (always on)", { skip }, async () => {
  const p1 = await seed({ memberId: "M-CREDIT", purpose: "subscriptionFee", credit: 0 });
  const p2 = await seed({ memberId: "M-CREDIT", purpose: "subscriptionFee", credit: 0 });
  await memberCredit("M-CREDIT", 3000);
  stripe.delayMs = 30;
  const rs = await Promise.all([refund(body(p1.pi, { amount: 2000 })), refund(body(p2.pi, { amount: 2000 }))]);
  stripe.delayMs = 0;
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.text).join(" | "));
  assert.equal(rs.find((r) => r.status === 409).code, "REFUND_MEMBER_CREDIT_UNAVAILABLE");
  assert.equal((await refundRows(p1)).length + (await refundRows(p2)).length, 1);
});

test("coverage: payment-linked EXTERNAL refunds and Stripe GL-only refunds reserve the same member credit", { skip }, async () => {
  const e1 = await seed({ memberId: "M-MIX", purpose: "subscriptionFee", mode: "external", credit: 0 });
  const s1 = await seed({ memberId: "M-MIX", purpose: "subscriptionFee", credit: 0 });
  await memberCredit("M-MIX", 3000);
  const external = refund({ mode: "external", paymentId: String(e1._id), payoutMethod: "bank_transfer", amount: 2000 });
  const glOnly = refund({ mode: "stripe", paymentId: String(s1._id), payoutMethod: "bank_transfer", amount: 2000 }); // no paymentIntentId: no Stripe call
  const rs = await Promise.all([external, glOnly]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.text).join(" | "));
  assert.equal(rs.find((r) => r.status === 409).code, "REFUND_MEMBER_CREDIT_UNAVAILABLE");
});

test("coverage: flow A application-key credit is a cap in report mode too; flow B member credit likewise", { skip }, async () => {
  const a = await seed({ applicationId: "APP-CAP-A", credit: 1000 });
  const r = await refund(body(a.pi, { amount: 2000 }));
  assert.equal(r.status, 409);
  assert.equal(r.code, "REFUND_MEMBER_CREDIT_UNAVAILABLE");
  const b = await seed({ applicationId: "APP-CAP-B", credit: 0 });
  await claim("APP-CAP-B", "M-CAP-B");
  await memberCredit("M-CAP-B", 1000);
  assert.equal((await refund(body(b.pi, { amount: 2000 }))).code, "REFUND_MEMBER_CREDIT_UNAVAILABLE");
  assert.equal((await refund(body(b.pi, { amount: 1000 }))).status, 200);
});

test("coverage: standalone external credit refunds reserve the member's credit atomically", { skip }, async () => {
  await memberCredit("M-EXT", 3000);
  const ext = (amount) => refund({ mode: "external", memberId: "M-EXT", amount, payoutMethod: "bank_transfer", currency: "eur" });
  const rs = await Promise.all([ext(2000), ext(2000)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.text).join(" | "));
});

test("coverage: record-external 'out' consumes no balance (Refund row only, no payment, no GL)", { skip }, async () => {
  const glBefore = await GLTransaction.countDocuments({ tenantId: TA });
  const r = await http("post", "/api/payments/record-external", { body: { direction: "out", amount: 700, currency: "eur", reason: "test" } });
  assert.equal(r.status, 200, r.text);
  const row = await Refund.findById(r.data.refundId).lean();
  assert.equal(row.paymentId ?? null, null);
  assert.equal(row.memberId ?? null, null);
  assert.equal(row.applicationId ?? null, null);
  assert.equal(await GLTransaction.countDocuments({ tenantId: TA }), glBefore, "no journal posted");
});

// ======================================================= out-of-band Stripe refunds (webhook)
test("webhook: a dashboard refund is recorded once (per Stripe refund id) and reduces the refundable balance", { skip }, async () => {
  const p = await seed({ applicationId: "APP-DASH" });
  const dash = { id: "re_dashboard_1", object: "refund", amount: 2000, status: "succeeded", charge: "ch_x", payment_intent: p.pi, metadata: {} };
  const event = { id: "evt_dash_1", type: "charge.refunded", data: { object: { object: "charge", id: "ch_x", payment_intent: p.pi, amount: 5000, amount_captured: 5000, amount_refunded: 2000, refunds: { data: [dash], has_more: false }, metadata: {} } } };
  await handleRefundEvent(event);
  await handleRefundEvent({ ...event, id: "evt_dash_1_redelivery" });
  const rows = await refundRows(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stripe.refundId, "re_dashboard_1");
  assert.equal((await paymentRow(p)).refundCommittedCents, 2000);
  const over = await refund(body(p.pi, { amount: 4000 }));
  assert.equal(over.status, 400, "payment remaining is 3000, not 5000 (remaining-amount check counts the observed refund)");
  assert.equal((await refund(body(p.pi, { amount: 3000 }))).status, 200);
});

test("webhook: our own refund reported by the provider completes its operation (no duplicate observed record)", { skip }, async () => {
  const p = await seed({ applicationId: "APP-OWNWH" });
  stripe.mode = "timeout_executed";
  assert.equal((await refund(body(p.pi, { amount: 2500 }))).code, "REFUND_OUTCOME_UNCERTAIN");
  stripe.mode = "ok";
  const ours = stripe.refunds.find((r) => r.payment_intent === p.pi);
  await handleRefundEvent({ id: "evt_own", type: "charge.refunded", data: { object: { object: "charge", id: "ch_own", payment_intent: p.pi, amount: 5000, amount_captured: 5000, amount_refunded: 2500, refunds: { data: [{ ...ours, status: "succeeded" }], has_more: false }, metadata: {} } } });
  const [op] = await opsOf(p);
  assert.equal(op.state, "succeeded");
  assert.equal((await refundRows(p)).length, 1);
  assert.equal(await RefundOperation.countDocuments({ tenantId: TA, paymentId: p._id }), 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 2500);
});

// ======================================================= idempotency
test("idempotency: identical retries return the same result with one Stripe call (in-memory and durable); changed body -> 409", { skip }, async () => {
  const p = await seed({ applicationId: "APP-IDEM" });
  const key = `idem-${crypto.randomBytes(5).toString("hex")}`;
  const before = stripe.createCalls;
  const first = await refund(body(p.pi), { headers: { "Idempotency-Key": key } });
  assert.equal(first.status, 200, first.text);
  assert.equal((await refund(body(p.pi), { headers: { "Idempotency-Key": key } })).data.refundDocId, first.data.refundDocId);
  clearIdempotencyCache();
  const durable = await refund(body(p.pi), { headers: { "Idempotency-Key": key } });
  assert.equal(durable.data.operationId, first.data.operationId);
  assert.equal(stripe.createCalls, before + 1);
  clearIdempotencyCache();
  assert.equal((await refund(body(p.pi, { amount: 1000 }), { headers: { "Idempotency-Key": key } })).code, "IDEMPOTENCY_CONFLICT");
  const p2 = await seed({ applicationId: "APP-IDEM2" });
  const key2 = `idem-${crypto.randomBytes(5).toString("hex")}`;
  stripe.delayMs = 30;
  const before2 = stripe.createCalls;
  const rs = await Promise.all([refund(body(p2.pi), { headers: { "Idempotency-Key": key2 } }), refund(body(p2.pi), { headers: { "Idempotency-Key": key2 } })]);
  stripe.delayMs = 0;
  assert.equal(stripe.createCalls, before2 + 1, rs.map((r) => r.text).join(" | "));
  assert.equal((await opsOf(p2)).length, 1);
  assert.ok(rs.every((r) => r.status === 200 || r.code === "REFUND_OPERATION_IN_PROGRESS"));
});

// ======================================================= fencing / crash / reconciliation
test("fencing: a worker paused before its Stripe call loses the operation to reconciliation and never calls Stripe", { skip }, async () => {
  shortLease();
  const p = await seed({ applicationId: "APP-PAUSE" });
  let resume;
  const paused = new Promise((r) => { resume = r; });
  let reachedPause;
  const atPause = new Promise((r) => { reachedPause = r; });
  refundOpsHooks.afterReserve = async () => { reachedPause(); await paused; };
  const before = stripe.createCalls;
  const inflight = refund(body(p.pi, { amount: 5000 }));
  await atPause;
  await sleep(250); // the worker's lease expires while it is paused
  const [op] = await opsOf(p);
  assert.equal(op.state, "reserved");
  const rec = await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal(rec.data.operations[0].plan, "release_never_submitted");
  assert.equal(rec.data.operations[0].applied, true);
  resume();
  const r = await inflight;
  refundOpsHooks.afterReserve = null;
  assert.equal(r.status, 409, r.text);
  assert.equal(r.code, "REFUND_OPERATION_SUPERSEDED");
  assert.equal(stripe.createCalls, before, "the fenced-off worker never called Stripe");
  const after = await RefundOperation.findById(op._id).lean();
  assert.equal(after.state, "failed");
  assert.equal(after.error.evidence, "never_submitted_fenced");
  assert.equal(reservedOf(await paymentRow(p)), 0);
});

test("crash BEFORE the Stripe call: held while the lease lives; released only by a fenced reconcile", { skip }, async () => {
  shortLease();
  const p = await seed({ applicationId: "APP-CRASH1" });
  refundOpsHooks.afterReserve = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  assert.equal((await refund(body(p.pi, { amount: 5000 }))).status, 500);
  refundOpsHooks.afterReserve = null;
  const [op] = await opsOf(p);
  assert.equal(op.state, "reserved");
  assert.equal(reservedOf(await paymentRow(p)), 5000);
  assert.equal((await refund(body(p.pi, { amount: 1000 }))).code, "REFUND_AMOUNT_UNAVAILABLE");
  const listed = await http("get", "/api/payments/refund-operations");
  assert.ok(listed.data.items.some((o) => o.id === String(op._id) && o.state === "reserved"));
  assert.equal((await reconcile({ operationIds: [String(op._id)], apply: true })).data.operations[0].plan, "leave_owned", "live lease: untouched");
  await sleep(250);
  const dry = await reconcile({ operationIds: [String(op._id)] });
  assert.equal(dry.data.operations[0].plan, "release_never_submitted");
  assert.equal(reservedOf(await paymentRow(p)), 5000, "dry-run writes nothing");
  await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal(reservedOf(await paymentRow(p)), 0);
  assert.equal((await refund(body(p.pi, { amount: 5000 }))).status, 200);
});

test("worker restart after Stripe success (response never recorded): a new reconciler completes it exactly once", { skip }, async () => {
  shortLease();
  const p = await seed({ applicationId: "APP-RESTART" });
  refundOpsHooks.afterStripe = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  assert.equal((await refund(body(p.pi, { amount: 2500 }))).status, 500);
  refundOpsHooks.afterStripe = null;
  const [op] = await opsOf(p);
  assert.equal(op.state, "submitting");
  assert.equal(stripe.refunds.filter((r) => r.payment_intent === p.pi).length, 1);
  await sleep(250); // the crashed worker's lease expires
  const dry = await reconcile({ operationIds: [String(op._id)] });
  assert.equal(dry.data.operations[0].plan, "replay_idempotent_create");
  assert.equal(dry.data.operations[0].providerRefundFound, true);
  await reconcile({ operationIds: [String(op._id)], apply: true });
  await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal(stripe.refunds.filter((r) => r.payment_intent === p.pi).length, 1, "the idempotent replay returned the original refund");
  assert.equal((await refundRows(p)).length, 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 2500);
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "succeeded");
});

test("identical client retry after a crash recovers through the idempotent replay (one refund at Stripe)", { skip }, async () => {
  shortLease();
  const p = await seed({ applicationId: "APP-CRASH2" });
  const key = `idem-${crypto.randomBytes(5).toString("hex")}`;
  refundOpsHooks.afterStripe = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  assert.equal((await refund(body(p.pi, { amount: 5000 }), { headers: { "Idempotency-Key": key } })).status, 500);
  refundOpsHooks.afterStripe = null;
  clearIdempotencyCache();
  assert.equal((await refund(body(p.pi, { amount: 5000 }), { headers: { "Idempotency-Key": key } })).code, "REFUND_OPERATION_IN_PROGRESS", "live lease");
  await sleep(250);
  const retry = await refund(body(p.pi, { amount: 5000 }), { headers: { "Idempotency-Key": key } });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(stripe.refunds.filter((r) => r.payment_intent === p.pi).length, 1);
  const row = await paymentRow(p);
  assert.equal(row.refundCommittedCents, 5000);
  assert.equal(row.status, "refunded");
});

test("response loss (Stripe executed, the response was lost): uncertain + held, idempotent replay completes it once", { skip }, async () => {
  const p = await seed({ applicationId: "APP-LOST" });
  stripe.mode = "timeout_executed";
  const r = await refund(body(p.pi, { amount: 3000 }));
  stripe.mode = "ok";
  assert.equal(r.code, "REFUND_OUTCOME_UNCERTAIN");
  const [op] = await opsOf(p);
  assert.equal(op.state, "uncertain");
  assert.equal(reservedOf(await paymentRow(p)), 3000, "a timeout is not proof: reservation held");
  const rec = await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal(rec.data.operations[0].plan, "replay_idempotent_create");
  assert.equal(rec.data.operations[0].outcome, "succeeded");
  assert.equal(stripe.refunds.filter((x) => x.payment_intent === p.pi).length, 1);
  assert.equal((await refundRows(p)).length, 1);
  assert.equal(reservedOf(await paymentRow(p)), 0);
});

test("timeout where Stripe did NOT execute: never released on absence; the idempotent replay executes it once", { skip }, async () => {
  const p = await seed({ applicationId: "APP-NOTEXEC" });
  stripe.mode = "timeout_not_executed";
  assert.equal((await refund(body(p.pi, { amount: 3000 }))).code, "REFUND_OUTCOME_UNCERTAIN");
  stripe.mode = "ok";
  const [op] = await opsOf(p);
  const dry = await reconcile({ operationIds: [String(op._id)] });
  assert.equal(dry.data.operations[0].providerRefundFound, false);
  assert.equal(dry.data.operations[0].plan, "replay_idempotent_create", "absence is not a release plan");
  assert.equal(reservedOf(await paymentRow(p)), 3000);
  await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal(stripe.refunds.filter((x) => x.payment_intent === p.pi).length, 1);
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "succeeded");
});

test("outside Stripe's idempotency window: not found stays uncertain (manual review); release needs actor + evidence, audited", { skip }, async () => {
  const p = await seed({ applicationId: "APP-OLD" });
  stripe.mode = "timeout_not_executed";
  await refund(body(p.pi, { amount: 3000 }));
  stripe.mode = "ok";
  const [op] = await opsOf(p);
  await RefundOperation.updateOne({ _id: op._id }, { $set: { submittedAt: new Date(Date.now() - 25 * 3600 * 1000) } });
  const before = stripe.createCalls;
  const rec = await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal(rec.data.operations[0].plan, "lookup_or_review");
  assert.equal(rec.data.operations[0].outcome, "REFUND_OPERATION_NEEDS_REVIEW");
  assert.equal(stripe.createCalls, before, "no create replay outside the window");
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "uncertain");
  assert.equal(reservedOf(await paymentRow(p)), 3000);
  const noEvidence = await http("post", `/api/payments/refund-operations/${op._id}/release`, { body: {} });
  assert.equal(noEvidence.status, 400);
  assert.equal((await http("post", `/api/payments/refund-operations/${op._id}/release`, { auth: bearer({ roles: ["MO"] }), body: { evidence: "checked stripe dashboard" } })).status, 403);
  const rel = await http("post", `/api/payments/refund-operations/${op._id}/release`, { body: { evidence: "Stripe dashboard shows no refund for this PI (ticket FIN-123)" } });
  assert.equal(rel.status, 200, rel.text);
  const after = await RefundOperation.findById(op._id).lean();
  assert.equal(after.state, "failed");
  assert.equal(after.error.appCode, "REFUND_RELEASED_BY_FINANCE");
  assert.equal(after.error.releasedBy, "staff-am");
  assert.ok(after.history.some((h) => h.note === "manual_release" && h.actor === "staff-am"));
  assert.equal(reservedOf(await paymentRow(p)), 0);
});

test("manual release is refused while the provider shows a refund for the operation", { skip }, async () => {
  const p = await seed({ applicationId: "APP-NORELEASE" });
  stripe.mode = "timeout_executed";
  await refund(body(p.pi, { amount: 3000 }));
  stripe.mode = "ok";
  const [op] = await opsOf(p);
  const rel = await http("post", `/api/payments/refund-operations/${op._id}/release`, { body: { evidence: "trying to release an executed refund" } });
  assert.equal(rel.status, 409);
  assert.equal(rel.code, "REFUND_EXISTS_AT_PROVIDER");
});

test("concurrent reconciliation: two reconcilers, exactly one acts", { skip }, async () => {
  const p = await seed({ applicationId: "APP-TWOREC" });
  stripe.mode = "timeout_executed";
  await refund(body(p.pi, { amount: 2000 }));
  stripe.mode = "ok";
  const [op] = await opsOf(p);
  stripe.delayMs = 40;
  const [r1, r2] = await Promise.all([reconcile({ operationIds: [String(op._id)], apply: true }), reconcile({ operationIds: [String(op._id)], apply: true })]);
  stripe.delayMs = 0;
  const rows = [r1.data.operations[0], r2.data.operations[0]];
  assert.equal(rows.filter((x) => x.outcome === "succeeded").length, 1, JSON.stringify(rows));
  assert.ok(rows.some((x) => x.plan === "claimed_elsewhere" || x.plan === "leave_owned" || x.plan === "finalize"), JSON.stringify(rows));
  assert.equal((await refundRows(p)).length, 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 2000);
});

test("definitive provider error on submission or replay: failed and released (proof of non-execution)", { skip }, async () => {
  const p = await seed({ applicationId: "APP-DEFINITE" });
  const real = stripeClient.refunds.create;
  stripeClient.refunds.create = async () => { throw Object.assign(new Error("invalid (test)"), { type: "StripeInvalidRequestError", statusCode: 400 }); };
  try {
    assert.equal((await refund(body(p.pi, { amount: 1000 }))).code, "REFUND_PROVIDER_REJECTED");
  } finally {
    stripeClient.refunds.create = real;
  }
  const [op] = await opsOf(p);
  assert.equal(op.state, "failed");
  assert.equal(reservedOf(await paymentRow(p)), 0);
});

test("refund-operations endpoints: CRM finance only; reconcile and release are finance writes; dry-run by default", { skip }, async () => {
  assert.equal((await http("get", "/api/payments/refund-operations", { auth: bearer({ userType: "PORTAL", id: "m" }) })).status, 403);
  assert.equal((await http("get", "/api/payments/refund-operations", { auth: bearer({ permissions: ["accounts.reports:read"] }) })).status, 403);
  assert.equal((await reconcile({ apply: true }).then(() => http("post", "/api/payments/refund-operations/reconcile", { auth: bearer({ roles: ["MO"], permissions: ["payments:read"] }), body: { apply: true } }))).status, 403);
  const dry = await reconcile({});
  assert.equal(dry.data.apply, false);
  assert.ok(dry.data.operations.every((o) => !o.applied));
});

// ======================================================= flow A / B
test("flow (enforce): A needs a verified unapproved application; approved-without-CLAIM and no-RCP are inconsistent; B by member link / CLAIM", { skip }, async () => {
  process.env.REFUND_POLICY_MODE = "enforce";
  const before = stripe.createCalls;
  const a1 = await seed({ applicationId: "APP-A1" });
  assert.equal((await refund(body(a1.pi))).code, "REFUND_APPLICATION_STATE_UNAVAILABLE");
  setApplicationRefundStateProvider(async () => { throw new Error("profile down"); });
  assert.equal((await refund(body(a1.pi))).code, "REFUND_APPLICATION_STATE_UNAVAILABLE");
  setApplicationRefundStateProvider(async ({ applicationId }) => ({ applicationId, tenantId: TA, status: applicationId === "APP-A2" ? "rejected" : "submitted" }));
  assert.equal((await refund(body(a1.pi, { amount: 2000 }))).status, 200);
  const a2 = await seed({ applicationId: "APP-A2" });
  assert.equal((await refund(body(a2.pi, { amount: 2000 }))).status, 200, "rejected application: flow A");
  setApplicationRefundStateProvider(async ({ applicationId }) => ({ applicationId, tenantId: TA, status: "processed" }));
  const linked = await seed({ applicationId: "APP-LINKED", purpose: "subscriptionFee" });
  assert.equal((await refund(body(linked.pi))).code, "REFUND_INCONSISTENT_APPROVED_NO_TRANSFER");
  setApplicationRefundStateProvider(async () => ({ applicationId: "APP-OTHER", tenantId: TA, status: "submitted" }));
  assert.equal((await refund(body(linked.pi))).code, "REFUND_APPLICATION_STATE_UNVERIFIED");
  const b1 = await seed({ applicationId: "APP-B1", purpose: "subscriptionFee", credit: 0 });
  await claim("APP-B1", "M-B1");
  await memberCredit("M-B1", 5000);
  assert.equal((await refund(body(b1.pi, { memberId: "M-B1", amount: 1500 }))).status, 200);
  assert.equal((await refund(body(b1.pi, { memberId: "M-SOMEONE" }))).code, "REFUND_TARGET_MISMATCH");
  const ev = await seed({ purpose: "eventRegistration", ledgerDomain: "events", registrationId: "reg-crm", memberId: "M-EV", credit: 5000 });
  assert.equal((await refund(body(ev.pi))).code, "REFUND_FLOW_UNSUPPORTED");
  assert.equal(stripe.createCalls, before + 3, "every refusal happened before Stripe");
});

test("flow (ALWAYS, report mode too): no ledger receipt, conflicting links and a pending finance hold are refused", { skip }, async () => {
  const before = stripe.createCalls;
  const noRcp = await seed({ applicationId: "APP-NORCP", receipt: false });
  assert.equal((await refund(body(noRcp.pi))).code, "REFUND_INCONSISTENT_NO_LEDGER_RECEIPT");
  const c1 = await seed({ applicationId: "APP-C1", memberId: "M-X" });
  await claim("APP-C1", "M-Y");
  assert.equal((await refund(body(c1.pi))).code, "REFUND_LINK_CONFLICT");
  const c2 = await seed({ applicationId: "APP-C2", applicationBinding: "APP-C2-OTHER" });
  assert.equal((await refund(body(c2.pi))).code, "REFUND_LINK_CONFLICT");
  setApplicationCreditHoldChecker(async (tenantId, applicationId) => tenantId === TA && applicationId === "APP-HELD");
  const held = await seed({ applicationId: "APP-HELD" });
  assert.equal((await refund(body(held.pi))).code, "REFUND_PENDING_FINANCE_ALLOCATION");
  assert.equal((await refund({ mode: "external", applicationId: "APP-HELD", amount: 100, payoutMethod: "bank_transfer", currency: "eur" })).code, "REFUND_PENDING_FINANCE_ALLOCATION");
  setApplicationCreditHoldChecker(async () => { throw new Error("hold store down"); });
  assert.equal((await refund(body(held.pi))).code, "REFUND_APPLICATION_HOLD_UNAVAILABLE");
  assert.equal(stripe.createCalls, before);
});

test("report mode (default): flow decisions are recorded, the gated ones are not refused", { skip }, async () => {
  const p = await seed({ applicationId: "APP-REPORT" });
  const r = await refund(body(p.pi));
  assert.equal(r.status, 200, r.text);
  const [op] = await opsOf(p);
  assert.equal(op.policy.mode, "report");
  assert.equal(op.policy.flow, "A");
  assert.equal(op.policy.wouldRefuse, "REFUND_APPLICATION_STATE_UNAVAILABLE");
});

// ======================================================= event / course through the CRM endpoint
for (const mode of ["report", "enforce"]) {
  test(`event + course payments via POST /payments/refunds (${mode}): 409 REFUND_FLOW_UNSUPPORTED, no membership journal, no member reservation`, { skip }, async () => {
    if (mode === "enforce") process.env.REFUND_POLICY_MODE = "enforce";
    for (const purpose of ["eventRegistration", "courseRegistration"]) {
      const p = await seed({ purpose, ledgerDomain: "events", registrationId: `reg-${purpose}-${mode}`, memberId: `M-${purpose}-${mode}`, credit: 5000 });
      const glBefore = await GLTransaction.countDocuments({ tenantId: TA, docType: "Refund" });
      const before = stripe.createCalls;
      const r = await refund(body(p.pi, { amount: 1000 }));
      assert.equal(r.status, 409, r.text);
      assert.equal(r.code, "REFUND_FLOW_UNSUPPORTED");
      assert.equal(stripe.createCalls, before);
      assert.equal(await GLTransaction.countDocuments({ tenantId: TA, docType: "Refund" }), glBefore, "no refund journal of any kind");
      assert.equal(await MemberRefundReservation.countDocuments({ tenantId: TA, memberKey: `M-${purpose}-${mode}` }), 0);
      assert.equal((await opsOf(p)).length, 0);
    }
  });
}

// ======================================================= Stripe refund outcomes
test("outcome: pending -> succeeded via webhook: held and uncommitted while pending, finalized once on success", { skip }, async () => {
  const p = await seed({ applicationId: "APP-PEND-OK" });
  stripe.status = "pending";
  const r = await refund(body(p.pi, { amount: 2000 }));
  stripe.status = "succeeded";
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.status, "pending");
  const [op] = await opsOf(p);
  assert.equal(op.state, "provider_pending");
  assert.equal(reservedOf(await paymentRow(p)), 2000, "reservation held");
  assert.equal((await refundRows(p)).length, 0, "no Refund row while pending");
  assert.equal(await GLTransaction.countDocuments({ tenantId: TA, docType: "Refund", docNo: { $regex: "^RFD-" } , "entries.applicationId": "APP-PEND-OK" }), 0, "no GL while pending");
  await providerSets(op.stripeRefundId, "succeeded");
  await providerSets(op.stripeRefundId, "succeeded"); // duplicate webhook
  const after = await RefundOperation.findById(op._id).lean();
  assert.equal(after.state, "succeeded");
  assert.equal((await refundRows(p)).length, 1);
  const row = await paymentRow(p);
  assert.equal(row.refundCommittedCents, 2000);
  assert.equal(reservedOf(row), 0);
});

test("outcome: pending -> failed via webhook: released once, nothing committed or journaled", { skip }, async () => {
  const p = await seed({ applicationId: "APP-PEND-FAIL" });
  stripe.status = "pending";
  await refund(body(p.pi, { amount: 2000 }));
  stripe.status = "succeeded";
  const [op] = await opsOf(p);
  await providerSets(op.stripeRefundId, "failed", { eventType: "refund.failed" });
  await providerSets(op.stripeRefundId, "failed", { eventType: "refund.updated" }); // duplicate
  const after = await RefundOperation.findById(op._id).lean();
  assert.equal(after.state, "failed");
  assert.equal(after.error.appCode, "REFUND_PROVIDER_FAILED");
  const row = await paymentRow(p);
  assert.equal(reservedOf(row), 0);
  assert.equal(row.refundCommittedCents || 0, 0);
  assert.equal((await refundRows(p)).length, 0);
  assert.equal((await refund(body(p.pi, { amount: 5000 }))).status, 200, "the full amount is refundable again");
});

test("outcome: succeeded then FAILED later: reversing journal (original kept), Refund row marked reversed, counter restored once", { skip }, async () => {
  const p = await seed({ applicationId: "APP-LATEFAIL" });
  const r = await refund(body(p.pi, { amount: 2000 }));
  assert.equal(r.status, 200, r.text);
  const [op] = await opsOf(p);
  const [row0] = await refundRows(p);
  const originalGl = row0.glDocNo ? await GLTransaction.findOne({ tenantId: TA, docNo: row0.glDocNo }).lean() : null;
  await providerSets(op.stripeRefundId, "failed", { eventType: "charge.refund.updated" });
  await providerSets(op.stripeRefundId, "failed", { eventType: "refund.failed" }); // duplicate: one effect
  const after = await RefundOperation.findById(op._id).lean();
  assert.equal(after.state, "failed");
  assert.equal(after.error.appCode, "REFUND_PROVIDER_FAILED_AFTER_SUCCESS");
  const rows = await Refund.find({ tenantId: TA, paymentId: p._id }).lean();
  assert.equal(rows.length, 1, "the Refund row is kept for history");
  assert.ok(rows[0].reversedAt);
  const pay = await paymentRow(p);
  assert.equal(pay.refundCommittedCents, 0, "restored exactly once");
  assert.deepEqual(pay.refundReversedRefunds, [op.stripeRefundId]);
  assert.equal(pay.status, "succeeded");
  assert.ok(originalGl, `the refund journal was posted (glDocNo ${row0.glDocNo}, glStatus ${row0.glStatus})`);
  {
    const still = await GLTransaction.findOne({ tenantId: TA, docNo: row0.glDocNo }).lean();
    assert.deepEqual(still.entries.map((e) => [e.accountCode, e.dc, e.amount]), originalGl.entries.map((e) => [e.accountCode, e.dc, e.amount]), "original journal unchanged");
    const rev = await GLTransaction.findOne({ tenantId: TA, docNo: `${row0.glDocNo}-REV` }).lean();
    assert.ok(rev, "reversing journal posted");
    assert.deepEqual(rev.entries.map((e) => [e.accountCode, e.dc === "D" ? "C" : "D", e.amount]), originalGl.entries.map((e) => [e.accountCode, e.dc, e.amount]));
    assert.equal(await GLTransaction.countDocuments({ tenantId: TA, docNo: `${row0.glDocNo}-REV` }), 1);
  }
  assert.equal((await refund(body(p.pi, { amount: 5000 }))).status, 200, "the full amount is refundable again");
});

test("outcome: immediate failed / canceled from refunds.create -> failed, released, 502", { skip }, async () => {
  for (const status of ["failed", "canceled"]) {
    const p = await seed({ applicationId: `APP-IMMED-${status}` });
    stripe.status = status;
    const r = await refund(body(p.pi, { amount: 2000 }));
    stripe.status = "succeeded";
    assert.equal(r.status, 502, r.text);
    assert.equal(r.code, "REFUND_PROVIDER_FAILED");
    const [op] = await opsOf(p);
    assert.equal(op.state, "failed");
    assert.equal(op.providerStatus, status);
    assert.equal(reservedOf(await paymentRow(p)), 0);
    assert.equal((await refundRows(p)).length, 0);
  }
});

test("outcome: webhook arriving BEFORE the API response finalizes once; the API still answers 200", { skip }, async () => {
  const p = await seed({ applicationId: "APP-EARLYWH" });
  refundOpsHooks.afterStripe = async (op, refund) => {
    await handleRefundEvent({ id: "evt_early", type: "charge.refund.updated", data: { object: { ...refund } } });
  };
  const r = await refund(body(p.pi, { amount: 2000 }));
  refundOpsHooks.afterStripe = null;
  assert.equal(r.status, 200, r.text);
  assert.equal((await refundRows(p)).length, 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 2000);
  assert.equal((await opsOf(p))[0].state, "succeeded");
});

test("outcome: a client retry racing the success webhook -> one effect", { skip }, async () => {
  shortLease();
  const p = await seed({ applicationId: "APP-RACEWH" });
  const key = `idem-${crypto.randomBytes(5).toString("hex")}`;
  refundOpsHooks.afterStripe = async () => { throw Object.assign(new Error("simulated crash"), { simulatedCrash: true }); };
  await refund(body(p.pi, { amount: 2000 }), { headers: { "Idempotency-Key": key } });
  refundOpsHooks.afterStripe = null;
  await sleep(250);
  clearIdempotencyCache();
  const ours = stripe.refunds.find((x) => x.payment_intent === p.pi);
  const [retry] = await Promise.all([
    refund(body(p.pi, { amount: 2000 }), { headers: { "Idempotency-Key": key } }),
    handleRefundEvent({ id: "evt_race", type: "refund.updated", data: { object: { ...ours } } }),
  ]);
  assert.ok([200, 409].includes(retry.status), retry.text);
  assert.equal(stripe.refunds.filter((x) => x.payment_intent === p.pi).length, 1);
  assert.equal((await refundRows(p)).length, 1);
  assert.equal((await paymentRow(p)).refundCommittedCents, 2000);
});

test("outcome: reconcile polls a pending refund read-only and applies the provider's final status", { skip }, async () => {
  const p = await seed({ applicationId: "APP-POLL" });
  stripe.status = "pending";
  await refund(body(p.pi, { amount: 1500 }));
  stripe.status = "succeeded";
  const [op] = await opsOf(p);
  await providerSets(op.stripeRefundId, "succeeded", { deliver: false }); // webhook lost
  const dry = await reconcile({ operationIds: [String(op._id)] });
  assert.equal(dry.data.operations[0].plan, "poll_provider");
  assert.equal(dry.data.operations[0].providerStatus, "succeeded");
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "provider_pending", "dry-run writes nothing");
  await reconcile({ operationIds: [String(op._id)], apply: true });
  assert.equal((await RefundOperation.findById(op._id).lean()).state, "succeeded");
  assert.equal((await refundRows(p)).length, 1);
});

test("outcome: an out-of-band PENDING dashboard refund holds the payment; its later failure releases it", { skip }, async () => {
  const p = await seed({ applicationId: "APP-DASHPEND" });
  const dash = { id: "re_dash_pending", object: "refund", amount: 3000, status: "pending", charge: "ch_d", payment_intent: p.pi, metadata: {} };
  stripe.refunds.push(dash);
  await handleRefundEvent({ id: "evt_dp1", type: "refund.created", data: { object: { ...dash } } });
  assert.equal(reservedOf(await paymentRow(p)), 3000);
  assert.equal((await refund(body(p.pi, { amount: 3000 }))).code, "REFUND_AMOUNT_UNAVAILABLE");
  await providerSets("re_dash_pending", "failed", { eventType: "refund.failed" });
  assert.equal(reservedOf(await paymentRow(p)), 0);
  assert.equal((await refundRows(p)).length, 0);
});

// ======================================================= per-year credit
test("per-year credit: credit held only in a PRIOR year -> 409 REFUND_CREDIT_PERIOD_UNRESOLVED (explicit, not a silent cap)", { skip }, async () => {
  const p = await seed({ applicationId: "APP-PRIORYEAR", credit: 0 });
  await MaterializedBalance.collection.insertOne({ tenantId: TA, memberId: "app:APP-PRIORYEAR", accountCode: "2020", bucket: "current", year: new Date().getFullYear() - 1, ledgerDomain: "membership", amount: -5000, updatedAt: new Date() });
  const before = stripe.createCalls;
  const r = await refund(body(p.pi, { amount: 2000 }));
  assert.equal(r.status, 409, r.text);
  assert.equal(r.code, "REFUND_CREDIT_PERIOD_UNRESOLVED");
  assert.equal(stripe.createCalls, before);
  // credit neither in this year nor in any prior year: the ordinary cap
  const q = await seed({ applicationId: "APP-NOCREDIT", credit: 0 });
  assert.equal((await refund(body(q.pi, { amount: 2000 }))).code, "REFUND_MEMBER_CREDIT_UNAVAILABLE");
});
