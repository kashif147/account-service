// PL-2 payment lifecycle: state machine (pure), shadow mode against the legacy webhook
// decision, link payments monotonic, checkout.session.*, refunds, permanent rejections,
// retryable 500, outbox relay and authorisation-expiry warnings.
// Real throwaway mongod (as paymentTenancy.test.js); integration tests skip without one.
// Run: node --test --test-force-exit src/tests/paymentLifecycle.test.js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-lifecycle-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_lifecycle";
delete process.env.PAYMENT_STATE_MACHINE_MODE;

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}
let mongodProc = null;
async function startMongo() {
  if (process.env.LEDGER_TEST_MONGO_URI) return process.env.LEDGER_TEST_MONGO_URI;
  if (spawnSync("mongod", ["--version"]).status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-lifecycle-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", dir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_lifecycle_test`;
}

const sm = await import("../services/paymentStateMachine.js");

// ---------- integration (mongod) ----------
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
const published = [];
publisher.publish = async (eventType, data, options) => {
  published.push({ eventType, data, tenantId: options?.tenantId });
  return { success: true, eventId: "test" };
};
const { default: logger } = await import("../config/logger.js");
const warnings = [];
const origWarn = logger.warn.bind(logger);
logger.warn = (obj, msg) => { warnings.push({ obj, msg }); return origWarn(obj, msg); };

const payments = await import("../services/payments.service.js");
const lifecycle = await import("../services/stripeLifecycle.service.js");
const outbox = await import("../services/outbox.service.js");
const expiry = await import("../services/authorisationExpiry.cron.service.js");
const webhook = await import("../controllers/webhook.controller.js");
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: OutboxEvent } = await import("../models/outboxEvent.model.js");
const { default: StripeEventRejection } = await import("../models/stripeEventRejection.model.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");

const fakeStripe = {
  intents: {},
  charges: {},
  paymentIntents: { retrieve: async (id) => { const pi = fakeStripe.intents[id]; if (!pi) throw new Error("no such pi"); return pi; } },
  charges_: null,
};
fakeStripe.chargesApi = { retrieve: async (id) => { const c = fakeStripe.charges[id]; if (!c) throw new Error("no such charge"); return c; } };
lifecycle.setLifecycleStripe({ paymentIntents: fakeStripe.paymentIntents, charges: fakeStripe.chargesApi });
stripeClient.paymentIntents.retrieve = fakeStripe.paymentIntents.retrieve;
stripeClient.charges.retrieve = fakeStripe.chargesApi.retrieve;

const piEvent = (type, pi, { id, created } = {}) => ({
  id: id || `evt_${Math.random().toString(36).slice(2, 10)}`,
  type,
  created: created || Math.floor(Date.now() / 1000),
  data: { object: pi },
});
const pi = (id, status, extra = {}) => ({ id, object: "payment_intent", status, amount: 29900, currency: "eur", created: Math.floor(Date.now() / 1000), metadata: {}, ...extra });

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
}
async function deliver(event) {
  stripeClient.webhooks.constructEvent = () => event;
  const res = fakeRes();
  await webhook.handleStripeWebhook({ headers: { "stripe-signature": "t" }, body: Buffer.from("{}") }, res);
  return res;
}

async function mkPayment(fields) {
  return Payment.create({
    tenantId: A,
    purpose: "applicationFee",
    amount: 29900,
    currency: "eur",
    mode: "stripe",
    status: "requires_action",
    ...fields,
  });
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of [Payment, OutboxEvent, StripeEventRejection, GL, CoA, MatBal]) await M.syncIndexes();
  await ensureTenantChartOfAccounts(A);
  await ensureTenantChartOfAccounts(B);
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
});

test("shadow: inline payment keeps legacy behaviour and logs the disagreement", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-inline-1", status: "requires_capture", stripe: { paymentIntentId: "pi_inline_1" } });
  published.length = 0;
  warnings.length = 0;
  const res = await deliver(piEvent("payment_intent.requires_action", pi("pi_inline_1", "requires_action")));
  assert.equal(res.statusCode, 200);
  const after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "requires_action", "legacy stays authoritative for existing (inline) payments");
  const w = warnings.find((x) => x.msg?.includes("disagrees") && x.obj.paymentId === String(p._id));
  assert.ok(w, "disagreement logged");
  assert.equal(w.obj.legacyDecision, "requires_action");
  assert.equal(w.obj.machineDecision, "requires_capture");
  assert.equal(w.obj.authoritative, "legacy");
  assert.equal(JSON.stringify(w.obj).includes("pi_inline_1"), false, "no Stripe ids or payloads in the log record");
  assert.ok(published.some((e) => e.eventType === "application.status.submitted"), "inline still publishes the legacy event");
  assert.equal(await OutboxEvent.countDocuments({ "data.paymentId": String(p._id) }), 0);
});

test("link payment: late requires_action cannot regress requires_capture; no legacy event; outbox status", { skip }, async () => {
  const linkId = new mongoose.Types.ObjectId();
  const p = await mkPayment({ applicationId: "app-link-1", paymentLinkId: linkId, linkVersion: 1, status: "requires_action", stripe: { paymentIntentId: "pi_link_1", checkoutSessionId: "cs_link_1" } });
  published.length = 0;
  fakeStripe.charges.ch_link_1 = { id: "ch_link_1", payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 7 * 86400 } } };
  let res = await deliver(piEvent("payment_intent.amount_capturable_updated", pi("pi_link_1", "requires_capture", { latest_charge: "ch_link_1" })));
  assert.equal(res.statusCode, 200);
  let after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "requires_capture");
  assert.ok(after.capturableUntil instanceof Date, "capture_before stored");
  res = await deliver(piEvent("payment_intent.requires_action", pi("pi_link_1", "requires_action")));
  assert.equal(res.statusCode, 200);
  after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "requires_capture", "regression refused for link payments");
  assert.equal(published.filter((e) => e.eventType === "application.status.submitted").length, 0, "link payments never publish the legacy event");
  const rows = await OutboxEvent.find({ "data.paymentId": String(p._id) }).lean();
  assert.deepEqual(rows.map((r) => r.eventKey), [`pay:${p._id}:requires_capture`]);
  assert.equal(rows[0].tenantId, A);
  assert.equal(rows[0].data.applicationStatus, "AUTHORISED");
});

test("link payment: late requires_capture / canceled cannot regress succeeded", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-link-2", paymentLinkId: new mongoose.Types.ObjectId(), status: "succeeded", stripe: { paymentIntentId: "pi_link_2" } });
  await deliver(piEvent("payment_intent.amount_capturable_updated", pi("pi_link_2", "requires_capture")));
  await deliver(piEvent("payment_intent.canceled", pi("pi_link_2", "canceled", { cancellation_reason: "automatic" })));
  assert.equal((await Payment.findById(p._id).lean()).status, "succeeded");
});

test("webhook retry of the same event is a no-op that re-enqueues idempotently", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-link-3", paymentLinkId: new mongoose.Types.ObjectId(), stripe: { paymentIntentId: "pi_link_3" } });
  const ev = piEvent("payment_intent.amount_capturable_updated", pi("pi_link_3", "requires_capture"), { id: "evt_retry_1" });
  assert.equal((await deliver(ev)).statusCode, 200);
  assert.equal((await deliver(ev)).statusCode, 200);
  const after = await Payment.findById(p._id).lean();
  assert.equal(after.webhookEventIds.filter((e) => e === "evt_retry_1").length, 1);
  assert.equal(await OutboxEvent.countDocuments({ "data.paymentId": String(p._id) }), 1);
});

test("transient failure answers 500 (Stripe retries); the retry then succeeds once", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-link-4", paymentLinkId: new mongoose.Types.ObjectId(), stripe: { paymentIntentId: "pi_link_4" } });
  const ev = piEvent("payment_intent.amount_capturable_updated", pi("pi_link_4", "requires_capture"), { id: "evt_transient_1" });
  const orig = Payment.findOneAndUpdate;
  Payment.findOneAndUpdate = function () { throw Object.assign(new Error("connection reset"), { name: "MongoNetworkError" }); };
  let res;
  try { res = await deliver(ev); } finally { Payment.findOneAndUpdate = orig; }
  assert.equal(res.statusCode, 500);
  assert.equal((await Payment.findById(p._id).lean()).status, "requires_action", "nothing recorded on failure");
  res = await deliver(ev);
  assert.equal(res.statusCode, 200);
  assert.equal((await Payment.findById(p._id).lean()).status, "requires_capture");
});

test("permanent rejection (unknown PaymentIntent) is recorded and answered 2xx", { skip }, async () => {
  const ev = piEvent("payment_intent.succeeded", pi("pi_unknown_9", "succeeded", { metadata: { tenantId: B } }), { id: "evt_unknown_9" });
  const res = await deliver(ev);
  assert.equal(res.statusCode, 200);
  const rej = await StripeEventRejection.findOne({ stripeEventId: "evt_unknown_9" }).lean();
  assert.equal(rej.reason, "unknown_payment_intent");
  assert.equal(rej.tenantId, null, "metadata tenant is never recorded as authority");
  assert.equal(await Payment.countDocuments({ "stripe.paymentIntentId": "pi_unknown_9" }), 0, "never upserted");
});

test("forged tenant in Stripe metadata is rejected for a known PaymentIntent", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-link-5", paymentLinkId: new mongoose.Types.ObjectId(), stripe: { paymentIntentId: "pi_link_5" } });
  const res = await deliver(piEvent("payment_intent.amount_capturable_updated", pi("pi_link_5", "requires_capture", { metadata: { tenantId: B } }), { id: "evt_forged_5" }));
  assert.equal(res.statusCode, 200);
  assert.equal((await Payment.findById(p._id).lean()).status, "requires_action");
  assert.equal((await StripeEventRejection.findOne({ stripeEventId: "evt_forged_5" }).lean()).reason, "tenant_mismatch");
});

test("checkout.session.completed links session -> PaymentIntent and applies the PI's current status", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-cs-1", paymentLinkId: new mongoose.Types.ObjectId(), linkVersion: 1, stripe: { checkoutSessionId: "cs_test_1" } });
  fakeStripe.intents.pi_cs_1 = pi("pi_cs_1", "requires_capture", {
    latest_charge: { id: "ch_cs_1", payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 6 * 86400 } } },
  });
  const ev = piEvent("checkout.session.completed", { id: "cs_test_1", object: "checkout.session", payment_intent: "pi_cs_1", metadata: { tenantId: A } }, { id: "evt_cs_done_1" });
  let res = await deliver(ev);
  assert.equal(res.statusCode, 200);
  let after = await Payment.findById(p._id).lean();
  assert.equal(after.stripe.paymentIntentId, "pi_cs_1");
  assert.equal(after.stripe.chargeId, "ch_cs_1");
  assert.equal(after.status, "requires_capture");
  assert.ok(after.capturableUntil);
  // Stripe redelivers the session event: no change, no duplicate.
  res = await deliver(ev);
  assert.equal(res.statusCode, 200);
  assert.equal(await Payment.countDocuments({ "stripe.paymentIntentId": "pi_cs_1" }), 1);
  // A PI event that arrived before the session is now resolvable too.
  await deliver(piEvent("payment_intent.requires_action", pi("pi_cs_1", "requires_action")));
  after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "requires_capture");
});

test("checkout.session.completed for an unknown session is a recorded rejection", { skip }, async () => {
  const res = await deliver(piEvent("checkout.session.completed", { id: "cs_nope", object: "checkout.session", payment_intent: "pi_x" }, { id: "evt_cs_unknown" }));
  assert.equal(res.statusCode, 200);
  assert.equal((await StripeEventRejection.findOne({ stripeEventId: "evt_cs_unknown" }).lean()).reason, "unknown_checkout_session");
});

test("checkout.session.expired closes a never-paid Payment as canceled", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-cs-2", paymentLinkId: new mongoose.Types.ObjectId(), stripe: { checkoutSessionId: "cs_test_2" } });
  const res = await deliver(piEvent("checkout.session.expired", { id: "cs_test_2", object: "checkout.session", payment_intent: null }, { id: "evt_cs_exp_2" }));
  assert.equal(res.statusCode, 200);
  const after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "canceled");
  assert.equal(after.stripe.cancellationReason, "checkout_session_expired");
});

test("declined payment -> failed; then a successful retry authorises", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-dec-1", paymentLinkId: new mongoose.Types.ObjectId(), stripe: { paymentIntentId: "pi_dec_1" } });
  await deliver(piEvent("payment_intent.payment_failed", pi("pi_dec_1", "requires_payment_method", { last_payment_error: { code: "card_declined", message: "Your card was declined." } })));
  let after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "failed");
  assert.equal(after.stripe.failureCode, "card_declined");
  await deliver(piEvent("payment_intent.amount_capturable_updated", pi("pi_dec_1", "requires_capture")));
  after = await Payment.findById(p._id).lean();
  assert.equal(after.status, "requires_capture");
});

test("authorisation expiry: automatic cancel -> authorization_expired", { skip }, async () => {
  const p = await mkPayment({ applicationId: "app-exp-1", paymentLinkId: new mongoose.Types.ObjectId(), status: "requires_capture", stripe: { paymentIntentId: "pi_exp_1" } });
  await deliver(piEvent("payment_intent.canceled", pi("pi_exp_1", "canceled", { cancellation_reason: "automatic" })));
  assert.equal((await Payment.findById(p._id).lean()).status, "authorization_expired");
  assert.ok(await OutboxEvent.findOne({ eventKey: `pay:${p._id}:authorization_expired` }));
});

test("refunds: link payment applies; inline payment logs only (shadow)", { skip }, async () => {
  const link = await mkPayment({ applicationId: "app-ref-1", paymentLinkId: new mongoose.Types.ObjectId(), status: "succeeded", stripe: { paymentIntentId: "pi_ref_1" } });
  const inline = await mkPayment({ applicationId: "app-ref-2", status: "succeeded", stripe: { paymentIntentId: "pi_ref_2" } });
  const charge = (id, piId, refunded) => ({ id, object: "charge", payment_intent: piId, amount: 29900, amount_captured: 29900, amount_refunded: refunded });
  await deliver(piEvent("charge.refunded", charge("ch_r1", "pi_ref_1", 10000)));
  assert.equal((await Payment.findById(link._id).lean()).status, "partially_refunded");
  fakeStripe.charges.ch_r1 = charge("ch_r1", "pi_ref_1", 29900);
  await deliver(piEvent("refund.updated", { id: "re_1", object: "refund", charge: "ch_r1", status: "succeeded" }));
  assert.equal((await Payment.findById(link._id).lean()).status, "refunded");
  assert.equal(await OutboxEvent.countDocuments({ "data.paymentId": String(link._id) }), 2);
  await deliver(piEvent("charge.refunded", charge("ch_r2", "pi_ref_2", 29900)));
  assert.equal((await Payment.findById(inline._id).lean()).status, "succeeded", "shadow: inline unchanged");
});

test("outbox: enqueue is idempotent; relay publishes, backs off on failure, then delivers", { skip }, async () => {
  const first = await outbox.enqueueOutboxEvent({ eventKey: "k:1", tenantId: A, routingKey: "payments.payment-link.issued.v1", data: { a: 1 } });
  const second = await outbox.enqueueOutboxEvent({ eventKey: "k:1", tenantId: A, routingKey: "payments.payment-link.issued.v1", data: { a: 2 } });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  await OutboxEvent.updateMany({ eventKey: { $ne: "k:1" } }, { $set: { status: "PUBLISHED" } });
  const sent = [];
  let fail = true;
  outbox.setOutboxPublisher(async (rk, data, meta) => { if (fail) return false; sent.push({ rk, data, meta }); return true; });
  const now = new Date();
  let r = await outbox.relayOutboxOnce({ now });
  assert.equal(r.failed, 1);
  let row = await OutboxEvent.findOne({ eventKey: "k:1" }).lean();
  assert.equal(row.status, "PENDING");
  assert.ok(row.nextAttemptAt > now, "backed off");
  fail = false;
  r = await outbox.relayOutboxOnce({ now: new Date(now.getTime() + 60000) });
  assert.equal(r.published, 1);
  assert.equal(sent[0].data.a, 1, "first write wins");
  assert.equal(sent[0].data.eventKey, "k:1");
  assert.equal(sent[0].meta.tenantId, A);
  row = await OutboxEvent.findOne({ eventKey: "k:1" }).lean();
  assert.equal(row.status, "PUBLISHED");
  outbox.setOutboxPublisher(null);
});

test("expiry scheduler warns once per authorised application payment inside the window", { skip }, async () => {
  const now = new Date();
  const soon = await mkPayment({ applicationId: "app-warn-1", status: "requires_capture", capturableUntil: new Date(now.getTime() + 20 * 3600000), stripe: { paymentIntentId: "pi_warn_1" } });
  const later = await mkPayment({ applicationId: "app-warn-2", status: "requires_capture", capturableUntil: new Date(now.getTime() + 100 * 3600000), stripe: { paymentIntentId: "pi_warn_2" } });
  const r1 = await expiry.warnExpiringAuthorisations({ now, warnHours: 48 });
  const r2 = await expiry.warnExpiringAuthorisations({ now, warnHours: 48 });
  assert.equal(r1.warned >= 1, true);
  assert.equal(r2.warned, 0);
  const row = await OutboxEvent.findOne({ eventKey: `pay:${soon._id}:expiring` }).lean();
  assert.equal(row.data.hoursLeft, 20);
  assert.equal(row.tenantId, A);
  assert.equal(await OutboxEvent.countDocuments({ eventKey: `pay:${later._id}:expiring` }), 0);
});

// ---------- pure state machine ----------
test("state machine: forward moves apply", () => {
  for (const [from, to] of [
    ["requires_action", "requires_capture"],
    ["requires_action", "failed"],
    ["failed", "requires_action"],
    ["failed", "requires_capture"],
    ["requires_capture", "succeeded"],
    ["requires_capture", "authorization_expired"],
    ["requires_capture", "canceled"],
    ["succeeded", "partially_refunded"],
    ["partially_refunded", "refunded"],
    [undefined, "requires_action"],
  ]) {
    const d = sm.nextPaymentStatus(from, to);
    assert.equal(d.status, to, `${from} -> ${to}`);
    assert.equal(d.applied, true);
  }
});

test("state machine: late events cannot regress requires_capture or succeeded", () => {
  for (const late of ["requires_action", "processing", "failed"]) {
    const d = sm.nextPaymentStatus("requires_capture", late);
    assert.equal(d.status, "requires_capture");
    assert.equal(d.applied, false);
    assert.equal(d.recheck, true);
  }
  for (const late of ["requires_action", "processing", "failed", "requires_capture", "canceled", "authorization_expired"]) {
    assert.equal(sm.nextPaymentStatus("succeeded", late).status, "succeeded", late);
  }
});

test("state machine: terminal, idempotent and hold states", () => {
  assert.equal(sm.nextPaymentStatus("canceled", "requires_capture").status, "canceled");
  assert.equal(sm.nextPaymentStatus("authorization_expired", "succeeded").status, "authorization_expired");
  assert.equal(sm.nextPaymentStatus("refunded", "succeeded").status, "refunded");
  assert.deepEqual(sm.nextPaymentStatus("requires_capture", "requires_capture").reason, "idempotent");
  const hold = sm.nextPaymentStatus("manual_review", "succeeded");
  assert.equal(hold.status, "manual_review");
  assert.equal(hold.reason, "hold_record_only");
});

test("state machine: processing -> requires_action only for a newer event", () => {
  const older = sm.nextPaymentStatus("processing", "requires_action", { occurredAt: new Date(1000), lastAppliedAt: new Date(2000) });
  assert.equal(older.status, "processing");
  const newer = sm.nextPaymentStatus("processing", "requires_action", { occurredAt: new Date(3000), lastAppliedAt: new Date(2000) });
  assert.equal(newer.status, "requires_action");
});

test("state machine: cancellation, 2018 names, refunds, application mapping", () => {
  assert.equal(sm.classifyCancellation("automatic"), "authorization_expired");
  assert.equal(sm.classifyCancellation("abandoned"), "authorization_expired");
  assert.equal(sm.classifyCancellation("requested_by_customer"), "canceled");
  assert.equal(sm.normalizeStripeStatus("requires_source"), "requires_payment_method");
  assert.equal(sm.normalizeStripeStatus("requires_source_action"), "requires_action");
  assert.equal(sm.refundStatusFromCharge({ amount_captured: 1000, amount_refunded: 0 }), null);
  assert.equal(sm.refundStatusFromCharge({ amount_captured: 1000, amount_refunded: 400 }), "partially_refunded");
  assert.equal(sm.refundStatusFromCharge({ amount_captured: 1000, amount_refunded: 1000 }), "refunded");
  assert.equal(sm.applicationPaymentStatus("requires_capture"), "AUTHORISED");
  assert.equal(sm.applicationPaymentStatus("succeeded"), "CAPTURED");
  assert.equal(sm.applicationPaymentStatus("requires_action"), null);
});

test("state machine: mode defaults to shadow; unknown values fall back to shadow", () => {
  assert.equal(sm.stateMachineMode({}), "shadow");
  assert.equal(sm.stateMachineMode({ PAYMENT_STATE_MACHINE_MODE: "bogus" }), "shadow");
  assert.equal(sm.stateMachineMode({ PAYMENT_STATE_MACHINE_MODE: "authoritative" }), "authoritative");
});
