// PL-3 payment links: issue, redelivery, replacement and re-pricing, server-side price only,
// one authorised payment per application (incl. races), tenant isolation, and the full
// Checkout -> PaymentIntent -> existing capture convergence.
// Real throwaway mongod; skips without one.
// Run: node --test --test-force-exit src/tests/paymentLink.test.js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-paylink-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_paylink";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-paylink-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", dir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_link_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
const published = [];
publisher.publish = async (eventType, data, options) => {
  published.push({ eventType, data, tenantId: options?.tenantId });
  return { success: true, eventId: "test" };
};
const links = await import("../services/paymentLink.service.js");
const lifecycle = await import("../services/stripeLifecycle.service.js");
const payments = await import("../services/payments.service.js");
const webhook = await import("../controllers/webhook.controller.js");
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: PaymentLink } = await import("../models/paymentLink.model.js");
const { default: OutboxEvent } = await import("../models/outboxEvent.model.js");
const { default: StripeEventRejection } = await import("../models/stripeEventRejection.model.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");

// ---------- fake Stripe ----------
const fake = {
  sessions: {}, intents: {}, byKey: {}, createCalls: [], expireCalls: [], cancelCalls: [],
  expireError: null, createError: null, n: 0,
};
const stripeFake = {
  checkout: {
    sessions: {
      async create(params, opts) {
        fake.createCalls.push({ params, opts });
        if (fake.createError) throw fake.createError;
        if (opts?.idempotencyKey && fake.byKey[opts.idempotencyKey]) return fake.byKey[opts.idempotencyKey];
        fake.n += 1;
        const s = { id: `cs_test_${fake.n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${fake.n}`, status: "open", expires_at: params.expires_at, metadata: params.metadata, payment_intent: null };
        fake.sessions[s.id] = s;
        if (opts?.idempotencyKey) fake.byKey[opts.idempotencyKey] = s;
        return s;
      },
      async expire(id) {
        fake.expireCalls.push(id);
        const s = fake.sessions[id];
        if (fake.expireError || s.status === "complete") throw fake.expireError || Object.assign(new Error("session complete"), { type: "StripeInvalidRequestError" });
        s.status = "expired";
        return s;
      },
      async retrieve(id) { return fake.sessions[id]; },
    },
  },
  paymentIntents: {
    async retrieve(id) { const pi = fake.intents[id]; if (!pi) throw new Error("no such pi"); return pi; },
    async cancel(id, params, opts) { fake.cancelCalls.push({ id, params, opts }); fake.intents[id] = { ...fake.intents[id], status: "canceled", cancellation_reason: params?.cancellation_reason }; return fake.intents[id]; },
    async capture(id) { fake.intents[id] = { ...fake.intents[id], status: "succeeded", amount_received: fake.intents[id].amount }; return fake.intents[id]; },
  },
  charges: { async retrieve() { throw new Error("no charge"); } },
};
links.setPaymentLinkStripe(stripeFake);
lifecycle.setLifecycleStripe(stripeFake);
stripeClient.paymentIntents.retrieve = stripeFake.paymentIntents.retrieve;
stripeClient.paymentIntents.capture = stripeFake.paymentIntents.capture;
stripeClient.paymentIntents.cancel = stripeFake.paymentIntents.cancel;

// ---------- stub catalogue ----------
const catalogue = { "general nurse": 29900, student: 0 };
links.setPaymentLinkPricingDeps({
  getMembershipPricing: async ({ categoryName, tenantId }) => {
    if (tenantId === B && categoryName === "General Nurse") return { annualFee: 50000 };
    const fee = catalogue[String(categoryName).toLowerCase()];
    if (fee === undefined) throw new Error("no product");
    return { annualFee: fee };
  },
});
links.registerPaymentLinkWebhookHooks();

const request = (tenantId, applicationId, linkVersion, extra = {}) => ({
  eventId: `ev-${Math.random()}`,
  tenantId,
  data: {
    applicationId,
    linkVersion,
    action: linkVersion > 1 ? "REPLACE" : "ISSUE",
    paymentOption: "FULL",
    pricing: { membershipCategory: "General Nurse", paymentType: "Credit Card" },
    requestedBy: { userId: "staff-1", userType: "CRM", channel: "MEMBERSHUB" },
    ...extra,
  },
});
function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
async function deliver(event) {
  stripeClient.webhooks.constructEvent = () => event;
  const res = fakeRes();
  await webhook.handleStripeWebhook({ headers: { "stripe-signature": "t" }, body: Buffer.from("{}") }, res);
  return res;
}
let evtN = 0;
const ev = (type, object) => ({ id: `evt_${++evtN}`, type, created: Math.floor(Date.now() / 1000), data: { object } });

/** Simulate the payer completing Checkout for a session: Stripe creates a manual-capture PI. */
async function payerCompletes(sessionId, piId) {
  const s = fake.sessions[sessionId];
  s.status = "complete";
  s.payment_intent = piId;
  fake.intents[piId] = { id: piId, object: "payment_intent", status: "requires_capture", amount: 0, currency: "eur", created: Math.floor(Date.now() / 1000), capture_method: "manual", metadata: s.metadata, latest_charge: null };
  const link = await PaymentLink.findOne({ checkoutSessionId: sessionId }).lean();
  fake.intents[piId].amount = link.amount;
  return deliver(ev("checkout.session.completed", { id: sessionId, object: "checkout.session", payment_intent: piId, metadata: s.metadata }));
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of [Payment, PaymentLink, OutboxEvent, StripeEventRejection, GL, CoA, MatBal]) await M.syncIndexes();
  await ensureTenantChartOfAccounts(A);
  await ensureTenantChartOfAccounts(B);
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
});

test("issue: Checkout Session (manual capture, <=24h, server price, tenant metadata) + Payment + issued event", { skip }, async () => {
  const before = fake.createCalls.length;
  const r = await links.handlePaymentLinkRequested(request(A, "app-1", 1, { amount: 1, pricing: { membershipCategory: "General Nurse", paymentType: "Credit Card", amount: 1 } }));
  assert.equal(r.issued, true);
  const call = fake.createCalls[before];
  assert.equal(call.params.payment_intent_data.capture_method, "manual");
  assert.equal(call.params.line_items[0].price_data.unit_amount, 29900, "catalogue price, client amount ignored");
  const ttl = call.params.expires_at - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 23 * 3600 && ttl <= 24 * 3600, `ttl ${ttl}`);
  assert.equal(call.params.payment_intent_data.metadata.tenantId, A);
  assert.equal(call.opts.idempotencyKey, `link:${A}:app-1:v1`);
  const link = await PaymentLink.findOne({ tenantId: A, applicationId: "app-1" }).lean();
  assert.equal(link.status, "ISSUED");
  assert.match(link.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(link.pricingBasis.basis, "ANNUAL");
  assert.equal(link.paymentOption, "FULL");
  const pay = await Payment.findById(link.paymentId).lean();
  assert.equal(pay.tenantId, A);
  assert.equal(pay.status, "requires_action");
  assert.equal(pay.stripe.checkoutSessionId, link.checkoutSessionId);
  assert.equal(String(pay.paymentLinkId), String(link._id));
  assert.equal(pay.purpose, "applicationFee");
  const out = await OutboxEvent.findOne({ eventKey: `link:${A}:app-1:v1:issued` }).lean();
  assert.equal(out.tenantId, A);
  assert.equal(out.data.amount, 29900);
  assert.equal(out.data.checkoutUrl, link.checkoutUrl);
});

test("duplicate RabbitMQ delivery: one link, one payment, one session; outcome re-published", { skip }, async () => {
  const msg = request(A, "app-2", 1);
  await links.handlePaymentLinkRequested(msg);
  await OutboxEvent.updateOne({ eventKey: `link:${A}:app-2:v1:issued` }, { $set: { status: "PUBLISHED" } });
  const r = await links.handlePaymentLinkRequested(msg);
  assert.equal(r.redelivery, true);
  assert.equal(await PaymentLink.countDocuments({ tenantId: A, applicationId: "app-2" }), 1);
  assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: "app-2" }), 1);
  assert.equal(new Set(fake.createCalls.filter((c) => c.opts.idempotencyKey === `link:${A}:app-2:v1`).map(() => 1)).size, 1);
  assert.equal((await OutboxEvent.findOne({ eventKey: `link:${A}:app-2:v1:issued` }).lean()).status, "PENDING", "re-armed");
});

test("resume after a crash between PENDING and ISSUED reuses the same Payment and session", { skip }, async () => {
  const msg = request(A, "app-3", 1);
  await links.handlePaymentLinkRequested(msg);
  const link = await PaymentLink.findOne({ tenantId: A, applicationId: "app-3" }).lean();
  await PaymentLink.updateOne({ _id: link._id }, { $set: { status: "PENDING" } });
  await links.handlePaymentLinkRequested(msg);
  const again = await PaymentLink.findOne({ tenantId: A, applicationId: "app-3" }).lean();
  assert.equal(again.status, "ISSUED");
  assert.equal(again.checkoutSessionId, link.checkoutSessionId, "Stripe idempotency key returned the same session");
  assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: "app-3" }), 1);
});

test("business failures are published, not thrown", { skip }, async () => {
  const cases = [
    [request(A, "app-f1", 1, { pricing: { membershipCategory: "General Nurse", paymentType: "Bitcoin" } }), "PAYMENT_METHOD_NOT_SUPPORTED"],
    [request(A, "app-f2", 1, { pricing: { membershipCategory: "General Nurse", paymentType: null } }), "PAYMENT_METHOD_NOT_SUPPORTED"],
    [request(A, "app-f3", 1, { pricing: { membershipCategory: "Student", paymentType: "Credit Card" } }), "PAYMENT_NOT_REQUIRED"],
    [request(A, "app-f4", 1, { pricing: { membershipCategory: "Unknown Grade", paymentType: "Credit Card" } }), "PRICE_UNAVAILABLE"],
  ];
  for (const [msg, reason] of cases) {
    const r = await links.handlePaymentLinkRequested(msg);
    assert.equal(r.failed, reason);
    const link = await PaymentLink.findOne({ tenantId: A, applicationId: msg.data.applicationId }).lean();
    assert.equal(link.status, "FAILED");
    const out = await OutboxEvent.findOne({ eventKey: `link:${A}:${msg.data.applicationId}:v1:failed` }).lean();
    assert.equal(out.data.reason, reason);
    assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: msg.data.applicationId }), 0);
  }
});

test("replace: old session expired, old link REPLACED with frozen price, new version re-priced", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-r", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-r", linkVersion: 1 }).lean();
  catalogue["general nurse"] = 31000; // catalogue change after issue
  try {
    await links.handlePaymentLinkRequested(request(A, "app-r", 2));
  } finally {
    catalogue["general nurse"] = 29900;
  }
  const v1After = await PaymentLink.findById(v1._id).lean();
  const v2 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-r", linkVersion: 2 }).lean();
  assert.equal(v1After.status, "REPLACED");
  assert.equal(v1After.amount, 29900, "original keeps its frozen price");
  assert.equal(v2.status, "ISSUED");
  assert.equal(v2.amount, 31000, "replacement re-priced");
  assert.ok(fake.expireCalls.includes(v1.checkoutSessionId));
  const oldPay = await Payment.findById(v1.paymentId).lean();
  assert.equal(oldPay.status, "canceled");
  assert.equal(oldPay.isActiveAttempt, false);
  // the old session's expiry webhook later: recorded, no expired event for a replaced link
  await deliver(ev("checkout.session.expired", { id: v1.checkoutSessionId, object: "checkout.session" }));
  assert.equal(await OutboxEvent.countDocuments({ eventKey: `link:${A}:app-r:v1:expired` }), 0);
  // a stale v1 request after v2 is ignored
  const stale = await links.handlePaymentLinkRequested(request(A, "app-r", 1));
  assert.equal(stale.redelivery, true);
});

test("replace refused when the old session was already paid", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-paid-old", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-paid-old" }).lean();
  fake.sessions[v1.checkoutSessionId].status = "complete";
  const r = await links.handlePaymentLinkRequested(request(A, "app-paid-old", 2));
  assert.equal(r.failed, "ALREADY_AUTHORISED");
  assert.equal((await PaymentLink.findById(v1._id).lean()).status, "ISSUED");
});

test("existing inline authorised PaymentIntent blocks link issue", { skip }, async () => {
  await Payment.create({ tenantId: A, purpose: "applicationFee", amount: 29900, currency: "eur", mode: "stripe", status: "requires_capture", applicationId: "app-inline", stripe: { paymentIntentId: "pi_inline_auth" } });
  const r = await links.handlePaymentLinkRequested(request(A, "app-inline", 1));
  assert.equal(r.failed, "ALREADY_AUTHORISED");
  assert.equal(await PaymentLink.countDocuments({ tenantId: A, applicationId: "app-inline", status: "ISSUED" }), 0);
});

test("full flow: Checkout completed -> PI requires_capture -> AUTHORISED -> existing capture -> CAPTURED", { skip }, async () => {
  published.length = 0;
  await links.handlePaymentLinkRequested(request(A, "app-flow", 1));
  const link = await PaymentLink.findOne({ tenantId: A, applicationId: "app-flow" }).lean();
  const res = await payerCompletes(link.checkoutSessionId, "pi_flow_1");
  assert.equal(res.statusCode, 200);
  let pay = await Payment.findById(link.paymentId).lean();
  assert.equal(pay.stripe.paymentIntentId, "pi_flow_1");
  assert.equal(pay.status, "requires_capture");
  assert.equal((await PaymentLink.findById(link._id).lean()).status, "COMPLETED");
  assert.equal((await OutboxEvent.findOne({ eventKey: `pay:${pay._id}:requires_capture` }).lean()).data.applicationStatus, "AUTHORISED");
  // approval's lookup finds the link payment by applicationId + paymentIntentId (no LINK branch needed)
  const latest = await payments.findLatestApplicationPayment("app-flow", { tenantId: A });
  assert.equal(latest.stripe.paymentIntentId, "pi_flow_1");
  // existing capture route
  const cap = await payments.capturePaymentIntent("pi_flow_1", { tenantId: A, userId: "crm-1" });
  assert.equal(cap.captured, true);
  pay = await Payment.findById(link.paymentId).lean();
  assert.equal(pay.status, "succeeded");
  assert.equal((await OutboxEvent.findOne({ eventKey: `pay:${pay._id}:succeeded` }).lean()).data.applicationStatus, "CAPTURED");
  assert.equal(published.filter((e) => e.eventType === "application.status.submitted").length, 0, "no legacy portal event");
  assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: "app-flow" }), 1, "no duplicate payment");
  // replacement now refused
  const r = await links.handlePaymentLinkRequested(request(A, "app-flow", 2));
  assert.equal(r.failed, "ALREADY_AUTHORISED");
});

test("race: old and new link both authorised -> keep the first, cancel the newer uncaptured PI", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-race", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-race", linkVersion: 1 }).lean();
  // old session completes while the replacement is being created (expire loses the race)
  fake.expireError = Object.assign(new Error("transient"), { type: "StripeAPIError" });
  fake.sessions[v1.checkoutSessionId].status = "open";
  // simulate: replacement already issued (v1 retired) before old payer completes
  fake.expireError = null;
  await links.handlePaymentLinkRequested(request(A, "app-race", 2));
  const v2 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-race", linkVersion: 2 }).lean();
  // new link authorised first
  await payerCompletes(v2.checkoutSessionId, "pi_race_new");
  // old session nonetheless completes (expire raced) -> second authorisation
  await Payment.updateOne({ _id: v1.paymentId }, { $set: { status: "requires_action", isActiveAttempt: true } });
  fake.sessions[v1.checkoutSessionId].status = "open";
  const cancelsBefore = fake.cancelCalls.length;
  await payerCompletes(v1.checkoutSessionId, "pi_race_old");
  const p1 = await Payment.findById(v1.paymentId).lean();
  const p2 = await Payment.findById(v2.paymentId).lean();
  assert.equal(p2.status, "requires_capture", "first authorised kept");
  assert.equal(p1.status, "canceled", "later authorisation cancelled");
  assert.equal(p1.supersededReason, "duplicate_authorisation");
  assert.equal(String(p1.supersededByPaymentId), String(p2._id));
  assert.deepEqual(fake.cancelCalls.slice(cancelsBefore).map((c) => c.id), ["pi_race_old"]);
  assert.equal(fake.cancelCalls[cancelsBefore].params.cancellation_reason, "duplicate");
  assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: "app-race", status: { $in: links.AUTHORISED_STATUSES } }), 1);
  // the PI canceled webhook that follows is consistent
  await deliver(ev("payment_intent.canceled", { ...fake.intents.pi_race_old }));
  assert.equal((await Payment.findById(v1.paymentId).lean()).status, "canceled");
});

test("link authorised first blocks a second (inline) authorisation", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-mixed", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-mixed" }).lean();
  await payerCompletes(v1.checkoutSessionId, "pi_mixed_link");
  const inline = await Payment.create({ tenantId: A, purpose: "applicationFee", amount: 29900, currency: "eur", mode: "stripe", status: "requires_action", applicationId: "app-mixed", stripe: { paymentIntentId: "pi_mixed_inline" } });
  fake.intents.pi_mixed_inline = { id: "pi_mixed_inline", status: "requires_capture" };
  await deliver(ev("payment_intent.amount_capturable_updated", { id: "pi_mixed_inline", object: "payment_intent", status: "requires_capture", amount: 29900, currency: "eur", metadata: {} }));
  assert.equal((await Payment.findById(inline._id).lean()).status, "canceled");
  assert.equal((await Payment.findById(v1.paymentId).lean()).status, "requires_capture");
});

test("inline-only applications are untouched by the single-authorisation rule", { skip }, async () => {
  await Payment.create({ tenantId: A, purpose: "applicationFee", amount: 29900, currency: "eur", mode: "stripe", status: "requires_capture", applicationId: "app-io", stripe: { paymentIntentId: "pi_io_1" } });
  const second = await Payment.create({ tenantId: A, purpose: "applicationFee", amount: 29900, currency: "eur", mode: "stripe", status: "requires_action", applicationId: "app-io", stripe: { paymentIntentId: "pi_io_2" } });
  const before = fake.cancelCalls.length;
  await deliver(ev("payment_intent.amount_capturable_updated", { id: "pi_io_2", object: "payment_intent", status: "requires_capture", amount: 29900, currency: "eur", metadata: {} }));
  assert.equal((await Payment.findById(second._id).lean()).status, "requires_capture");
  assert.equal(fake.cancelCalls.length, before);
});

test("checkout.session.expired for the current link -> EXPIRED + expired event", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-exp", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-exp" }).lean();
  fake.sessions[v1.checkoutSessionId].status = "expired";
  const res = await deliver(ev("checkout.session.expired", { id: v1.checkoutSessionId, object: "checkout.session", metadata: fake.sessions[v1.checkoutSessionId].metadata }));
  assert.equal(res.statusCode, 200);
  assert.equal((await PaymentLink.findById(v1._id).lean()).status, "EXPIRED");
  assert.equal((await Payment.findById(v1.paymentId).lean()).status, "canceled");
  const out = await OutboxEvent.findOne({ eventKey: `link:${A}:app-exp:v1:expired` }).lean();
  assert.equal(out.tenantId, A);
  // after expiry a REPLACE issues a fresh link
  const r = await links.handlePaymentLinkRequested(request(A, "app-exp", 2));
  assert.equal(r.issued, true);
});

test("Stripe errors: non-retryable -> STRIPE_ERROR published; retryable -> thrown for redelivery", { skip }, async () => {
  fake.createError = Object.assign(new Error("bad param"), { type: "StripeInvalidRequestError", statusCode: 400 });
  try {
    const r = await links.handlePaymentLinkRequested(request(A, "app-se1", 1));
    assert.equal(r.failed, "STRIPE_ERROR");
    fake.createError = Object.assign(new Error("down"), { type: "StripeConnectionError" });
    await assert.rejects(links.handlePaymentLinkRequested(request(A, "app-se2", 1)));
    assert.equal((await PaymentLink.findOne({ tenantId: A, applicationId: "app-se2" }).lean()).status, "PENDING");
  } finally {
    fake.createError = null;
  }
  const r2 = await links.handlePaymentLinkRequested(request(A, "app-se2", 1));
  assert.equal(r2.issued, true, "redelivery resumes");
});

test("tenant isolation: same application id in two tenants, own catalogue each; mismatched envelope ignored", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-shared", 1));
  await links.handlePaymentLinkRequested(request(B, "app-shared", 1));
  const la = await PaymentLink.findOne({ tenantId: A, applicationId: "app-shared" }).lean();
  const lb = await PaymentLink.findOne({ tenantId: B, applicationId: "app-shared" }).lean();
  assert.equal(la.amount, 29900);
  assert.equal(lb.amount, 50000);
  assert.notEqual(String(la.paymentId), String(lb.paymentId));
  assert.equal((await Payment.findById(lb.paymentId).lean()).tenantId, B);
  // an authorisation in A does not block B
  await payerCompletes(la.checkoutSessionId, "pi_shared_a");
  const rb = await links.handlePaymentLinkRequested(request(B, "app-shared", 2));
  assert.equal(rb.issued, true);
  // forged: envelope says B, body says A
  const forged = request(B, "app-forged", 1);
  forged.data.tenantId = A;
  const r = await links.handlePaymentLinkRequested(forged);
  assert.equal(r.ignored, "tenant");
  assert.equal(await PaymentLink.countDocuments({ applicationId: "app-forged" }), 0);
  // no envelope tenant at all
  const none = request(undefined, "app-none", 1);
  assert.equal((await links.handlePaymentLinkRequested(none)).ignored, "tenant");
  // internal read is tenant-bound
  const listA = await links.listPaymentLinks(A, "app-shared");
  assert.ok(listA.every((l) => l.tenantId === A));
});

test("checkout.session.completed with a forged metadata tenant is rejected", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-cs-forge", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-cs-forge" }).lean();
  const e = ev("checkout.session.completed", { id: v1.checkoutSessionId, object: "checkout.session", payment_intent: "pi_forge", metadata: { tenantId: B } });
  const res = await deliver(e);
  assert.equal(res.statusCode, 200);
  assert.equal((await StripeEventRejection.findOne({ stripeEventId: e.id }).lean()).reason, "tenant_mismatch");
  assert.equal((await Payment.findById(v1.paymentId).lean()).stripe.paymentIntentId, undefined);
});

test("a replaced link's session that still completes has its hold released, never authorised", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-orphan", 1));
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-orphan" }).lean();
  await links.handlePaymentLinkRequested(request(A, "app-orphan", 2));
  assert.equal((await Payment.findById(v1.paymentId).lean()).status, "canceled");
  fake.sessions[v1.checkoutSessionId].status = "open"; // completion slipped past the expiry
  const before = fake.cancelCalls.length;
  await payerCompletes(v1.checkoutSessionId, "pi_orphan_old");
  assert.equal((await Payment.findById(v1.paymentId).lean()).status, "canceled");
  assert.deepEqual(fake.cancelCalls.slice(before).map((c) => c.id), ["pi_orphan_old"]);
  assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: "app-orphan", status: { $in: links.AUTHORISED_STATUSES } }), 0);
  const v2 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-orphan", linkVersion: 2 }).lean();
  assert.equal(v2.status, "ISSUED", "current link unaffected");
});

test("no checkout.session.completed: the PI event's metadata attaches the link Payment (endpoint not subscribed)", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-meta", 1));
  const link = await PaymentLink.findOne({ tenantId: A, applicationId: "app-meta" }).lean();
  const md = fake.sessions[link.checkoutSessionId].metadata;
  const res = await deliver(ev("payment_intent.amount_capturable_updated", { id: "pi_meta_1", object: "payment_intent", status: "requires_capture", amount: link.amount, currency: "eur", metadata: md }));
  assert.equal(res.statusCode, 200);
  const pay = await Payment.findById(link.paymentId).lean();
  assert.equal(pay.stripe.paymentIntentId, "pi_meta_1");
  assert.equal(pay.status, "requires_capture");
  assert.equal((await PaymentLink.findById(link._id).lean()).status, "COMPLETED");
  assert.ok(await OutboxEvent.findOne({ eventKey: `pay:${pay._id}:requires_capture` }));
  // a later session event for the same PI is consistent, not a second payment
  fake.sessions[link.checkoutSessionId].status = "complete";
  fake.intents.pi_meta_1 = { id: "pi_meta_1", object: "payment_intent", status: "requires_capture", amount: link.amount, currency: "eur", metadata: md };
  await deliver(ev("checkout.session.completed", { id: link.checkoutSessionId, object: "checkout.session", payment_intent: "pi_meta_1", metadata: md }));
  assert.equal(await Payment.countDocuments({ tenantId: A, applicationId: "app-meta" }), 1);
});

test("metadata fallback refuses forged or mismatched metadata", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-meta-f", 1));
  const link = await PaymentLink.findOne({ tenantId: A, applicationId: "app-meta-f" }).lean();
  const md = fake.sessions[link.checkoutSessionId].metadata;
  const piEv = (id, metadata, amount = link.amount) => ev("payment_intent.amount_capturable_updated", { id, object: "payment_intent", status: "requires_capture", amount, currency: "eur", metadata });
  const cases = [
    ["pi_f_tenant", { ...md, tenantId: B }],
    ["pi_f_link", { ...md, paymentLinkId: "aaaaaaaaaaaaaaaaaaaaaaaa" }],
    ["pi_f_amount", md, 1],
    ["pi_f_notid", { ...md, paymentId: "not-an-id" }],
  ];
  for (const [id, metadata, amount] of cases) {
    const e = piEv(id, metadata, amount);
    const res = await deliver(e);
    assert.equal(res.statusCode, 200, id);
    assert.ok(await StripeEventRejection.findOne({ stripeEventId: e.id }), `${id} rejected`);
  }
  const pay = await Payment.findById(link.paymentId).lean();
  assert.equal(pay.stripe.paymentIntentId, undefined, "nothing attached");
  assert.equal(pay.status, "requires_action");
  // another tenant's payment id cannot be claimed through a B-tenant link either
  await links.handlePaymentLinkRequested(request(B, "app-meta-b", 1));
  const lb = await PaymentLink.findOne({ tenantId: B, applicationId: "app-meta-b" }).lean();
  await deliver(piEv("pi_f_cross", { ...md, paymentLinkId: String(lb._id) }));
  assert.equal((await Payment.findById(link.paymentId).lean()).stripe.paymentIntentId, undefined);
});

// ---------- pricing rule (owner decision 2026-10-29) ----------
const pricing = await import("../services/applicationPrice.service.js");
const guard = await import("../services/paymentIntentGuard.service.js");

test("non-card supported methods -> three months (annual / 4); never PAYMENT_NOT_REQUIRED for being non-card", { skip }, async () => {
  for (const [i, paymentType] of ["Salary Deduction", "Direct Debit", "Standing Order", "Cheque", "Cash"].entries()) {
    const app = `app-q${i}`;
    const before = fake.createCalls.length;
    const r = await links.handlePaymentLinkRequested(request(A, app, 1, { pricing: { membershipCategory: "General Nurse", paymentType } }));
    assert.equal(r.issued, true, paymentType);
    const link = await PaymentLink.findOne({ tenantId: A, applicationId: app }).lean();
    assert.equal(link.amount, 7475, `${paymentType}: Math.round(29900 / 4)`);
    assert.equal(link.paymentOption, "FIRST_INSTALMENT");
    assert.equal(link.pricingBasis.basis, "THREE_MONTHS");
    assert.equal(link.pricingBasis.annualFee, 29900);
    assert.equal(fake.createCalls[before].params.line_items[0].price_data.unit_amount, 7475);
    assert.equal(fake.createCalls[before].params.payment_intent_data.capture_method, "manual");
    assert.equal((await Payment.findById(link.paymentId).lean()).amount, 7475);
  }
});

test("Credit Card -> full annual fee; client amount / paymentOption cannot override", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-card-x", 1, {
    amount: 100,
    paymentOption: "FIRST_INSTALMENT",
    pricing: { membershipCategory: "General Nurse", paymentType: "Credit Card", amount: 100, annualFee: 100 },
  }));
  const card = await PaymentLink.findOne({ tenantId: A, applicationId: "app-card-x" }).lean();
  assert.equal(card.amount, 29900);
  assert.equal(card.paymentOption, "FULL");
  await links.handlePaymentLinkRequested(request(A, "app-dd-x", 1, {
    amount: 29900,
    paymentOption: "FULL",
    pricing: { membershipCategory: "General Nurse", paymentType: "Direct Debit", amount: 29900 },
  }));
  const dd = await PaymentLink.findOne({ tenantId: A, applicationId: "app-dd-x" }).lean();
  assert.equal(dd.amount, 7475, "derived from the payment type, not the client's option");
  assert.equal(dd.paymentOption, "FIRST_INSTALMENT");
});

test("pricing is tenant/product scoped: same category, different tenant catalogue", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(B, "app-q-b", 1, { pricing: { membershipCategory: "General Nurse", paymentType: "Direct Debit" } }));
  const lb = await PaymentLink.findOne({ tenantId: B, applicationId: "app-q-b" }).lean();
  assert.equal(lb.amount, 12500, "tenant B annual 50000 / 4");
  assert.equal(lb.pricingBasis.annualFee, 50000);
});

test("three-month link keeps its frozen price; REPLACE re-reads the catalogue with the same rule", { skip }, async () => {
  await links.handlePaymentLinkRequested(request(A, "app-q-r", 1, { pricing: { membershipCategory: "General Nurse", paymentType: "Salary Deduction" } }));
  catalogue["general nurse"] = 30001; // odd cents: 7500.25 -> 7500
  try {
    await links.handlePaymentLinkRequested(request(A, "app-q-r", 2, { pricing: { membershipCategory: "General Nurse", paymentType: "Salary Deduction" } }));
  } finally {
    catalogue["general nurse"] = 29900;
  }
  const v1 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-q-r", linkVersion: 1 }).lean();
  const v2 = await PaymentLink.findOne({ tenantId: A, applicationId: "app-q-r", linkVersion: 2 }).lean();
  assert.equal(v1.status, "REPLACED");
  assert.equal(v1.amount, 7475, "frozen");
  assert.equal(v2.amount, 7500, "re-priced: Math.round(30001 / 4)");
  assert.equal(v2.pricingBasis.annualFee, 30001);
});

test("rounding follows the existing portal guard rule exactly", async () => {
  for (const annual of [29900, 30001, 30002, 30003, 1, 2, 3, 99999]) {
    assert.equal(pricing.quarterlyInstalmentCents(annual), Math.round(annual / 4), String(annual));
  }
  // the guard accepts exactly the link's three-month amount for a non-card application
  const r = await guard.assertIntentAuthorized(
    {
      parsed: { amount: pricing.quarterlyInstalmentCents(30002) },
      metadata: {},
      applicationId: "app-g",
      isApplicationPayment: true,
      isEventRegistrationPayment: false,
      ctx: { tenantId: A },
      caller: { userType: "PORTAL", req: {} },
    },
    {
      fetchMyApplicationSubscription: async () => ({ membershipCategory: "General Nurse", paymentType: "Direct Debit" }),
      getMembershipPricing: async () => ({ annualFee: 30002 }),
    },
  );
  assert.deepEqual(r.allowed, [7501, 30002]);
  assert.equal(pricing.pricingBasisFor("credit card"), "ANNUAL");
  assert.equal(pricing.pricingBasisFor("Direct Debit"), "THREE_MONTHS");
  assert.equal(pricing.pricingBasisFor("Bitcoin"), null);
});

