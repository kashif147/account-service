// P5 F1: cancel of a NOT-YET-AUTHORISED intent (requires_payment_method / requires_confirmation /
// requires_action) must cancel at Stripe; the row becomes "canceled" (releasable) in one conditional
// update, and the registration moves on only via the named REPLACE_RELEASED_BINDING transition - over the REAL app router against a REAL throwaway mongod (fake Stripe).
//
//   node --test --test-force-exit src/tests/paymentCancelUnauthorised.p5.test.mjs
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

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-paycancel-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-payment-cancel-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_cancel";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TC = "cccccccccccccccccccccccc";
let seq = 0;
const oid = () => (0xc0000 + (seq += 1)).toString(16).padStart(24, "0");

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-paycancel-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_cancel_f1_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: app } = await import("../app.js");
const { clearIdempotencyCache } = await import("../middlewares/idempotency.js");
const payments = await import("../services/payments.service.js");


// ---- fake Stripe (state machine; cancel failures injectable) ----
const PIS = new Map();
const CALLS = [];
let cancelFailure = null; // null | "network" | "unexpected_state"
let beforeCancel = null; // hook to simulate a concurrent confirm
stripeClient.paymentIntents.retrieve = async (id) => {
  CALLS.push(["retrieve", id]);
  const pi = PIS.get(id);
  if (!pi) throw Object.assign(new Error("No such payment_intent"), { statusCode: 404 });
  return { ...pi };
};
stripeClient.paymentIntents.cancel = async (id, _p, opts = {}) => {
  CALLS.push(["cancel", id, opts.idempotencyKey]);
  if (beforeCancel) { const h = beforeCancel; beforeCancel = null; await h(id); }
  if (cancelFailure === "network") throw Object.assign(new Error("connect ECONNRESET"), { type: "StripeConnectionError" });
  const pi = PIS.get(id);
  if (["succeeded", "processing"].includes(pi.status) || cancelFailure === "unexpected_state") {
    throw Object.assign(new Error("You cannot cancel this PaymentIntent"), { type: "StripeInvalidRequestError", code: "payment_intent_unexpected_state", statusCode: 400 });
  }
  pi.status = "canceled";
  return { ...pi };
};
const cancelsOf = (pi) => CALLS.filter((c) => c[0] === "cancel" && c[1] === pi);

async function call(method, url, { auth, headers = {}, body } = {}) {
  const server = app.listen(0);
  try {
    const h = { "content-type": "application/json", ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: h, body: JSON.stringify(body || {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TA };
const bearer = ({ tenantId = TA, userType = "CRM", id = "staff-1", permissions = [], roles = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET, { expiresIn: "1h" })}`;
const CRM_EVW = bearer({ id: "staff-ev", roles: ["EO"], permissions: ["events:write"] });

async function regRow(stripeStatus, rowStatus = "requires_action") {
  const pi = `pi_f1_${(seq += 1)}`;
  PIS.set(pi, { id: pi, amount: 5000, currency: "eur", status: stripeStatus, metadata: {} });
  const reg = oid();
  const doc = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: reg, eventCategoryCode: "CPD",
    amount: 5000, currency: "eur", mode: "stripe", status: rowStatus, stripe: { paymentIntentId: pi, status: stripeStatus },
    audit: { createdBy: "seed" },
  });
  await Payment.collection.updateOne({ _id: doc._id }, { $set: { registrationBinding: reg, target: { entityType: "registration", entityId: reg } } });
  return { pi, id: String(doc._id), reg };
}
const cancelCmd = (r, reason = "event_cancelled") => ({
  binding: { domain: "registration", registrationId: r.reg, purpose: "eventRegistration" }, transition: "cancel", reason, actorUserId: "staff-approver",
});
const can = (r, body, extraHeaders = {}) => call("POST", `/api/payments/intents/${r.pi}/cancel`, {
  headers: { ...INTERNAL, "Idempotency-Key": `registration:cancel:${r.reg}:${r.pi}`, ...extraHeaders }, body,
});
const fresh = (id) => Payment.findById(id).lean();

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
test.beforeEach(() => { cancelFailure = null; beforeCancel = null; clearIdempotencyCache(); });

for (const s of ["requires_payment_method", "requires_confirmation", "requires_action"]) {
  test(`F1-${s}: bound cancel cancels at Stripe; row canceled and releasable`, { skip }, async () => {
    const r = await regRow(s, s === "requires_payment_method" ? "payment_required" : "requires_action");
    const res = await can(r, cancelCmd(r));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.canceled, true);
    assert.equal(res.data.status, "canceled");
    assert.equal(PIS.get(r.pi).status, "canceled");
    assert.equal(cancelsOf(r.pi).length, 1);
    assert.match(cancelsOf(r.pi)[0][2], new RegExp(`^acct:cancel-${s}:${r.id}:${r.pi}$`));
    const row = await fresh(r.id);
    assert.equal(row.status, "canceled");
    assert.equal(row.stripe.status, "canceled");
    assert.equal(row.registrationBinding, r.reg); // kept until the named replacement transition
    assert.equal(payments.isReleasableBindingRow(row), true);
  });
}

test("F1-retry: identical retry is idempotent (same body), no second Stripe cancel; after cache loss -> alreadyCanceled", { skip }, async () => {
  const r = await regRow("requires_payment_method", "payment_required");
  const a = await can(r, cancelCmd(r));
  const b = await can(r, cancelCmd(r));
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.text, a.text);
  assert.equal(cancelsOf(r.pi).length, 1);
  clearIdempotencyCache();
  const c = await can(r, cancelCmd(r));
  assert.equal(c.status, 200); assert.equal(c.data.alreadyCanceled, true); assert.equal(c.data.status, "canceled");
  assert.equal(cancelsOf(r.pi).length, 1);
  assert.equal(payments.isReleasableBindingRow(await fresh(r.id)), true);
});

test("F1-stripe-failure: a Stripe network failure changes nothing (row, binding) and is retryable", { skip }, async () => {
  const r = await regRow("requires_action");
  cancelFailure = "network";
  const res = await can(r, cancelCmd(r));
  assert.equal(res.status, 502); assert.equal(res.code, "STRIPE_CANCEL_FAILED");
  const row = await fresh(r.id);
  assert.equal(row.status, "requires_action"); assert.equal(row.registrationBinding, r.reg);
  assert.equal(PIS.get(r.pi).status, "requires_action");
  cancelFailure = null;
  const retry = await can(r, cancelCmd(r));
  assert.equal(retry.status, 200, retry.text); assert.equal(retry.data.canceled, true);
  assert.equal(payments.isReleasableBindingRow(await fresh(r.id)), true);
});

test("F1-race-confirm: a confirm that settles the intent while the cancel is in flight -> 502 retryable, nothing released; retry takes the settled branch", { skip }, async () => {
  const r = await regRow("requires_payment_method", "payment_required");
  beforeCancel = async (id) => { PIS.get(id).status = "succeeded"; };
  const res = await can(r, cancelCmd(r));
  assert.equal(res.status, 502, res.text); // Stripe refused (unexpected state): nothing written, caller retries
  const row = await fresh(r.id);
  assert.equal(row.status, "payment_required"); assert.equal(row.registrationBinding, r.reg);
  clearIdempotencyCache();
  // the retry sees the NEW state (succeeded) and takes the reviewed reject-after-capture branch
  const retry = await can(r, cancelCmd(r));
  assert.equal(retry.status, 200); assert.equal(retry.data.status, "refund_required"); assert.equal(retry.data.canceled, false);
  // a captured payment stays bound and is NOT releasable
  const settled = await fresh(r.id);
  assert.equal(settled.registrationBinding, r.reg); assert.equal(payments.isReleasableBindingRow(settled), false);
});

test("F1-race-attach: concurrent cancel + portal attach of the same intent - attach never revives a cancelled intent", { skip }, async () => {
  const r = await regRow("requires_payment_method", "payment_required");
  const [c] = await Promise.all([
    can(r, cancelCmd(r)),
    call("POST", `/api/payments/intents/${r.pi}/attach-registration`, { headers: INTERNAL, body: { registrationId: r.reg } }),
  ]);
  assert.equal(c.status, 200, c.text);
  const row = await fresh(r.id);
  assert.equal(row.status, "canceled");
  assert.equal(PIS.get(r.pi).status, "canceled");
  assert.equal(payments.isReleasableBindingRow(row), true); // attach did not revive it
});

test("F1-processing: Stripe processing -> 409 PAYMENT_PROCESSING, no Stripe cancel, no state change", { skip }, async () => {
  const r = await regRow("processing", "processing");
  const res = await can(r, cancelCmd(r));
  assert.equal(res.status, 409); assert.equal(res.code, "PAYMENT_PROCESSING");
  assert.equal(cancelsOf(r.pi).length, 0);
  assert.equal((await fresh(r.id)).registrationBinding, r.reg);
});

test("F1-succeeded: a captured payment is not cancelled (reviewed reject-after-capture: 200 refund_required), binding kept", { skip }, async () => {
  const r = await regRow("succeeded", "succeeded");
  const res = await can(r, cancelCmd(r, "reject"));
  assert.equal(res.status, 200); assert.equal(res.data.canceled, false); assert.equal(res.data.status, "refund_required");
  assert.equal(cancelsOf(r.pi).length, 0);
  assert.equal((await fresh(r.id)).registrationBinding, r.reg);
});

test("F1-requires_capture: an authorised hold still cancels (key and binding semantics unchanged)", { skip }, async () => {
  const r = await regRow("requires_capture", "requires_capture");
  const res = await can(r, cancelCmd(r, "reject"));
  assert.equal(res.status, 200); assert.equal(res.data.canceled, true);
  assert.match(cancelsOf(r.pi)[0][2], new RegExp(`^acct:cancel:${r.id}:${r.pi}$`)); // key unchanged for holds
  assert.equal(payments.isReleasableBindingRow(await fresh(r.id)), true);
});

test("F1-legacy-CRM: the CRM user path (events:write) gets the same cancel semantics", { skip }, async () => {
  const r = await regRow("requires_payment_method", "payment_required");
  const res = await call("POST", `/api/payments/intents/${r.pi}/cancel`, { auth: CRM_EVW, body: {} });
  assert.equal(res.status, 200, res.text); assert.equal(res.data.canceled, true);
  assert.equal(PIS.get(r.pi).status, "canceled");
  assert.equal(payments.isReleasableBindingRow(await fresh(r.id)), true);
});

test("F1-replacement: after the cancel, REPLACE_RELEASED_BINDING frees the registration and a new intent claims it", { skip }, async () => {
  const r = await regRow("requires_action");
  // the cancel makes the intent terminal at Stripe AND in the row, so the named transition can release it
  assert.equal((await can(r, cancelCmd(r))).status, 200);
  const rel = await payments.releaseRegistrationBinding({ tenantId: TA, registrationId: r.reg, reason: "f1_test" });
  assert.equal(rel.released, true);
  const old = await fresh(r.id);
  assert.equal(old.registrationBinding, undefined); assert.match(old.bindingReleaseReason, /^REPLACE_RELEASED_BINDING:f1_test$/);
  const r2pi = `pi_f1_new_${(seq += 1)}`;
  const doc = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: r.reg, eventCategoryCode: "CPD",
    amount: 5000, currency: "eur", mode: "stripe", status: "requires_action", stripe: { paymentIntentId: r2pi, status: "requires_action" },
    registrationBinding: r.reg, audit: { createdBy: "seed" },
  });
  assert.ok(doc._id); // unique {tenantId, registrationBinding} accepted the new holder
});
