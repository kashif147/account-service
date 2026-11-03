// P5 payer binding for event/course PaymentIntents (POST /payments/intents,
// attach-registration, by-stripe) over the REAL app router against a REAL throwaway mongod.
// Stripe is an in-process fake (paymentIntents.create/retrieve on the lib/stripe singleton,
// with a Stripe-like idempotency cache). No live services, no PDP (these routes have none).
//
//   node --test --test-force-exit src/tests/payerBinding.p5.test.mjs
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

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-"));
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payer_binding_test`;
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
  const server = app.listen(0);
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

// ---------------------------------------------------------------- intent creation
test("A1 portal intent records the verified payer and the event target (live portal metadata.eventId shape)", { skip }, async () => {
  const d = await createPortalIntent();
  const p = await row(d.paymentIntentId);
  assert.deepEqual(p.payer, { userId: "member-a", userType: "PORTAL" });
  assert.deepEqual(p.target, { entityType: "event", entityId: EVENT_1 });
  assert.equal(p.registrationId, undefined);
  // top-level entityId also accepted; entityType must agree with purpose
  const top = await createPortalIntent(PORTAL_A, { purpose: "courseRegistration", amount: 7000, currency: "eur", entityType: "course", entityId: COURSE_1 });
  assert.deepEqual((await row(top.paymentIntentId)).target, { entityType: "course", entityId: COURSE_1 });
  const mism = await call("POST", "/api/payments/intents", { auth: PORTAL_A, body: { ...portalIntent(), entityType: "course", entityId: COURSE_1 } });
  assert.equal(mism.status, 400); assert.equal(mism.code, "TARGET_PURPOSE_MISMATCH");
  const none = await call("POST", "/api/payments/intents", { auth: PORTAL_A, body: { purpose: "eventRegistration", amount: 5000, currency: "eur" } });
  assert.equal(none.status, 400); assert.equal(none.code, "TARGET_REQUIRED");
  const bad = await call("POST", "/api/payments/intents", { auth: PORTAL_A, body: portalIntent("not-an-id") });
  assert.equal(bad.status, 400); assert.equal(bad.code, "TARGET_REQUIRED");
});

test("A8 portal intent with a victim's registrationId (body or metadata, same or other amount) -> 400; victim untouched, no clientSecret", { skip }, async () => {
  const victimReg = oid(0xa8);
  seedPi("pi_victim_a8", { status: "requires_capture" });
  const victim = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", amount: 5000, currency: "eur", mode: "stripe",
    status: "requires_capture", registrationId: victimReg, stripe: { paymentIntentId: "pi_victim_a8", clientSecret: "pi_victim_a8_secret_seed" },
    audit: { createdBy: "staff-1" }, payer: { userId: "staff-1", userType: "CRM" }, target: { entityType: "registration", entityId: victimReg },
  });
  for (const body of [
    { ...portalIntent(), registrationId: victimReg },
    { ...portalIntent(), amount: 4000, registrationId: victimReg },
    portalIntent(EVENT_1, { metadata: { eventId: EVENT_1, registrationId: victimReg } }),
    portalIntent(EVENT_1, { metadata: { eventId: EVENT_1, registration_id: victimReg } }),
  ]) {
    const r = await call("POST", "/api/payments/intents", { auth: PORTAL_B, body });
    assert.equal(r.status, 400, r.text.slice(0, 200));
    assert.equal(r.code, "REGISTRATION_ID_NOT_ALLOWED");
    assert.ok(!r.text.includes("pi_victim_a8"), "victim intent never disclosed");
  }
  const v = await Payment.findById(victim._id).lean();
  assert.equal(v.isActiveAttempt, true);
  assert.equal(v.supersededAt ?? null, null);
  assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: victimReg }), 1);
});

test("clientSecret non-disclosure: another payer replaying A's idempotency key never gets A's intent", { skip }, async () => {
  const key = "idem-key-shared-0001";
  const a = await createPortalIntent(PORTAL_A, portalIntent(EVENT_2), { "x-idempotency-key": key });
  // A's own retry with the same key reuses A's intent
  const again = await createPortalIntent(PORTAL_A, portalIntent(EVENT_2), { "x-idempotency-key": key });
  assert.equal(again.paymentIntentId, a.paymentIntentId);
  // B with A's key and byte-identical params
  const r = await call("POST", "/api/payments/intents", { auth: PORTAL_B, body: portalIntent(EVENT_2), headers: { "x-idempotency-key": key } });
  assert.ok(!r.text.includes(a.paymentIntentId), `A's intent id leaked: ${r.status}`);
  assert.ok(!r.text.includes(a.clientSecret), "A's clientSecret leaked");
  const aRow = await row(a.paymentIntentId);
  assert.equal(aRow.isActiveAttempt, true, "A's intent not superseded");
});

test("portal reuse never hands back an intent already attached to a registration", { skip }, async () => {
  const key = "idem-key-attached-0002";
  const a = await createPortalIntent(PORTAL_A, portalIntent(EVENT_2, { amount: 5300 }), { "x-idempotency-key": key });
  const att = await call("POST", `/api/payments/intents/${a.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0x77), { entityId: EVENT_2, amount: 5300 }) });
  assert.equal(att.status, 200, att.text.slice(0, 200));
  const r = await call("POST", "/api/payments/intents", { auth: PORTAL_A, body: portalIntent(EVENT_2, { amount: 5300 }), headers: { "x-idempotency-key": key } });
  assert.ok(!r.text.includes(a.paymentIntentId), `attached intent handed out again: ${r.status}`);
});

test("portal event intent never supersedes unrelated registration payments of the tenant", { skip }, async () => {
  const otherReg = oid(0x51);
  seedPi("pi_other_51");
  const other = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", amount: 9000, currency: "eur", mode: "stripe",
    status: "requires_capture", registrationId: otherReg, isActiveAttempt: true, stripe: { paymentIntentId: "pi_other_51" }, audit: { createdBy: "staff-1" },
  });
  const aIntent = await createPortalIntent(PORTAL_A, portalIntent(EVENT_2, { amount: 9100 }));
  await createPortalIntent(PORTAL_B, portalIntent(EVENT_1, { amount: 9000 }));
  const o = await Payment.findById(other._id).lean();
  assert.equal(o.isActiveAttempt, true, "another registration's payment was superseded");
  // another member's unattached portal intent (no registrationId) stays the active attempt
  const a = await row(aIntent.paymentIntentId);
  assert.equal(a.isActiveAttempt, true, "member A's unattached intent was superseded by member B's");
});

// ---------------------------------------------------------------- attach-registration
test("A1/A7 own attach binds once (200), repeat with same registration is idempotent (200)", { skip }, async () => {
  const d = await createPortalIntent();
  PIS.get(d.paymentIntentId).status = "requires_capture";
  const reg = oid(0xa1);
  const r1 = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  assert.equal(r1.status, 200, r1.text.slice(0, 200));
  assert.equal(r1.data.status, "requires_capture");
  assert.equal(r1.data.alreadyAttached, false);
  const p = await row(d.paymentIntentId);
  assert.equal(p.registrationId, reg);
  assert.equal(p.productCode, "EVT");
  assert.ok(p.attachedAt instanceof Date);
  const r2 = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.alreadyAttached, true);
});

test("A6 sequential re-attach to a different registration -> 409 ALREADY_ATTACHED", { skip }, async () => {
  const d = await createPortalIntent();
  await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xa61)) });
  const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xa62)) });
  assert.equal(r.status, 409); assert.equal(r.code, "ALREADY_ATTACHED");
  assert.equal((await row(d.paymentIntentId)).registrationId, oid(0xa61));
});

test("A6 concurrent attaches of one intent to two registrations -> exactly one wins, the other 409", { skip }, async () => {
  for (let round = 0; round < 5; round += 1) {
    const d = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5000 }));
    const regs = [oid(0xc000 + round * 2), oid(0xc001 + round * 2)];
    const rs = await Promise.all(regs.map((reg) =>
      call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) })));
    const ok = rs.filter((r) => r.status === 200);
    const conflict = rs.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, `round ${round}: ${rs.map((r) => r.status)}`);
    assert.equal(conflict.length, 1);
    const p = await row(d.paymentIntentId);
    assert.ok(regs.includes(p.registrationId));
    assert.equal(p.registrationId, ok[0].data.registrationId);
  }
});

test("A3/A9/A10 other payer, other tenant, CRM on a member's intent -> 403, nothing written", { skip }, async () => {
  const d = await createPortalIntent();
  const reg = oid(0xa3);
  for (const auth of [PORTAL_B, PORTAL_C, CRM]) {
    const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth, body: attachBody(reg) });
    assert.equal(r.status, 403, `${r.status} ${r.code}`);
    assert.equal(r.code, "NOT_OWNER");
  }
  assert.equal((await row(d.paymentIntentId)).registrationId, undefined);
  // by-stripe: owner only (CRM reads tenant-wide; other tenant cannot see it)
  assert.equal((await call("GET", `/api/payments/by-stripe/${d.paymentIntentId}`, { auth: PORTAL_A })).status, 200);
  assert.equal((await call("GET", `/api/payments/by-stripe/${d.paymentIntentId}`, { auth: PORTAL_B })).status, 403);
  assert.equal((await call("GET", `/api/payments/by-stripe/${d.paymentIntentId}`, { auth: PORTAL_C })).status, 403);
  assert.equal((await call("GET", `/api/payments/by-stripe/${d.paymentIntentId}`, { auth: CRM })).status, 200);
});

test("A4/G own intent for event 1 attached to a registration of event 2 / a course -> 409, nothing written", { skip }, async () => {
  const d = await createPortalIntent();
  const reg = oid(0xa4);
  const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg, { entityId: EVENT_2 }) });
  assert.equal(r.status, 409); assert.equal(r.code, "TARGET_MISMATCH");
  const c = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg, { entityType: "course", entityId: COURSE_1, purpose: "courseRegistration" }) });
  assert.equal(c.status, 409); assert.equal(c.code, "PURPOSE_MISMATCH");
  const missing = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: { registrationId: reg } });
  assert.ok([400, 409].includes(missing.status), "an unbound (legacy-client) attach body is refused");
  assert.equal((await row(d.paymentIntentId)).registrationId, undefined);
});

test("A5 body profileId/memberId refused; victim registration that already has a payment refused", { skip }, async () => {
  const d = await createPortalIntent();
  for (const extra of [{ profileId: "p-victim" }, { memberId: "M-VICTIM" }]) {
    const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xa5), extra) });
    assert.equal(r.status, 400); assert.equal(r.code, "FIELD_NOT_ALLOWED");
  }
  const p0 = await row(d.paymentIntentId);
  assert.equal(p0.profileId, undefined); assert.equal(p0.memberId, undefined); assert.equal(p0.registrationId, undefined);
  // victim's CRM-created registration (has its own Payment)
  const victimReg = oid(0xa55);
  await Payment.create({ tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", amount: 5000, currency: "eur", mode: "stripe", status: "requires_capture", registrationId: victimReg, stripe: { paymentIntentId: "pi_victim_a5" }, audit: { createdBy: "staff-1" } });
  const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(victimReg) });
  assert.equal(r.status, 409); assert.equal(r.code, "REGISTRATION_ALREADY_HAS_PAYMENT");
  assert.equal((await row(d.paymentIntentId)).registrationId, undefined);
});

test("A12 amount/currency mismatch vs the row, and live Stripe amount differing from the row -> 409", { skip }, async () => {
  const d = await createPortalIntent();
  for (const extra of [{ amount: 4999 }, { currency: "usd" }, { amount: 5000.5 }, { amount: undefined }]) {
    const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xa12), extra) });
    assert.equal(r.status, 409); assert.equal(r.code, "AMOUNT_MISMATCH");
  }
  assert.equal((await row(d.paymentIntentId)).registrationId, undefined);
  const d2 = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 6000 }));
  PIS.get(d2.paymentIntentId).amount = 100; // live PI differs from the stored row
  const r = await call("POST", `/api/payments/intents/${d2.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xa121), { amount: 6000 }) });
  assert.equal(r.status, 409); assert.equal(r.code, "STRIPE_MISMATCH");
  assert.equal((await row(d2.paymentIntentId)).registrationId, undefined);
});

test("A14 legacy Payment without payer/target: owner via audit.createdBy; metadata.eventId must agree", { skip }, async () => {
  seedPi("pi_legacy_1"); seedPi("pi_legacy_2"); seedPi("pi_legacy_3");
  const mk = (pi, metadata) => Payment.create({ tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", amount: 5000, currency: "eur", mode: "stripe", status: "requires_capture", stripe: { paymentIntentId: pi }, metadata, audit: { createdBy: "member-a", updatedBy: "member-a" } });
  await mk("pi_legacy_1", { eventId: EVENT_1 });
  await mk("pi_legacy_2", { eventId: EVENT_1 });
  await mk("pi_legacy_3", {});
  assert.equal((await row("pi_legacy_1")).payer, undefined);
  assert.equal((await call("POST", "/api/payments/intents/pi_legacy_1/attach-registration", { auth: PORTAL_B, body: attachBody(oid(0x141)) })).status, 403);
  assert.equal((await call("POST", "/api/payments/intents/pi_legacy_1/attach-registration", { auth: CRM, body: attachBody(oid(0x141)) })).status, 403);
  const ok = await call("POST", "/api/payments/intents/pi_legacy_1/attach-registration", { auth: PORTAL_A, body: attachBody(oid(0x141)) });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  const wrong = await call("POST", "/api/payments/intents/pi_legacy_2/attach-registration", { auth: PORTAL_A, body: attachBody(oid(0x142), { entityId: EVENT_2 }) });
  assert.equal(wrong.status, 409); assert.equal(wrong.code, "TARGET_MISMATCH");
  const noHint = await call("POST", "/api/payments/intents/pi_legacy_3/attach-registration", { auth: PORTAL_A, body: attachBody(oid(0x143)) });
  assert.equal(noHint.status, 200);
  // payer, when present, is authoritative over audit.createdBy
  seedPi("pi_payer_wins");
  await Payment.create({ tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", amount: 5000, currency: "eur", mode: "stripe", status: "requires_capture", stripe: { paymentIntentId: "pi_payer_wins" }, audit: { createdBy: "member-a" }, payer: { userId: "member-b", userType: "PORTAL" }, target: { entityType: "event", entityId: EVENT_1 } });
  assert.equal((await call("GET", "/api/payments/by-stripe/pi_payer_wins", { auth: PORTAL_A })).status, 403);
  assert.equal((await call("GET", "/api/payments/by-stripe/pi_payer_wins", { auth: PORTAL_B })).status, 200);
});

test("intents events-service creates as CRM keep a registration target and stay re-usable by CRM retry", { skip }, async () => {
  const reg = oid(0xe5);
  const body = { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" };
  const r1 = await call("POST", "/api/payments/intents", { auth: CRM, body });
  assert.equal(r1.status, 200, r1.text.slice(0, 200));
  const p = await row(r1.data.paymentIntentId);
  assert.deepEqual(p.target, { entityType: "registration", entityId: reg });
  assert.deepEqual(p.payer, { userId: "staff-1", userType: "CRM" });
  // a different CRM staff member's retry-payment reuses the same intent
  const r2 = await call("POST", "/api/payments/intents", { auth: bearer({ userType: "CRM", id: "staff-2" }), body });
  assert.equal(r2.data.paymentIntentId, r1.data.paymentIntentId);
  // internal S2S call: payer has no (unverified) user id
  // (#19, deployed: an internal call carrying an unverified x-user-* identity is refused outright, 401
  // UNVERIFIED_IDENTITY; before #19 it was accepted and the spoofed id ignored.)
  const spoofed = await call("POST", "/api/payments/intents", { headers: { "x-internal-request": "true", "x-tenant-id": TA, "x-user-id": "spoofed" }, body: { ...body, registrationId: oid(0xe6) } });
  assert.equal(spoofed.status, 401); assert.equal(spoofed.code, "UNVERIFIED_IDENTITY");
  const r3 = await call("POST", "/api/payments/intents", { headers: { "x-internal-request": "true", "x-tenant-id": TA }, body: { ...body, registrationId: oid(0xe6) } });
  assert.equal(r3.status, 200, r3.text.slice(0, 200));
  assert.deepEqual((await row(r3.data.paymentIntentId)).payer, { userId: null, userType: "INTERNAL" });
});

test("A13 (account side) requires_capture status event carries the PaymentIntent id", { skip }, async () => {
  const reg = oid(0x13);
  seedPi("pi_status_13");
  await Payment.create({ tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", amount: 5000, currency: "eur", mode: "stripe", status: "requires_action", registrationId: reg, stripe: { paymentIntentId: "pi_status_13" }, audit: { createdBy: "member-a" } });
  published.length = 0;
  await payments.reconcileStripeEvent({
    eventId: "evt_13", type: "payment_intent.amount_capturable_updated",
    payment: { paymentIntentId: "pi_status_13", amount: 5000, currency: "eur", status: "requires_capture", metadata: { tenantId: TA } },
  }, { tenantId: TA });
  const ev = published.find((e) => e.type === "payments.events.status.updated.v1");
  assert.ok(ev, "status event published");
  assert.equal(ev.data.registrationId, reg);
  assert.equal(ev.data.paymentIntentId, "pi_status_13");
  assert.ok(ev.data.paymentId);
});

// ---------------------------------------------------------------- P5 batch 5: active registration binding
const holders = (reg) => Payment.find({ tenantId: TA, registrationBinding: reg }).lean();

test("B1 two (and three) DIFFERENT intents concurrently attached to ONE registration -> exactly one binding survives", { skip }, async () => {
  for (let round = 0; round < 6; round += 1) {
    const reg = oid(0xb1000 + round);
    const callers = round % 2 ? [PORTAL_A, PORTAL_B, PORTAL_A] : [PORTAL_A, PORTAL_B];
    const intents = [];
    for (const auth of callers) {
      const d = await createPortalIntent(auth, portalIntent(EVENT_1, { amount: 5100 + round }));
      PIS.get(d.paymentIntentId).status = "requires_capture";
      intents.push({ auth, d });
    }
    const statusBefore = await Promise.all(intents.map(({ d }) => row(d.paymentIntentId).then((p) => p.status)));
    const rs = await Promise.all(intents.map(({ auth, d }) =>
      call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth, body: attachBody(reg, { amount: 5100 + round }) })));
    const ok = rs.filter((r) => r.status === 200);
    assert.equal(ok.length, 1, `round ${round}: ${rs.map((r) => `${r.status}/${r.code}`)}`);
    for (const r of rs.filter((x) => x.status !== 200)) {
      assert.equal(r.status, 409);
      assert.ok(["REGISTRATION_ALREADY_HAS_PAYMENT", "ALREADY_ATTACHED"].includes(r.code), r.code);
    }
    const h = await holders(reg);
    assert.equal(h.length, 1, "exactly one active binding");
    assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: reg }), 1, "exactly one Payment carries the registration");
    for (let i = 0; i < intents.length; i += 1) {
      const p = await row(intents[i].d.paymentIntentId);
      assert.equal(p.status, statusBefore[i], "attach never changes a payment's status");
      if (rs[i].status !== 200) {
        assert.equal(p.registrationId, undefined, "loser stays unattached");
        assert.equal(p.registrationBinding, undefined);
        for (const other of intents) assert.ok(!rs[i].text.includes(other.d.clientSecret), "no clientSecret in a 409");
      }
    }
  }
});

test("B2 concurrent CRM createIntent for one registration -> one binding holder; a losing PaymentIntent is cancelled, never returned", { skip }, async () => {
  // Valid outcomes per request (the race decides which, all are correct):
  //   200                                  -> it is (or reuses) THE holder's intent;
  //   409 REGISTRATION_PAYMENT_HELD        -> it saw the winner's committed live row in the pre-Stripe
  //                                           binding check (releaseRegistrationBinding blocked): it
  //                                           created NO PaymentIntent;
  //   409 REGISTRATION_ALREADY_HAS_PAYMENT -> it passed the pre-check during the race, created a
  //                                           PaymentIntent, and lost at the partial unique index: that
  //                                           intent is cancelled and never persisted as a Payment.
  // Invariant (asserted every round): exactly one holder and one active attempt; every 200 is the
  // holder's intent; no 409 carries a client secret; the holder is never cancelled; every intent
  // created in the round is either the holder's or cancelled; no Payment row references a cancelled one.
  const LOSER_CODES = ["REGISTRATION_PAYMENT_HELD", "REGISTRATION_ALREADY_HAS_PAYMENT"];
  const seen = new Set();
  for (let round = 0; round < 4; round += 1) {
    const reg = oid(0xb2000 + round);
    const body = { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" };
    CANCELLED.length = 0;
    const seqBefore = piSeq;
    const rs = await Promise.all([CRM, bearer({ userType: "CRM", id: "staff-2" }), CRM].map((auth) =>
      call("POST", "/api/payments/intents", { auth, body })));
    const created = Array.from({ length: piSeq - seqBefore }, (_, i) => `pi_test_${seqBefore + i + 1}`);
    const h = await holders(reg);
    const trace = `round ${round}: ${rs.map((r) => `${r.status}/${r.code}`)} created=${created.length} cancelled=${CANCELLED.length}`;
    assert.equal(h.length, 1, trace);
    const holderPi = h[0].stripe.paymentIntentId;
    for (const r of rs) {
      seen.add(r.status === 200 ? "200" : r.code);
      if (r.status === 200) assert.equal(r.data.paymentIntentId, holderPi, "every 200 is the holder's intent");
      else {
        assert.equal(r.status, 409, trace);
        assert.ok(LOSER_CODES.includes(r.code), `unexpected loser code ${r.code} (${trace})`);
        assert.ok(!r.text.includes("_secret_"), "no clientSecret in a 409");
      }
    }
    const active = await Payment.find({ tenantId: TA, registrationId: reg, isActiveAttempt: { $ne: false } }).lean();
    assert.equal(active.length, 1, "one active attempt");
    for (const id of CANCELLED) assert.notEqual(id, holderPi, "the holder is never cancelled");
    for (const id of created) assert.ok(id === holderPi || CANCELLED.includes(id), `intent ${id} neither holder nor cancelled (${trace})`);
    const lostAtIndex = rs.filter((r) => r.code === "REGISTRATION_ALREADY_HAS_PAYMENT").length;
    assert.ok(created.length <= 1 + lostAtIndex, `a HELD loser created an intent (${trace})`);
    for (const id of CANCELLED) assert.equal(await row(id), null, "a cancelled loser intent is never persisted");
  }
  assert.ok(seen.size >= 1);
  // Deterministic HELD interleaving: a request arriving after the holder is committed is refused in the
  // pre-Stripe check (or reuses the holder's own intent) - it never creates a PaymentIntent.
  {
    const reg = oid(0xb2000);
    const body = { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" };
    const seqBefore = piSeq;
    const late = await call("POST", "/api/payments/intents", { auth: bearer({ userType: "CRM", id: "staff-3" }), body });
    const holderPi = (await holders(reg))[0].stripe.paymentIntentId;
    if (late.status === 200) assert.equal(late.data.paymentIntentId, holderPi);
    else { assert.equal(late.status, 409); assert.equal(late.code, "REGISTRATION_PAYMENT_HELD"); assert.ok(!late.text.includes("_secret_")); }
    assert.equal(piSeq, seqBefore, "a late request creates no PaymentIntent");
    assert.equal((await holders(reg)).length, 1);
    seen.add(`late:${late.status === 200 ? "200" : late.code}`);
  }
  if (process.env.B2_TRACE) console.log(`B2_TRACE ${[...seen].sort().join(",")}`);
});

test("B3 legitimate replacement: a cancelled holder is released (REPLACE_RELEASED_BINDING) and the retry intent takes the binding", { skip }, async () => {
  const reg = oid(0xb3);
  const body = { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" };
  const r1 = await call("POST", "/api/payments/intents", { auth: CRM, body });
  assert.equal(r1.status, 200, r1.text.slice(0, 200));
  PIS.get(r1.data.paymentIntentId).status = "canceled";
  const r2 = await call("POST", "/api/payments/intents", { auth: CRM, body });
  assert.equal(r2.status, 200, r2.text.slice(0, 200));
  assert.notEqual(r2.data.paymentIntentId, r1.data.paymentIntentId);
  const old = await row(r1.data.paymentIntentId);
  assert.equal(old.registrationBinding, undefined);
  assert.match(old.bindingReleaseReason, /^REPLACE_RELEASED_BINDING:/);
  const h = await holders(reg);
  assert.equal(h.length, 1);
  assert.equal(h[0].stripe.paymentIntentId, r2.data.paymentIntentId);
  // a requires_payment_method retry still reuses the SAME intent (no replacement)
  const r3 = await call("POST", "/api/payments/intents", { auth: CRM, body });
  assert.equal(r3.data.paymentIntentId, r2.data.paymentIntentId);
});

test("B4 a holder that holds funds is never replaced: amount change on an authorised registration -> 409, holder intact, no new intent", { skip }, async () => {
  const reg = oid(0xb4);
  const body = { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" };
  const r1 = await call("POST", "/api/payments/intents", { auth: CRM, body });
  PIS.get(r1.data.paymentIntentId).status = "requires_capture";
  await Payment.updateOne({ tenantId: TA, "stripe.paymentIntentId": r1.data.paymentIntentId }, { $set: { status: "requires_capture" } });
  const before = piSeq;
  const r2 = await call("POST", "/api/payments/intents", { auth: CRM, body: { ...body, amount: 6500 } });
  assert.equal(r2.status, 409, r2.text.slice(0, 200));
  assert.equal(r2.code, "REGISTRATION_PAYMENT_HELD");
  assert.equal(piSeq, before, "no Stripe PaymentIntent created");
  const p = await row(r1.data.paymentIntentId);
  assert.equal(p.registrationBinding, reg);
  assert.equal(p.isActiveAttempt, true, "the funds-holding attempt is not left superseded");
  assert.equal(p.status, "requires_capture");
});

test("B5 a portal attach can never take over a registration held by a bound intent, and a dead intent cannot attach", { skip }, async () => {
  const reg = oid(0xb5);
  const crm = await call("POST", "/api/payments/intents", { auth: CRM, body: { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" } });
  assert.equal(crm.status, 200);
  const d = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1));
  const r = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg) });
  assert.equal(r.status, 409); assert.equal(r.code, "REGISTRATION_ALREADY_HAS_PAYMENT");
  assert.equal((await holders(reg))[0].stripe.paymentIntentId, crm.data.paymentIntentId);
  // own cancelled intent
  const dead = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5005 }));
  await Payment.updateOne({ tenantId: TA, "stripe.paymentIntentId": dead.paymentIntentId }, { $set: { status: "canceled" } });
  const r2 = await call("POST", `/api/payments/intents/${dead.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xb51), { amount: 5005 }) });
  assert.equal(r2.status, 409); assert.equal(r2.code, "INTENT_NOT_ACTIVE");
});

test("B6 idempotent attach keeps the single binding; the same intent to a different registration is still 409", { skip }, async () => {
  const d = await createPortalIntent(PORTAL_A, portalIntent(EVENT_1, { amount: 5006 }));
  const reg = oid(0xb6);
  const a1 = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg, { amount: 5006 }) });
  const a2 = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(reg, { amount: 5006 }) });
  assert.equal(a1.status, 200); assert.equal(a2.status, 200); assert.equal(a2.data.alreadyAttached, true);
  assert.equal((await holders(reg)).length, 1);
  const a3 = await call("POST", `/api/payments/intents/${d.paymentIntentId}/attach-registration`, { auth: PORTAL_A, body: attachBody(oid(0xb61), { amount: 5006 }) });
  assert.equal(a3.status, 409); assert.equal(a3.code, "ALREADY_ATTACHED");
  assert.equal((await holders(oid(0xb61))).length, 0);
});
