// P5 payer binding - PaymentIntent reservation recovery sweep (payments.service.js
// sweepPaymentIntentReservations, scripts/sweep-payment-intent-reservations.js): bounded retries,
// tenant isolation, lease/idempotency, visible terminal failure, no secret logging, not scheduled.
// REAL throwaway mongod + fake Stripe.
//
//   node --test --test-force-exit src/tests/payerBindingSweep.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-sweep-"));
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-payer-sweep-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payer_binding_sweep_test`;
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


const sweepScript = await import("../../scripts/sweep-payment-intent-reservations.js");
let SEARCHES = 0;
stripeClient.paymentIntents.search = async ({ query }) => {
  SEARCHES += 1;
  const m = /metadata\['reservationId'\]:'([^']+)'/.exec(query);
  return { data: [...PIS.values()].filter((pi) => m && pi.metadata && pi.metadata.reservationId === m[1]) };
};
const T0 = Date.now();
const at = (ms) => new Date(T0 + ms);

/** A reservation as createIntent writes it; `primed` = Stripe already created its intent. */
async function seedReservation({ tenantId = TA, reg = oid(Math.floor(Math.random() * 1e9)), primed = true, recordPi = false, ageMs = 3600e3, metaTenant = tenantId } = {}) {
  const id = new mongoose.Types.ObjectId();
  const key = payments.reservationStripeKey(id);
  const metadata = { reservationId: String(id), tenantId: metaTenant };
  let pi = null;
  if (primed) {
    pi = await stripeClient.paymentIntents.create(
      { amount: 5000, currency: "eur", payment_method_types: ["card"], capture_method: "manual", metadata },
      { idempotencyKey: key },
    );
  }
  await PaymentIntentReservation.create({
    _id: id, tenantId, registrationId: reg, purpose: "eventRegistration", stripeIdempotencyKey: key,
    request: { amount: 5000, currency: "eur", captureMethod: "manual", metadata },
    ...(recordPi && pi ? { state: "intent_created", paymentIntentId: pi.id } : {}),
  });
  const old = new Date(T0 - ageMs);
  await PaymentIntentReservation.collection.updateOne({ _id: id }, { $set: { createdAt: old, updatedAt: old } });
  return { id, pi };
}
const resv = (id) => PaymentIntentReservation.findById(id).lean();

test("W1 bounded retries: a cancel that keeps failing becomes terminal needs_attention after maxAttempts; never retried again; still never capturable", { skip }, async () => {
  const { id, pi } = await seedReservation({ recordPi: true });
  const realCancel = stripeClient.paymentIntents.cancel;
  let cancels = 0;
  stripeClient.paymentIntents.cancel = async () => { cancels += 1; throw Object.assign(new Error("stripe down"), { type: "StripeConnectionError" }); };
  try {
    for (let i = 0; i < 3; i += 1) {
      const out = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, maxAttempts: 3, now: at(i * 600e3) });
      assert.equal(out.failed, 1, `attempt ${i + 1}`);
      assert.equal((await resv(id)).state, "orphan_cancel_failed");
    }
    const out4 = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, maxAttempts: 3, now: at(4 * 600e3) });
    assert.equal(out4.needsAttention, 1);
    const r = await resv(id);
    assert.equal(r.state, "needs_attention"); assert.equal(r.attentionReason, "sweep_attempts_exhausted");
    assert.equal(cancels, 3, "exactly maxAttempts Stripe cancels, then stop");
    const out5 = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, maxAttempts: 3, now: at(5 * 600e3) });
    assert.equal(out5.scanned, 0, "terminal state is not picked up again");
  } finally {
    stripeClient.paymentIntents.cancel = realCancel;
  }
  assert.equal(await payments.isOrphanedIntent(pi.id), true);
  const cap = await payments.capturePaymentIntent(pi.id, { tenantId: TA }).then(() => null, (e) => e.code);
  assert.ok(cap, "capture of a needs_attention intent is refused");
});

test("W2 tenant isolation: --tenant scopes the run; another tenant's Payment reference or a metadata mismatch is never cancelled or bound", { skip }, async () => {
  const a = await seedReservation({ tenantId: TA, recordPi: true });
  const c = await seedReservation({ tenantId: TC, recordPi: true });
  const outA = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0) });
  assert.ok(outA.canceled >= 1);
  assert.equal((await resv(a.id)).state, "orphan_canceled");
  assert.equal((await resv(c.id)).state, "intent_created", "other tenant untouched by a scoped run");
  assert.notEqual(PIS.get(c.pi.id).status, "canceled");
  // TA reservation whose intent is referenced by a TC Payment row
  const x = await seedReservation({ tenantId: TA, recordPi: true });
  await Payment.collection.insertOne({ tenantId: TC, purpose: "eventRegistration", amount: 5000, currency: "eur", status: "requires_capture", mode: "stripe", stripe: { paymentIntentId: x.pi.id } });
  const outX = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0) });
  assert.equal(outX.needsAttention, 1);
  const rx = await resv(x.id);
  assert.equal(rx.state, "needs_attention"); assert.equal(rx.attentionReason, "referenced_by_other_tenant");
  assert.notEqual(PIS.get(x.pi.id).status, "canceled", "never cancels another tenant's referenced intent");
  // replayed intent whose metadata names a different tenant
  const m = await seedReservation({ tenantId: TA, primed: true, metaTenant: TC });
  await PaymentIntentReservation.collection.updateOne({ _id: m.id }, { $set: { "request.metadata.tenantId": TC } });
  const outM = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0) });
  assert.equal(outM.needsAttention, 1);
  assert.equal((await resv(m.id)).attentionReason, "intent_metadata_mismatch");
  assert.notEqual(PIS.get(m.pi.id).status, "canceled");
});

test("W3 idempotency: two concurrent sweeps process each reservation once (lease); a re-run is a no-op; replay never creates a second intent", { skip }, async () => {
  const seeds = [];
  for (let i = 0; i < 4; i += 1) seeds.push(await seedReservation({ tenantId: TA, primed: true }));
  const realCancel = stripeClient.paymentIntents.cancel;
  const cancelled = [];
  stripeClient.paymentIntents.cancel = async (pid, ...rest) => { cancelled.push(pid); return realCancel(pid, ...rest); };
  const seqBefore = piSeq;
  try {
    const [o1, o2] = await Promise.all([
      payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0) }),
      payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0) }),
    ]);
    for (const s of seeds) {
      assert.equal((await resv(s.id)).state, "orphan_canceled");
      assert.equal(cancelled.filter((p) => p === s.pi.id).length, 1, "cancelled exactly once");
    }
    assert.equal(o1.canceled + o2.canceled, seeds.length);
    assert.equal(piSeq, seqBefore, "replays returned the original intents");
    const again = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(3600e3) });
    assert.equal(again.canceled + again.bound + again.failed, 0);
  } finally {
    stripeClient.paymentIntents.cancel = realCancel;
  }
});

test("W4 past Stripe's idempotency window: located by metadata search (no replay); nothing found -> terminal no_intent_found", { skip }, async () => {
  const day = 30 * 3600e3;
  const never = await seedReservation({ tenantId: TA, primed: false, ageMs: day });
  const made = await seedReservation({ tenantId: TA, primed: true, ageMs: day });
  const seqBefore = piSeq;
  const searches = SEARCHES;
  const out = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0) });
  assert.equal(piSeq, seqBefore, "no replay create outside the window");
  assert.ok(SEARCHES >= searches + 2);
  assert.equal((await resv(never.id)).state, "no_intent_found");
  assert.equal((await resv(made.id)).state, "orphan_canceled");
  assert.equal(PIS.get(made.pi.id).status, "canceled");
  assert.ok(out.noIntent >= 1 && out.canceled >= 1);
});

test("W5 no secret anywhere: sweep log lines, result and reservation records never carry a client_secret", { skip }, async () => {
  const lines = [];
  await seedReservation({ tenantId: TA, primed: true });
  const realCancel = stripeClient.paymentIntents.cancel;
  stripeClient.paymentIntents.cancel = async () => { throw Object.assign(new Error("boom pi_x_secret_leak"), { type: "StripeAPIError" }); };
  try {
    const out = await payments.sweepPaymentIntentReservations({ olderThanMs: 0, tenantId: TA, now: at(0), log: (l) => lines.push(l) });
    assert.ok(!JSON.stringify(out).includes("_secret_"));
  } finally {
    stripeClient.paymentIntents.cancel = realCancel;
  }
  assert.ok(!lines.join("\n").includes("_secret_"), "log lines are ids/codes only");
  const all = await PaymentIntentReservation.find({}).lean();
  assert.ok(!JSON.stringify(all).includes("_secret_"), "reservations hold no client_secret / message bodies");
});

test("W6 entry script: dry run only reads (no writes, no Stripe); execute delegates to the sweep with masked ids", { skip }, async () => {
  await seedReservation({ tenantId: TA, primed: true });
  const before = JSON.stringify(await PaymentIntentReservation.find({}).sort({ _id: 1 }).lean());
  const seq = piSeq; const searches = SEARCHES;
  const lines = [];
  const dry = await sweepScript.run({ PaymentIntentReservation, sweep: () => { throw new Error("must not run"); } }, { log: (l) => lines.push(l) });
  assert.equal(dry.executed, false); assert.ok(dry.eligible >= 1);
  assert.equal(JSON.stringify(await PaymentIntentReservation.find({}).sort({ _id: 1 }).lean()), before, "dry run wrote nothing");
  assert.equal(piSeq, seq); assert.equal(SEARCHES, searches);
  const ex = await sweepScript.run({ PaymentIntentReservation, sweep: (o) => payments.sweepPaymentIntentReservations({ ...o, olderThanMs: 0, now: at(0) }) }, { execute: true, tenantId: TA, log: (l) => lines.push(l) });
  assert.equal(ex.executed, true);
  assert.ok(!lines.some((l) => /[0-9a-f]{24}/.test(l)), "ids masked in script output");
});

test("W7 not scheduled: nothing outside the service, the entry script and tests calls the sweep", { skip }, async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "logs", "coverage"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|cjs|json|ya?ml|sh)$/.test(e.name) && fs.readFileSync(p, "utf8").includes("sweepPaymentIntentReservations")) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  const allowed = (f) => f === "src/services/payments.service.js" || f === "scripts/sweep-payment-intent-reservations.js" || f.startsWith("src/tests/") || f === "src/models/paymentIntentReservation.model.js";
  assert.deepEqual(hits.filter((f) => !allowed(f)), [], `unexpected callers: ${hits.join(",")}`);
});
