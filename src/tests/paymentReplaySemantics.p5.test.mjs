// P5 #25 review proofs (owner brief "CONTROLLED INTEGRATION" section 3), on the payerBindingLegacy
// harness (REAL app router + REAL throwaway mongod + fake Stripe):
//   P1 a voided / MANUAL_TO_CARD-cancelled manual record can never be posted, so it can never confirm a
//      registration: 409 ALREADY_VOIDED, no GL posting, row stays canceled, no posted event published;
//   P2 an identical successful VOID retry keeps its documented success outcome (200-equivalent
//      { voided:false, alreadyVoided:true }), including a void of a record the card switch cancelled;
//   P3 an identical successful POST retry keeps its documented outcome ({ alreadyPosted:true }), GL once;
//   P4 the 1h-expiry fixture signer is accepted, while an EXPIRED token from the same signer is 401 and a
//      token without exp is 401 (a153153 fixtures do not weaken #19's expiry rule).
// Changed-body retry -> 409 is proven over HTTP in paymentContract.p5.test.mjs (IDEMPOTENCY_CONFLICT) and
// paymentBoundCommand.p5.test.mjs B11/B12; see b9-payment-review.md.
//
//   node --test --test-force-exit src/tests/paymentReplaySemantics.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-pay-replay-"));
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-pay-replay-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_replay_semantics_test`;
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
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: CoA } = await import("../models/coa.model.js");
test.before(async () => {
  if (skip) return;
  for (const [code, type] of [["1210", "Asset"], ["1400", "Asset"], ["4500", "Income"], ["4510", "Income"], ["4520", "Income"], ["4900", "ContraIncome"]]) {
    await CoA.create({ tenantId: TA, code, description: `acct ${code}`, type });
  }
});
const publishedFor = (pid) => published.filter((p) => JSON.stringify(p.data || {}).includes(pid)).map((p) => p.type);
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, status: e.status }));

test("P1 a voided or switch-cancelled manual record cannot be posted (so cannot confirm a registration)", { skip }, async () => {
  // (a) explicit void
  const reg = oid(0x9101);
  const rec = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" });
  assert.equal((await listener.voidManualEventPayment({ tenantId: TA, paymentId: rec.paymentId, userId: "staff-1" })).voided, true);
  const evBefore = publishedFor(rec.paymentId).length;
  const gl0 = await GL.countDocuments({ tenantId: TA });
  const post = await settle(listener.postManualEventPaymentPost({ tenantId: TA, paymentId: rec.paymentId, method: "manual", profileId: "p1", userId: "staff-1" }));
  assert.deepEqual({ ok: post.ok, code: post.code }, { ok: false, code: "ALREADY_VOIDED" });
  assert.equal(await GL.countDocuments({ tenantId: TA }), gl0, "nothing posted to the GL");
  assert.equal((await Payment.findById(rec.paymentId).lean()).status, "canceled");
  assert.equal(publishedFor(rec.paymentId).length, evBefore, "no posted/confirm event for a voided record");
  // (b) cancelled by the MANUAL_TO_CARD switch (the L5 case)
  const reg2 = oid(0x9102);
  const rec2 = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg2, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" });
  const card = await call("POST", "/api/payments/intents", { auth: CRM_EVENTS_WRITE, body: crmBody(reg2) });
  assert.equal(card.status, 200, card.text.slice(0, 200));
  const gl1 = await GL.countDocuments({ tenantId: TA });
  const post2 = await settle(listener.postManualEventPaymentPost({ tenantId: TA, paymentId: rec2.paymentId, method: "manual", profileId: "p1", userId: "staff-1" }));
  assert.deepEqual({ ok: post2.ok, code: post2.code }, { ok: false, code: "ALREADY_VOIDED" });
  assert.equal(await GL.countDocuments({ tenantId: TA }), gl1, "nothing posted to the GL");
  // the card intent stays the single holder; the replaced record is not resurrected
  const h = await holders(reg2);
  assert.equal(h.length, 1); assert.equal(h[0].mode, "stripe");
});

test("P2 identical successful VOID retries keep the documented success outcome (explicit void and switch-cancelled record)", { skip }, async () => {
  const reg = oid(0x9201);
  const rec = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 0, currency: "eur", method: "comp", userId: "staff-1" });
  const first = await listener.voidManualEventPayment({ tenantId: TA, paymentId: rec.paymentId, userId: "staff-1" });
  assert.deepEqual(first, { paymentId: rec.paymentId, voided: true });
  for (let i = 0; i < 3; i += 1) {
    const again = await listener.voidManualEventPayment({ tenantId: TA, paymentId: rec.paymentId, userId: "staff-1" });
    assert.deepEqual(again, { paymentId: rec.paymentId, voided: false, alreadyVoided: true }, `retry ${i + 1}`);
  }
  assert.equal((await holders(reg)).length, 0, "binding stays released");
  // void of a record the card switch already cancelled: success, not an error (desired state reached)
  const reg2 = oid(0x9202);
  const rec2 = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg2, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" });
  assert.equal((await call("POST", "/api/payments/intents", { auth: CRM_EVENTS_WRITE, body: crmBody(reg2) })).status, 200);
  const v2 = await listener.voidManualEventPayment({ tenantId: TA, paymentId: rec2.paymentId, userId: "staff-1" });
  assert.deepEqual(v2, { paymentId: rec2.paymentId, voided: false, alreadyVoided: true });
  assert.equal((await holders(reg2))[0].mode, "stripe", "the void retry never releases the card holder");
});

test("P3 identical successful POST retries keep the documented outcome and post the GL once", { skip }, async () => {
  const reg = oid(0x9301);
  const rec = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" });
  const glBase = await GL.countDocuments({ tenantId: TA });
  const first = await listener.postManualEventPaymentPost({ tenantId: TA, paymentId: rec.paymentId, method: "manual", profileId: "p1", userId: "staff-1" });
  assert.notEqual(first.alreadyPosted, true, "first post applies");
  const glAfterFirst = await GL.countDocuments({ tenantId: TA });
  assert.ok(glAfterFirst > glBase, "the first post wrote GL lines");
  const retries = await Promise.all([1, 2, 3].map(() => listener.postManualEventPaymentPost({ tenantId: TA, paymentId: rec.paymentId, method: "manual", profileId: "p1", userId: "staff-1" })));
  for (const r of retries) assert.deepEqual(r, { paymentId: rec.paymentId, alreadyPosted: true });
  assert.equal(await GL.countDocuments({ tenantId: TA }), glAfterFirst, "retries wrote no further GL lines");
  // a void after post is refused (needs a reversal), and the post outcome is unchanged
  const v = await settle(listener.voidManualEventPayment({ tenantId: TA, paymentId: rec.paymentId, userId: "staff-1" }));
  assert.equal(v.code, "ALREADY_POSTED");
});

test("P4 the 1h-expiry fixture signer is accepted; expired and no-exp tokens from the same signer are 401", { skip }, async () => {
  const sign = (opts) => `Bearer ${jwt.sign({ id: "staff-1", sub: "staff-1", tenantId: TA, userType: "CRM", roles: [], permissions: [] }, SECRET, opts)}`;
  const reg = oid(0x9401);
  const ok = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) }); // fixture: expiresIn 1h
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  const expired = await call("POST", "/api/payments/intents", { auth: sign({ expiresIn: -60 }), body: crmBody(oid(0x9402)) });
  assert.equal(expired.status, 401, expired.text.slice(0, 200));
  const noExp = await call("POST", "/api/payments/intents", { auth: sign({}), body: crmBody(oid(0x9403)) });
  assert.equal(noExp.status, 401, noExp.text.slice(0, 200));
  assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: { $in: [oid(0x9402), oid(0x9403)] } }), 0, "refused callers wrote nothing");
});
