// P5 F1 (#29) CONTRACT PROOFS (owner gate: CLOSE S2 PROOF GAPS s1). Same harness as
// paymentCancelUnauthorised.p5.test.mjs. Original header:
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

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-paycancel2-"));
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-paycancel2-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_cancel_contract_test`;
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
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); }); // bind loopback v4 explicitly: the request can never reach another 127.0.0.1-only listener
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


// extra fake Stripe surface for the contract proofs (create / confirm / capture), modelled on Stripe:
// a canceled PaymentIntent can never be confirmed or captured (payment_intent_unexpected_state).
let piSeq = 0;
stripeClient.paymentIntents.create = async (params) => {
  piSeq += 1;
  const id = `pi_c2_${piSeq}`;
  const pi = { id, client_secret: `${id}_secret`, amount: params.amount, currency: params.currency, status: "requires_payment_method", metadata: params.metadata || {} };
  PIS.set(id, pi);
  CALLS.push(["create", id]);
  return { ...pi };
};
stripeClient.paymentIntents.confirm = async (id) => {
  CALLS.push(["confirm", id]);
  const pi = PIS.get(id);
  if (!pi || pi.status === "canceled") throw Object.assign(new Error("This PaymentIntent's status is canceled"), { type: "StripeInvalidRequestError", code: "payment_intent_unexpected_state", statusCode: 400 });
  pi.status = "requires_capture";
  return { ...pi };
};
stripeClient.paymentIntents.capture = async (id) => {
  CALLS.push(["capture", id]);
  const pi = PIS.get(id);
  if (!pi || pi.status !== "requires_capture") throw Object.assign(new Error("cannot capture"), { type: "StripeInvalidRequestError", code: "payment_intent_unexpected_state", statusCode: 400 });
  pi.status = "succeeded";
  return { ...pi };
};
const callsOf = (kind, pi) => CALLS.filter((c) => c[0] === kind && c[1] === pi);
const CRM = bearer({ id: "staff-a", roles: ["EO"], permissions: ["events:write"] });
const holders = (reg) => Payment.countDocuments({ tenantId: TA, registrationBinding: reg });
const captureCmd = (r) => ({ binding: { domain: "registration", registrationId: r.reg, purpose: "eventRegistration" }, transition: "capture", reason: "approve", actorUserId: "staff-approver" });
const cap = (r) => call("POST", `/api/payments/intents/${r.pi}/capture`, { headers: { ...INTERNAL, "Idempotency-Key": `registration:capture:${r.reg}:${r.pi}` }, body: captureCmd(r) });
const createForReg = (reg, auth = CRM) => call("POST", "/api/payments/intents", { auth, body: { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" } });

// ---- requirement: cancels an eligible unauthorised intent, and nothing usable is left for a cancelled event ----
test("C1 event_cancelled cancel leaves no usable intent: Stripe canceled, confirm refused, capture refused, attach elsewhere refused", { skip }, async () => {
  const r = await regRow("requires_payment_method", "payment_required");
  const res = await can(r, cancelCmd(r, "event_cancelled"));
  assert.equal(res.status, 200, res.text); assert.equal(res.data.canceled, true);
  assert.equal(PIS.get(r.pi).status, "canceled");
  // the clientSecret holder cannot complete payment: Stripe refuses confirm on a canceled intent
  await assert.rejects(stripeClient.paymentIntents.confirm(r.pi), (e) => e.code === "payment_intent_unexpected_state");
  // the account row cannot be captured
  const c = await cap(r);
  assert.equal(c.status, 409, c.text);
  assert.equal(callsOf("capture", r.pi).length, 0);
  // and cannot be attached to another registration
  const other = oid();
  const a = await call("POST", `/api/payments/intents/${r.pi}/attach-registration`, { headers: INTERNAL, body: { registrationId: other } });
  assert.ok(a.status >= 400 && a.status < 500, `attach elsewhere must be refused, got ${a.status} ${a.text}`);
  const row = await fresh(r.id);
  assert.equal(row.status, "canceled"); assert.equal(row.registrationBinding, r.reg); assert.notEqual(String(row.registrationId), other);
  assert.equal(await holders(other), 0);
});

// ---- requirement: fails closed on processing or ambiguous state ----
test("C2 ambiguous state fails closed: Stripe/row mismatch, unknown Stripe status, Stripe retrieve failure -> no cancel, no write", { skip }, async () => {
  const mism = await regRow("requires_action");
  PIS.get(mism.pi).amount = 9999; // Stripe and the stored row disagree
  const m = await can(mism, cancelCmd(mism));
  assert.equal(m.status, 409); assert.equal(m.code, "STRIPE_MISMATCH");
  const unk = await regRow("requires_action");
  PIS.get(unk.pi).status = "requires_reauthorization"; // a state this contract does not know
  const u = await can(unk, cancelCmd(unk));
  assert.equal(u.status, 409); assert.equal(u.code, "TRANSITION_NOT_ALLOWED");
  const gone = await regRow("requires_action");
  PIS.delete(gone.pi); // Stripe cannot confirm the state at all
  const g = await can(gone, cancelCmd(gone));
  assert.ok(g.status >= 400, g.text);
  const proc = await regRow("processing", "processing");
  const p = await can(proc, cancelCmd(proc));
  assert.equal(p.status, 409); assert.equal(p.code, "PAYMENT_PROCESSING");
  for (const r of [mism, unk, gone, proc]) {
    assert.equal(cancelsOf(r.pi).length, 0, `no Stripe cancel for ${r.pi}`);
    const row = await fresh(r.id);
    assert.notEqual(row.status, "canceled"); assert.equal(row.registrationBinding, r.reg);
  }
});

// ---- requirement: Stripe cancel succeeded but local persistence failed / response lost -> safe retry ----
test("C3 Stripe cancel succeeds but the local update fails: retry sees Stripe canceled and completes locally, no second cancel", { skip }, async () => {
  const r = await regRow("requires_action");
  const orig = Payment.updateOne.bind(Payment);
  let armed = true;
  Payment.updateOne = function (filter, update, ...rest) {
    if (armed && String(filter?._id) === r.id && update?.$set?.status === "canceled") { armed = false; throw new Error("simulated mongo write failure after Stripe cancel"); }
    return orig(filter, update, ...rest);
  };
  try {
    const first = await can(r, cancelCmd(r));
    assert.ok(first.status >= 500, `the failed persistence must surface as an error, got ${first.status}`);
  } finally { Payment.updateOne = orig; }
  assert.equal(PIS.get(r.pi).status, "canceled"); // Stripe already canceled
  assert.equal((await fresh(r.id)).status, "requires_action"); // local row not yet updated
  clearIdempotencyCache();
  const retry = await can(r, cancelCmd(r));
  assert.equal(retry.status, 200, retry.text); assert.equal(retry.data.alreadyCanceled, true); assert.equal(retry.data.status, "canceled");
  assert.equal(cancelsOf(r.pi).length, 1); // never a second Stripe cancel
  const row = await fresh(r.id);
  assert.equal(row.status, "canceled"); assert.equal(row.stripe.status, "canceled");
  assert.equal(payments.isReleasableBindingRow(row), true);
});

test("C3b response lost after a successful cancel: identical retry replays; after cache loss -> alreadyCanceled; one Stripe cancel", { skip }, async () => {
  const r = await regRow("requires_confirmation");
  const lost = await can(r, cancelCmd(r)); // the caller never sees this response
  assert.equal(lost.status, 200);
  const replay = await can(r, cancelCmd(r));
  assert.equal(replay.text, lost.text);
  clearIdempotencyCache();
  const late = await can(r, cancelCmd(r));
  assert.equal(late.status, 200); assert.equal(late.data.alreadyCanceled, true);
  assert.equal(cancelsOf(r.pi).length, 1);
});

// ---- requirement: binding retained until the named release; does not block a legitimate retry ----
test("C4 cancelled binding: kept until REPLACE_RELEASED_BINDING; a legitimate new attempt releases it and becomes the only holder", { skip }, async () => {
  const r = await regRow("requires_payment_method", "payment_required");
  assert.equal((await can(r, cancelCmd(r))).status, 200);
  assert.equal((await fresh(r.id)).registrationBinding, r.reg); // retained after cancel
  assert.equal(await holders(r.reg), 1);
  const next = await createForReg(r.reg);
  assert.equal(next.status, 200, next.text);
  assert.notEqual(next.data.paymentIntentId, r.pi);
  const old = await fresh(r.id);
  assert.equal(old.registrationBinding, undefined);
  assert.match(old.bindingReleaseReason, /^REPLACE_RELEASED_BINDING:/);
  assert.equal(await holders(r.reg), 1);
  const holder = await Payment.findOne({ tenantId: TA, registrationBinding: r.reg }).lean();
  assert.equal(holder.stripe.paymentIntentId, next.data.paymentIntentId);
  // the cancelled intent is still refused for capture after the replacement
  assert.equal((await cap(r)).status, 409);
});

test("C5 concurrent replacement attempts after a cancel: exactly one active holder, losers refused or reuse the holder", { skip }, async () => {
  const r = await regRow("requires_action");
  assert.equal((await can(r, cancelCmd(r))).status, 200);
  const staff = ["s1", "s2", "s3", "s4", "s5"].map((id) => bearer({ id, roles: ["EO"], permissions: ["events:write"] }));
  const results = await Promise.all(staff.map((a) => createForReg(r.reg, a)));
  assert.equal(await holders(r.reg), 1, "never two active holders");
  const holder = await Payment.findOne({ tenantId: TA, registrationBinding: r.reg }).lean();
  assert.notEqual(holder.stripe.paymentIntentId, r.pi);
  for (const x of results) {
    if (x.status === 200) assert.equal(x.data.paymentIntentId, holder.stripe.paymentIntentId, "a 200 is always the holder's intent");
    else assert.equal(x.status, 409, x.text);
  }
  // direct concurrent named releases of the new (live) holder are all blocked: a live attempt is never released
  const rel = await Promise.all([1, 2, 3].map(() => payments.releaseRegistrationBinding({ tenantId: TA, registrationId: r.reg, reason: "race" })));
  assert.equal(rel.filter((x) => x.released).length, 0);
  assert.equal(await holders(r.reg), 1);
});
