// P5 payer binding, legacy/manual participation + Stripe orphan reconciliation (payments.service.js
// adoptLegacyRegistrationHolder / PaymentIntentReservation / sweepPaymentIntentReservations,
// eventRegistration.approval.listener.js manual record/post/void, scripts/backfill-registration-binding.js).
// Same harness as payerBinding.p5.test.mjs: REAL app router + REAL throwaway mongod + fake Stripe.
//
//   node --test --test-force-exit src/tests/payerBindingLegacy.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-legacy-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-payer-binding-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_payer";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TC = "cccccccccccccccccccccccc";
const EVENT_1 = "e10000000000000000000001";
const EVENT_2 = "e20000000000000000000002";
const COURSE_1 = "c10000000000000000000001";
const oid = (n) => n.toString(16).padStart(24, "0");

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-legacy-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payer_binding_legacy_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
const published = [];
publisher.publish = async (type, data) => { published.push({ type, data }); return { success: true, eventId: "test" }; };
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const payments = await import("../services/payments.service.js");
const { default: app } = await import("../app.js");

// ---- fake Stripe ----
const PIS = new Map();
const idemCache = new Map();
let piSeq = 0;
stripeClient.paymentIntents.create = async (params, opts = {}) => {
  const key = opts.idempotencyKey;
  if (key && idemCache.has(key)) return idemCache.get(key); // Stripe replays the original response
  piSeq += 1;
  const id = `pi_test_${piSeq}`;
  const pi = { id, client_secret: `${id}_secret_${piSeq}`, amount: params.amount, currency: params.currency, status: "requires_payment_method", metadata: params.metadata || {} };
  PIS.set(id, pi);
  if (key) idemCache.set(key, pi);
  return pi;
};
stripeClient.paymentIntents.retrieve = async (id) => {
  const pi = PIS.get(id);
  if (!pi) throw Object.assign(new Error("No such payment_intent"), { statusCode: 404 });
  return { ...pi };
};
const CANCELLED = [];
stripeClient.paymentIntents.cancel = async (id) => {
  CANCELLED.push(id);
  const pi = PIS.get(id);
  if (pi) pi.status = "canceled";
  return { ...(pi || { id }), status: "canceled" };
};
function seedPi(id, { amount = 5000, currency = "eur", status = "requires_capture" } = {}) {
  PIS.set(id, { id, client_secret: `${id}_secret_seed`, amount, currency, status, metadata: {} });
}

// ---- callers ----
const bearer = ({ tenantId = TA, userType, id }) => `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles: [], permissions: [] }, SECRET, { expiresIn: "1h" })}`;
const PORTAL_A = bearer({ userType: "PORTAL", id: "member-a" });
const PORTAL_B = bearer({ userType: "PORTAL", id: "member-b" });
const PORTAL_C = bearer({ tenantId: TC, userType: "PORTAL", id: "member-c" });
const CRM = bearer({ userType: "CRM", id: "staff-1" });
// P5 (b12): the manual-to-card takeover via intent create stands for events retry-payment, a CRM action
// gated by the exact events:write permission - the switch calls use a CRM token carrying it.
const CRM_EVENTS_WRITE = `Bearer ${jwt.sign({ id: "staff-1", sub: "staff-1", tenantId: TA, userType: "CRM", roles: [], permissions: ["events:write"] }, SECRET, { expiresIn: "1h" })}`;

async function call(method, url, { auth, headers = {}, body } = {}) {
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); }); // explicit IPv4 loopback: matches the 127.0.0.1 fetch target
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

const portalIntent = (entity = EVENT_1, extra = {}) => ({
  purpose: "eventRegistration", amount: 5000, currency: "eur",
  metadata: { eventId: entity, eventTitle: "t" }, ...extra,
});
const attachBody = (registrationId, extra = {}) => ({
  registrationId, entityType: "event", entityId: EVENT_1, purpose: "eventRegistration",
  amount: 5000, currency: "eur", productCode: "EVT", eventCategoryCode: "CPD", ...extra,
});
async function createPortalIntent(auth = PORTAL_A, body = portalIntent(), headers = {}) {
  const r = await call("POST", "/api/payments/intents", { auth, body, headers });
  assert.equal(r.status, 200, `create intent: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
}
const row = (pi) => Payment.findOne({ tenantId: TA, "stripe.paymentIntentId": pi }).lean();

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


const { default: PaymentIntentReservation } = await import("../models/paymentIntentReservation.model.js");
const listener = await import("../handlers/eventRegistration.approval.listener.js");
const { planBackfill, run: runBackfill } = await import("../../scripts/backfill-registration-binding.js");

const holders = (reg) => Payment.find({ tenantId: TA, registrationBinding: reg }).lean();
const crmBody = (reg, extra = {}) => ({ purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events", ...extra });

// A pre-binding Payment row exactly as the old code wrote it (no registrationBinding).
async function seedLegacyStripe(reg, { pi, status = "requires_capture", piStatus = status, amount = 5000, isActiveAttempt = true } = {}) {
  seedPi(pi, { amount, status: piStatus });
  const doc = await Payment.collection.insertOne({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: reg,
    amount, currency: "eur", status, mode: "stripe", isActiveAttempt, attemptNumber: 1,
    stripe: { paymentIntentId: pi, status: piStatus }, audit: { createdBy: "staff-1" },
    createdAt: new Date(Date.now() - 3600e3), updatedAt: new Date(Date.now() - 3600e3),
  });
  return doc.insertedId;
}
async function seedLegacyManual(reg, { method = "manual", status = "manual_review", amount = 5000 } = {}) {
  const doc = await Payment.collection.insertOne({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: reg,
    amount, currency: "eur", status, mode: "external", source: "events-service",
    external: { externalRef: `manual-${method}-${reg}` }, audit: { createdBy: "staff-1" },
    createdAt: new Date(Date.now() - 3600e3), updatedAt: new Date(Date.now() - 3600e3),
  });
  return doc.insertedId;
}
const noSecret = (r) => assert.ok(!String(r.text || JSON.stringify(r)).includes("_secret_"), "no clientSecret");

// ------------------------------------------------------------------ legacy participation
test("L1 legacy funds-held row RACING new payments for its registration -> the legacy row is the one holder; every new attempt 409", { skip }, async () => {
  for (let round = 0; round < 4; round += 1) {
    const reg = oid(0x11000 + round);
    const legacyId = await seedLegacyStripe(reg, { pi: `pi_legacy_l1_${round}` });
    const p = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5000 }));
    const rs = await Promise.all([
      call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg, { amount: 6000 }) }),
      call("POST", `/api/payments/intents/${p.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) }),
      call("POST", "/api/payments/intents", { auth: bearer({ userType: "CRM", id: "staff-2" }), body: crmBody(reg, { amount: 7000 }) }),
    ]);
    for (const r of rs) { assert.equal(r.status, 409, `round ${round}: ${r.status}/${r.code}`); noSecret(r); }
    const h = await holders(reg);
    assert.equal(h.length, 1, "exactly one binding");
    assert.equal(String(h[0]._id), String(legacyId), "the legacy funds-held row holds it");
    assert.notEqual(h[0].isActiveAttempt, false, "legacy row not superseded");
    assert.equal(h[0].status, "requires_capture", "legacy status unchanged");
    const live = await Payment.find({ tenantId: TA, registrationId: reg }).lean();
    assert.equal(live.length, 1, "no new Payment row for the registration");
    assert.equal((await row(p.paymentIntentId)).registrationId, undefined, "portal intent not attached");
  }
});

test("L2 legacy unposted manual record racing a card switch and a repeated manual record -> exactly one live holder (MANUAL_TO_CARD cancels the record atomically)", { skip }, async () => {
  for (let round = 0; round < 4; round += 1) {
    const reg = oid(0x12000 + round);
    const manualId = await seedLegacyManual(reg);
    const [card, again] = await Promise.all([
      call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) }),
      listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" })
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, status: e.status || e.statusCode, code: e.code })),
    ]);
    const h = await holders(reg);
    assert.equal(h.length, 1, `round ${round}: card ${card.status}/${card.code} manual ${JSON.stringify(again)}`);
    const manual = await Payment.findById(manualId).lean();
    if (card.status === 200) {
      assert.equal(h[0].stripe?.paymentIntentId, card.data.paymentIntentId);
      assert.equal(manual.status, "canceled", "replaced unposted record is cancelled");
      assert.equal(manual.registrationBinding, undefined);
      assert.equal(manual.bindingReleaseReason, "REPLACE_RELEASED_BINDING:manual_to_card");
    } else {
      assert.equal(String(h[0]._id), String(manualId));
    }
    // the repeated identical record never created a second row
    assert.equal((await Payment.find({ tenantId: TA, registrationId: reg, mode: "external" }).lean()).length, 1);
    if (again.ok) assert.equal(again.v.paymentId, String(manualId));
    else assert.equal(again.code, "REGISTRATION_ALREADY_HAS_PAYMENT");
  }
});

test("L3 two live legacy rows on one registration (ambiguous) -> create and attach fail closed 409 AMBIGUOUS; nothing written or guessed", { skip }, async () => {
  const reg = oid(0x13);
  const a = await seedLegacyStripe(reg, { pi: "pi_legacy_l3a", status: "requires_action", piStatus: "requires_payment_method" });
  const b = await seedLegacyManual(reg);
  const p = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5000 }));
  const before = JSON.stringify(await Payment.find({ tenantId: TA, registrationId: reg }).sort({ _id: 1 }).lean());
  const c = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg, { amount: 6100 }) });
  const t = await call("POST", `/api/payments/intents/${p.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  const m = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "comp", userId: "staff-1" })
    .then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code }));
  assert.equal(c.status, 409); assert.equal(c.code, "REGISTRATION_BINDING_AMBIGUOUS"); noSecret(c);
  assert.equal(t.status, 409); assert.equal(t.code, "REGISTRATION_BINDING_AMBIGUOUS");
  assert.deepEqual(m, { ok: false, code: "REGISTRATION_BINDING_AMBIGUOUS" });
  assert.equal(JSON.stringify(await Payment.find({ tenantId: TA, registrationId: reg }).sort({ _id: 1 }).lean()), before, "legacy rows untouched");
  assert.equal((await holders(reg)).length, 0);
  // CRM resolves by voiding the wrong record -> the remaining live row is adopted on next contention
  await listener.voidManualEventPayment({ tenantId: TA, paymentId: String(b), userId: "staff-1" });
  const c2 = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg, { amount: 6100 }) });
  const dbg = await Payment.find({ tenantId: TA, registrationId: reg }).lean();
  assert.equal((await holders(reg)).length, 1, `c2 ${c2.status}/${c2.code} ${c2.text.slice(0, 160)} rows=${JSON.stringify(dbg.map((d) => [d.status, d.mode, d.isActiveAttempt, d.registrationBinding]))}`);
  assert.ok([200, 409].includes(c2.status));
  void a;
});

test("L4 a POSTED invoice (external payment_required) is never released by a card retry", { skip }, async () => {
  const reg = oid(0x14);
  const inv = await seedLegacyManual(reg, { method: "invoice", status: "payment_required" });
  const c = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) });
  assert.equal(c.status, 409); assert.equal(c.code, "REGISTRATION_PAYMENT_HELD"); noSecret(c);
  const h = await holders(reg);
  assert.equal(h.length, 1); assert.equal(String(h[0]._id), String(inv));
  assert.equal(h[0].status, "payment_required");
});

test("L5 manual void releases the binding atomically; a released (replaced) record can never be posted", { skip }, async () => {
  const reg = oid(0x15);
  const rec = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" });
  assert.equal(String((await holders(reg))[0]._id), rec.paymentId, "new manual record claims the binding at creation");
  const card = await call("POST", "/api/payments/intents", { auth: CRM_EVENTS_WRITE, body: crmBody(reg) });
  assert.equal(card.status, 200, card.text.slice(0, 200));
  const post = await listener.postManualEventPaymentPost({ tenantId: TA, paymentId: rec.paymentId, method: "manual", profileId: "p1", userId: "staff-1" })
    .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code }));
  // OWNER DECISION (P5 integration): a record cancelled by MANUAL_TO_CARD is refused (#22 fail-closed
  // transition), never answered "alreadyPosted" - events treats any 2xx post as paid and would confirm an
  // unpaid registration after a partial failure. Nothing is posted either way.
  assert.deepEqual(post, { ok: false, code: "ALREADY_VOIDED" }, "cancelled record: post is refused");
  // a still-unposted but released record (simulated) is refused
  const reg2 = oid(0x151);
  const rec2 = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg2, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" });
  await Payment.updateOne({ _id: rec2.paymentId }, { $unset: { registrationBinding: "" } });
  await seedLegacyStripe(reg2, { pi: "pi_l5_other", status: "requires_capture" });
  await Payment.updateOne({ "stripe.paymentIntentId": "pi_l5_other" }, { $set: { registrationBinding: reg2 } });
  const post2 = await listener.postManualEventPaymentPost({ tenantId: TA, paymentId: rec2.paymentId, method: "manual", profileId: "p1", userId: "staff-1" })
    .then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code }));
  assert.deepEqual(post2, { ok: false, code: "PAYMENT_NOT_BOUND" });
  assert.equal((await Payment.findById(rec2.paymentId).lean()).status, "manual_review", "nothing posted");
  // void: concurrent double void applies once and releases
  const reg3 = oid(0x152);
  const rec3 = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg3, amount: 5000, currency: "eur", method: "comp", userId: "staff-1" });
  const vs = await Promise.all([1, 2].map(() => listener.voidManualEventPayment({ tenantId: TA, paymentId: rec3.paymentId, userId: "staff-1" })));
  assert.equal(vs.filter((v) => v.voided).length, 1);
  assert.equal((await holders(reg3)).length, 0);
});

test("L6 legacy live row is adopted by an idempotent same-intent reuse instead of being duplicated", { skip }, async () => {
  const reg = oid(0x16);
  await seedLegacyStripe(reg, { pi: "pi_legacy_l6", status: "requires_action", piStatus: "requires_payment_method" });
  const r = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) });
  const h = await holders(reg);
  assert.equal(h.length, 1, `${r.status}/${r.code}`);
  assert.equal(h[0].stripe.paymentIntentId, "pi_legacy_l6", "the legacy row holds the binding");
  if (r.status === 200) assert.equal(r.data.paymentIntentId, "pi_legacy_l6");
});

// ------------------------------------------------------------------ Stripe orphan reconciliation
test("O1 a losing concurrent create whose Stripe cancel FAILS stays a durable orphan: never returned, never capturable/attachable; the sweep cancels it", { skip }, async () => {
  const realCancel = stripeClient.paymentIntents.cancel;
  stripeClient.paymentIntents.cancel = async () => { throw Object.assign(new Error("stripe down"), { type: "StripeConnectionError" }); };
  let orphan = null;
  try {
    for (let round = 0; round < 12 && !orphan; round += 1) {
      const reg = oid(0x01000 + round);
      const rs = await Promise.all([0, 1, 2, 3].map((i) =>
        call("POST", "/api/payments/intents", { auth: bearer({ userType: "CRM", id: `staff-o${i}` }), body: crmBody(reg) })));
      for (const r of rs) if (r.status !== 200) noSecret(r);
      assert.equal((await holders(reg)).length, 1);
      orphan = await PaymentIntentReservation.findOne({ registrationId: reg, state: "orphan_cancel_failed" }).lean();
    }
  } finally {
    stripeClient.paymentIntents.cancel = realCancel;
  }
  assert.ok(orphan, "a losing creation was recorded as orphan_cancel_failed");
  assert.ok(orphan.paymentIntentId);
  assert.equal(await Payment.findOne({ "stripe.paymentIntentId": orphan.paymentIntentId }).lean(), null, "orphan never persisted as a Payment");
  assert.ok(!JSON.stringify(orphan).includes("_secret_"), "reservation holds no client_secret");
  const cap = await payments.capturePaymentIntent(orphan.paymentIntentId, { tenantId: TA }).then(() => null, (e) => e.code);
  assert.equal(cap, "INTENT_ORPHANED");
  // over HTTP the route's owner check refuses first (no Payment row -> not the caller's intent)
  const att = await call("POST", `/api/payments/intents/${orphan.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0x01fff)) });
  assert.ok([403, 404, 409].includes(att.status), `attach refused: ${att.status}`); noSecret(att);
  // and the service itself refuses an orphan even for an internal caller
  const svc = await payments.attachRegistrationToPaymentIntent(orphan.paymentIntentId, { tenantId: TA }, attachBody(oid(0x01fff)), {})
    .then(() => null, (e) => e.code);
  assert.equal(svc, "INTENT_ORPHANED");
  assert.equal(await Payment.findOne({ "stripe.paymentIntentId": orphan.paymentIntentId }).lean(), null);
  const sw = await payments.sweepPaymentIntentReservations({ olderThanMs: 0 });
  assert.ok(sw.canceled >= 1);
  assert.equal((await PaymentIntentReservation.findById(orphan._id).lean()).state, "orphan_canceled");
  assert.equal(PIS.get(orphan.paymentIntentId).status, "canceled");
});

test("O2 process died after Stripe create, before Payment.create: the sweep replays the SAME idempotency key (no second PaymentIntent) and cancels it", { skip }, async () => {
  const reg = oid(0x02);
  const id = new mongoose.Types.ObjectId();
  const key = payments.reservationStripeKey(id);
  const req = { amount: 5000, currency: "eur", captureMethod: "manual", metadata: { reservationId: String(id), tenantId: TA } };
  // Stripe created it (idempotency cache primed) but the process died before recording the id.
  const pi = await stripeClient.paymentIntents.create(
    { amount: 5000, currency: "eur", payment_method_types: ["card"], capture_method: "manual", metadata: req.metadata },
    { idempotencyKey: key },
  );
  await PaymentIntentReservation.create({ _id: id, tenantId: TA, registrationId: reg, purpose: "eventRegistration", stripeIdempotencyKey: key, request: req });
  await PaymentIntentReservation.collection.updateOne({ _id: id }, { $set: { updatedAt: new Date(Date.now() - 3600e3) } });
  const seqBefore = piSeq;
  const sw = await payments.sweepPaymentIntentReservations();
  assert.equal(piSeq, seqBefore, "no new PaymentIntent was created by recovery");
  const r = await PaymentIntentReservation.findById(id).lean();
  assert.equal(r.state, "orphan_canceled"); assert.equal(r.paymentIntentId, pi.id);
  assert.equal(PIS.get(pi.id).status, "canceled");
  assert.ok(sw.canceled >= 1);
});

test("O3 the sweep never cancels a PaymentIntent a Payment row references (bound), and a normal create leaves its reservation bound", { skip }, async () => {
  const reg = oid(0x03);
  const r = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) });
  assert.equal(r.status, 200);
  const res = await PaymentIntentReservation.findOne({ registrationId: reg }).lean();
  assert.equal(res.state, "bound"); assert.equal(res.paymentIntentId, r.data.paymentIntentId);
  // a stale "intent_created" reservation whose PaymentIntent IS persisted -> marked bound, not cancelled
  await PaymentIntentReservation.collection.updateOne({ _id: res._id }, { $set: { state: "intent_created", updatedAt: new Date(Date.now() - 3600e3) } });
  await payments.sweepPaymentIntentReservations();
  assert.equal((await PaymentIntentReservation.findById(res._id).lean()).state, "bound");
  assert.notEqual(PIS.get(r.data.paymentIntentId).status, "canceled");
});

// ------------------------------------------------------------------ backfill script
test("S1 backfill plan: single live row -> bind; dead-only -> none; two live -> ambiguous (not written); already bound -> skip", { skip }, async () => {
  const rel = payments.isReleasableBindingRow;
  const p = planBackfill([
    { _id: 1, tenantId: TA, registrationId: "r1", status: "requires_capture", mode: "stripe" },
    { _id: 2, tenantId: TA, registrationId: "r1", status: "canceled", mode: "stripe" },
    { _id: 3, tenantId: TA, registrationId: "r2", status: "canceled", mode: "stripe" },
    { _id: 4, tenantId: TA, registrationId: "r3", status: "manual_review", mode: "external" },
    { _id: 5, tenantId: TA, registrationId: "r3", status: "requires_action", mode: "stripe" },
    { _id: 6, tenantId: TA, registrationId: "r4", status: "succeeded", mode: "stripe", registrationBinding: "r4" },
    { _id: 7, tenantId: TA, registrationId: "r5", status: "payment_required", mode: "external" },
  ], rel);
  assert.deepEqual(p.toBind.map((r) => r._id).sort(), [1, 7]);
  assert.equal(p.noLiveRow, 1); assert.equal(p.ambiguous.length, 1); assert.equal(p.alreadyBound, 1);
});

test("S2 backfill run: dry run writes nothing; execute needs --backup; execute binds only single-live rows and never overwrites", { skip }, async () => {
  const regA = oid(0x5a), regB = oid(0x5b);
  const a = await seedLegacyStripe(regA, { pi: "pi_s2a", status: "succeeded" });
  await seedLegacyStripe(regB, { pi: "pi_s2b1", status: "requires_capture" });
  await seedLegacyManual(regB);
  const snap = async () => JSON.stringify(await Payment.find({ registrationId: { $in: [regA, regB] } }).sort({ _id: 1 }).lean());
  const before = await snap();
  const dry = await runBackfill({ Payment, isReleasable: payments.isReleasableBindingRow }, {});
  assert.equal(await snap(), before);
  assert.ok(dry.ambiguous >= 1 && dry.toBind >= 1);
  assert.equal((await runBackfill({ Payment, isReleasable: payments.isReleasableBindingRow }, { execute: true })).reason, "BACKUP_REQUIRED");
  const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-")), "b.json");
  const ex = await runBackfill({ Payment, isReleasable: payments.isReleasableBindingRow }, { execute: true, backup });
  assert.ok(ex.bound >= 1);
  assert.equal(String((await holders(regA))[0]._id), String(a));
  assert.equal((await holders(regB)).length, 0, "ambiguous registration untouched");
  assert.ok(JSON.parse(fs.readFileSync(backup, "utf8")).rows.some((r) => r._id === String(a)));
});
