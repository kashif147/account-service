// P5 L2: a MANUAL_TO_CARD switch (events retry-payment: CRM card intent for a registration whose
// unposted manual/comp/invoice record is cancelled in the same update that frees its binding) racing a
// repeated / concurrent manual record of the same registration. The card attempt calls Stripe between
// releasing the record and claiming the binding; a manual record in that gap must never create a second
// record and take the registration back.
// REAL app router + REAL throwaway mongod + fake Stripe (with a random delay, to widen the race window).
// Test servers bind 127.0.0.1 explicitly (an app bound on :: can lose 127.0.0.1 requests to another
// local process holding the same port number).
//
//   node --test --test-force-exit src/tests/manualRecordSwitchRace.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-l2-race-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-l2-race-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_l2";
delete process.env.AUTH_BYPASS_ENABLED;

const ROUNDS = Number(process.env.L2_ROUNDS || 100);
const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-l2-race-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/l2_race_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: app } = await import("../app.js");
const listener = await import("../handlers/eventRegistration.approval.listener.js");
const payments = await import("../services/payments.service.js");

// ---- fake Stripe (random 0-8 ms latency on create, so the switch's release -> claim gap is real) ----
const PIS = new Map();
const idemCache = new Map();
let piSeq = 0;
const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 9)));
stripeClient.paymentIntents.create = async (params, opts = {}) => {
  await jitter();
  const key = opts.idempotencyKey;
  if (key && idemCache.has(key)) return idemCache.get(key);
  piSeq += 1;
  const id = `pi_l2_${piSeq}`;
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
stripeClient.paymentIntents.cancel = async (id) => {
  const pi = PIS.get(id);
  if (pi) pi.status = "canceled";
  return { ...(pi || { id }), status: "canceled" };
};

const CRM = `Bearer ${jwt.sign({ id: "staff-1", sub: "staff-1", tenantId: TA, userType: "CRM", roles: [], permissions: ["events:write"] }, SECRET, { expiresIn: "1h" })}`;

let server;
let base;
async function call(method, url, { auth, body } = {}) {
  const h = { "content-type": "application/json" };
  if (auth) h.authorization = auth;
  const res = await fetch(`${base}${url}`, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
}
const crmCard = (reg) => call("POST", "/api/payments/intents", {
  auth: CRM,
  body: { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" },
});
const record = (reg, extra = {}) =>
  listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", userId: "staff-1", ...extra })
    .then((v) => ({ ok: true, v }), (e) => ({ ok: false, status: e.status || e.statusCode, code: e.code }));
const holders = (reg) => Payment.find({ tenantId: TA, registrationBinding: reg }).lean();
const externalRows = (reg) => Payment.find({ tenantId: TA, registrationId: reg, mode: "external" }).lean();

async function seedLegacyManual(reg) {
  const doc = await Payment.collection.insertOne({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: reg,
    amount: 5000, currency: "eur", status: "manual_review", mode: "external", source: "events-service",
    external: { externalRef: `manual-manual-${reg}` }, audit: { createdBy: "staff-1" },
    createdAt: new Date(Date.now() - 3600e3), updatedAt: new Date(Date.now() - 3600e3),
  });
  return doc.insertedId;
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  await Payment.syncIndexes();
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// The race invariant for one round. Returns which side won, for the iteration stats.
async function assertRound(reg, originalId, card, again, label) {
  const h = await holders(reg);
  const ext = await externalRows(reg);
  const detail = `${label}: card ${card.status}/${card.code} manual ${JSON.stringify(again)} holders=${h.length} externalRows=${ext.length}`;
  assert.equal(h.length, 1, `exactly one binding holder - ${detail}`);
  assert.equal(ext.length, 1, `the repeated record never creates a second manual row - ${detail}`);
  assert.equal(String(ext[0]._id), String(originalId), `the only manual row is the original - ${detail}`);
  if (again.ok) assert.equal(again.v.paymentId, String(originalId), `an ok repeat answers the original record - ${detail}`);
  else assert.equal(again.code, "REGISTRATION_ALREADY_HAS_PAYMENT", detail);
  // The card switch always wins now: the repeat can no longer take the registration back.
  assert.equal(card.status, 200, `card switch succeeds - ${detail}`);
  assert.equal(h[0].stripe?.paymentIntentId, card.data.paymentIntentId, `the card attempt holds the registration - ${detail}`);
  const original = await Payment.findById(originalId).lean();
  assert.equal(original.status, "canceled", detail);
  assert.equal(original.bindingReleaseReason, "REPLACE_RELEASED_BINDING:manual_to_card", detail);
  return again.ok ? "repeat-before-switch" : "repeat-refused";
}

test(`R1 ${ROUNDS} rounds: card switch vs repeated manual record (record created by the current code)`, { skip }, async () => {
  const stats = {};
  for (let round = 0; round < ROUNDS; round += 1) {
    const reg = oid(0x21000 + round);
    const first = await record(reg);
    assert.ok(first.ok, JSON.stringify(first));
    const [card, again] = await Promise.all([crmCard(reg), record(reg)]);
    const k = await assertRound(reg, first.v.paymentId, card, again, `R1 round ${round}`);
    stats[k] = (stats[k] || 0) + 1;
  }
  console.log(`[R1] ${ROUNDS} rounds, outcomes ${JSON.stringify(stats)}`);
});

test(`R2 ${ROUNDS} rounds: card switch vs repeated manual record (legacy unbound record)`, { skip }, async () => {
  const stats = {};
  for (let round = 0; round < ROUNDS; round += 1) {
    const reg = oid(0x22000 + round);
    const originalId = await seedLegacyManual(reg);
    const [card, again] = await Promise.all([crmCard(reg), record(reg)]);
    const k = await assertRound(reg, originalId, card, again, `R2 round ${round}`);
    stats[k] = (stats[k] || 0) + 1;
  }
  console.log(`[R2] ${ROUNDS} rounds, outcomes ${JSON.stringify(stats)}`);
});

test("R3 switch in flight (record cancelled + released, card row not yet created) -> record refused, nothing written", { skip }, async () => {
  const reg = oid(0x23001);
  const first = await record(reg);
  const rel = await payments.releaseRegistrationBinding({ tenantId: TA, registrationId: reg, reason: "replacement_attempt", allowManualToCard: true });
  assert.equal(rel.released, true);
  const before = JSON.stringify(await Payment.find({ tenantId: TA, registrationId: reg }).sort({ _id: 1 }).lean());
  const again = await record(reg);
  assert.deepEqual({ ok: again.ok, code: again.code, status: again.status }, { ok: false, code: "REGISTRATION_ALREADY_HAS_PAYMENT", status: 409 });
  assert.equal(JSON.stringify(await Payment.find({ tenantId: TA, registrationId: reg }).sort({ _id: 1 }).lean()), before, "nothing written");
  assert.equal((await holders(reg)).length, 0);
  void first;
});

test("R4 a switch whose card attempt never materialised stops blocking after the window", { skip }, async () => {
  const reg = oid(0x24001);
  const first = await record(reg);
  await payments.releaseRegistrationBinding({ tenantId: TA, registrationId: reg, reason: "replacement_attempt", allowManualToCard: true });
  await Payment.updateOne(
    { _id: first.v.paymentId },
    { $set: { bindingReleasedAt: new Date(Date.now() - listener.MANUAL_TO_CARD_SWITCH_WINDOW_MS - 1000) } },
  );
  const again = await record(reg);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.notEqual(again.v.paymentId, first.v.paymentId, "a new record once the stale switch no longer counts");
  const h = await holders(reg);
  assert.equal(h.length, 1);
  assert.equal(String(h[0]._id), again.v.paymentId);
});

test("R5 a concluded switch whose card later died does not block a legitimate manual record", { skip }, async () => {
  const reg = oid(0x25001);
  const first = await record(reg);
  const card = await crmCard(reg);
  assert.equal(card.status, 200, card.text.slice(0, 200));
  // the card attempt is cancelled (dead, releasable holder)
  await Payment.updateOne({ "stripe.paymentIntentId": card.data.paymentIntentId }, { $set: { status: "canceled", "stripe.status": "canceled" } });
  const again = await record(reg);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.notEqual(again.v.paymentId, first.v.paymentId);
  const h = await holders(reg);
  assert.equal(h.length, 1);
  assert.equal(String(h[0]._id), again.v.paymentId, "the new manual record holds after the dead card is released");
});

test("R6 a concluded switch with a LIVE card refuses the record (normal live-row check), nothing written", { skip }, async () => {
  const reg = oid(0x26001);
  await record(reg);
  const card = await crmCard(reg);
  assert.equal(card.status, 200);
  const before = (await Payment.find({ tenantId: TA, registrationId: reg }).lean()).length;
  const again = await record(reg);
  assert.equal(again.ok, false);
  assert.equal(again.code, "REGISTRATION_ALREADY_HAS_PAYMENT");
  assert.equal((await Payment.find({ tenantId: TA, registrationId: reg }).lean()).length, before);
});

test("R7 identical repeat with no switch still returns the same record (idempotent)", { skip }, async () => {
  const reg = oid(0x27001);
  const a = await record(reg);
  const [b, c] = await Promise.all([record(reg), record(reg)]);
  assert.equal(b.v.paymentId, a.v.paymentId);
  assert.equal(c.v.paymentId, a.v.paymentId);
  assert.equal((await externalRows(reg)).length, 1);
});
