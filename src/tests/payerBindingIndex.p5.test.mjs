// P5 payer binding - index scope and shared guarantee (models/payment.model.js registrationBinding
// partial unique index; payments.service.js createIntent / attachRegistrationToPaymentIntent /
// cancelPaymentIntent; eventRegistration.approval.listener.js postManualEventPayment).
// Same harness as payerBindingLegacy.p5.test.mjs: REAL app router + REAL throwaway mongod + fake Stripe.
//
//   node --test --test-force-exit src/tests/payerBindingIndex.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-index-"));
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-index-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payer_binding_index_test`;
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


// ------------------------------------------------------------------ index definition and scope
test("I1 the binding index is {tenantId, registrationBinding}, unique, partial on string bindings only", { skip }, async () => {
  const idx = (await Payment.collection.indexes()).find((i) => JSON.stringify(i.key) === JSON.stringify({ tenantId: 1, registrationBinding: 1 }));
  assert.ok(idx, "index present after syncIndexes");
  assert.equal(idx.unique, true);
  assert.deepEqual(idx.partialFilterExpression, { registrationBinding: { $type: "string" } });
  assert.equal(idx.sparse, undefined, "partial, not sparse (sparse would still index explicit nulls)");
});

test("I2 rows with NO binding, or binding null, never collide; a string binding is unique per tenant only", { skip }, async () => {
  const reg = oid(0x21);
  const base = { purpose: "eventRegistration", ledgerDomain: "events", amount: 100, currency: "eur", status: "canceled", mode: "stripe" };
  // missing field (legacy shape) x3, explicit null x2, all same tenant + registration
  for (let i = 0; i < 3; i += 1) await Payment.collection.insertOne({ ...base, tenantId: TA, registrationId: reg });
  for (let i = 0; i < 2; i += 1) await Payment.collection.insertOne({ ...base, tenantId: TA, registrationId: reg, registrationBinding: null });
  assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: reg }), 5);
  await Payment.collection.insertOne({ ...base, tenantId: TA, registrationId: reg, registrationBinding: reg });
  await assert.rejects(
    Payment.collection.insertOne({ ...base, tenantId: TA, registrationId: reg, registrationBinding: reg }),
    (e) => e.code === 11000,
    "second holder in the same tenant is refused by the index",
  );
  await Payment.collection.insertOne({ ...base, tenantId: TC, registrationId: reg, registrationBinding: reg }); // other tenant: allowed
  assert.equal((await holders(reg)).length, 1);
});

// ------------------------------------------------------------------ manual + Stripe share the guarantee
test("I3 fresh registration: a CRM card create RACING a manual record -> exactly one holder; the loser writes nothing and never sees a secret", { skip }, async () => {
  for (let round = 0; round < 6; round += 1) {
    const reg = oid(0x23000 + round);
    const [card, manual] = await Promise.all([
      call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) }),
      listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", userId: "staff-1" })
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code })),
    ]);
    const h = await holders(reg);
    assert.equal(h.length, 1, `round ${round}: card ${card.status}/${card.code} manual ${JSON.stringify(manual)}`);
    const rows = await Payment.find({ tenantId: TA, registrationId: reg }).lean();
    if (card.status === 200 && manual.ok) {
      // manual record landed first, then the card create replaced it through the explicit
      // MANUAL_TO_CARD transition: the record is cancelled in the same update that released it
      assert.equal(h[0].mode, "stripe");
      const m = rows.find((r) => r.mode === "external");
      assert.equal(m.status, "canceled"); assert.equal(m.registrationBinding, undefined);
      assert.equal(m.bindingReleaseReason, "REPLACE_RELEASED_BINDING:manual_to_card");
    } else if (card.status === 200) {
      assert.equal(manual.code, "REGISTRATION_ALREADY_HAS_PAYMENT");
      assert.equal(h[0].mode, "stripe");
      assert.equal(rows.filter((r) => r.mode === "external").length, 0, "losing manual record not written");
    } else {
      assert.equal(card.status, 409); noSecret(card);
      assert.equal(manual.ok, true); assert.equal(h[0].mode, "external");
      assert.equal(rows.filter((r) => r.mode === "stripe").length, 0, "losing card intent has no Payment row");
      const res = await PaymentIntentReservation.find({ tenantId: TA, registrationId: reg }).lean();
      for (const r of res) assert.ok(["orphaned", "orphan_canceled", "reserved", "intent_created"].includes(r.state), `reservation ${r.state}`);
    }
  }
});

test("I4 a portal attach RACING a manual record for the same registration -> exactly one holder", { skip }, async () => {
  for (let round = 0; round < 6; round += 1) {
    const reg = oid(0x24000 + round);
    const p = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5000 }));
    const [att, manual] = await Promise.all([
      call("POST", `/api/payments/intents/${p.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) }),
      listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "comp", userId: "staff-1" })
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code })),
    ]);
    const h = await holders(reg);
    assert.equal(h.length, 1, `round ${round}: attach ${att.status}/${att.code} manual ${JSON.stringify(manual)}`);
    assert.ok((att.status === 200) !== manual.ok, "exactly one side won");
    if (att.status !== 200) { assert.equal(att.status, 409); noSecret(att); assert.equal((await row(p.paymentIntentId)).registrationId, undefined); }
  }
});

// ------------------------------------------------------------------ failure between the service updates
test("I5 account attach succeeded but events never recorded it (events rollback/crash): the bound row is visible, an identical re-attach is idempotent, a different intent is refused, and the CRM cancel -> replace path recovers", { skip }, async () => {
  const reg = oid(0x25);
  const p = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5000 }));
  PIS.get(p.paymentIntentId).status = "requires_capture"; // portal authorised before the registration existed
  const a1 = await call("POST", `/api/payments/intents/${p.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  assert.equal(a1.status, 200, a1.text.slice(0, 200));
  // events-side update "fails" here: nothing recorded on the registration. Account state:
  const h = await holders(reg);
  assert.equal(h.length, 1); assert.equal(h[0].stripe.paymentIntentId, p.paymentIntentId);
  // (a) events retries the same attach -> idempotent, same row, no secret
  const a2 = await call("POST", `/api/payments/intents/${p.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  assert.equal(a2.status, 200); noSecret(a2);
  assert.equal((await holders(reg)).length, 1);
  // (b) a different intent can't take the registration
  const q = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5000 }));
  const b = await call("POST", `/api/payments/intents/${q.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  assert.equal(b.status, 409); noSecret(b);
  // a CRM retry while the stranded member intent still holds funds reuses THAT intent (no second
  // PaymentIntent, no double charge) and never discloses the member's clientSecret
  const pisBefore = PIS.size;
  const held = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) });
  assert.equal(held.status, 200, `${held.status}/${held.code}`);
  assert.equal(held.data.paymentIntentId, p.paymentIntentId);
  assert.equal(held.data.clientSecret, null); assert.equal(held.data.secretWithheld, true); noSecret(held);
  assert.equal(PIS.size, pisBefore, "no new PaymentIntent");
  // (c) recovery: CRM cancels the stranded intent; the binding becomes releasable and a new
  // registration-backed intent replaces it through REPLACE_RELEASED_BINDING
  await payments.cancelPaymentIntent(p.paymentIntentId, { tenantId: TA, userId: "staff-1" });
  const c = await call("POST", "/api/payments/intents", { auth: CRM, body: crmBody(reg) });
  assert.equal(c.status, 200, `${c.status}/${c.code}`);
  assert.notEqual(c.data.paymentIntentId, p.paymentIntentId, "a new intent, not the cancelled one");
  const after = await holders(reg);
  assert.equal(after.length, 1); assert.equal(after[0].stripe.paymentIntentId, c.data.paymentIntentId);
  const old = await row(p.paymentIntentId);
  assert.equal(old.registrationBinding, undefined); assert.match(old.bindingReleaseReason, /^REPLACE_RELEASED_BINDING:/);
});

test("I6 withholdForeignPayerSecret: only the PORTAL payer themself gets the secret; CRM-payer rows unchanged", () => {
  const resp = { paymentIntentId: "pi_x", clientSecret: "pi_x_secret_1", checkoutUrl: "https://checkout.invalid/x", status: "requires_capture" };
  const member = { payer: { userId: "member-a", userType: "PORTAL" } };
  const staff = { payer: { userId: "staff-1", userType: "CRM" } };
  assert.equal(payments.withholdForeignPayerSecret(resp, member, { userId: "member-a", userType: "PORTAL" }).clientSecret, "pi_x_secret_1");
  for (const caller of [{ userId: "staff-1", userType: "CRM" }, { userId: "member-b", userType: "PORTAL" }, { userId: null, userType: "INTERNAL" }]) {
    const out = payments.withholdForeignPayerSecret(resp, member, caller);
    assert.equal(out.clientSecret, null); assert.equal(out.checkoutUrl, null); assert.equal(out.secretWithheld, true);
    assert.equal(out.paymentIntentId, "pi_x");
  }
  assert.equal(payments.withholdForeignPayerSecret(resp, staff, { userId: "staff-2", userType: "CRM" }).clientSecret, "pi_x_secret_1", "CRM-created intents keep today's behaviour");
  assert.equal(payments.withholdForeignPayerSecret(resp, {}, { userId: "staff-2" }).clientSecret, "pi_x_secret_1", "legacy row without payer: unchanged");
});
