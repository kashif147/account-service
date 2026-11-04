// P5 S1 bound internal payment command (contract sections 3-6): binding resolution, purpose
// allow-list, transition table, server-derived Stripe keys, body-bound idempotency, retries and
// concurrency, over the REAL app router against a REAL throwaway mongod (fake Stripe).
//
//   node --test --test-force-exit src/tests/paymentBoundCommand.p5.test.mjs
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

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-paybound-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-payment-bound-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_bound";
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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-paybound-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_bound_test`;
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

// ---- fake Stripe ----
const PIS = new Map();
const CALLS = [];
stripeClient.paymentIntents.retrieve = async (id) => {
  CALLS.push(["retrieve", id]);
  const pi = PIS.get(id);
  if (!pi) throw Object.assign(new Error("No such payment_intent"), { statusCode: 404 });
  return { ...pi };
};
stripeClient.paymentIntents.capture = async (id, _p, opts = {}) => {
  CALLS.push(["capture", id, opts.idempotencyKey]);
  const pi = PIS.get(id);
  pi.status = "succeeded";
  return { ...pi, latest_charge: null };
};
stripeClient.paymentIntents.cancel = async (id, _p, opts = {}) => {
  CALLS.push(["cancel", id, opts.idempotencyKey]);
  const pi = PIS.get(id);
  pi.status = "canceled";
  return { ...pi };
};
const stripeMutations = (id) => CALLS.filter((c) => c[1] === id && c[0] !== "retrieve").length;

// ---- callers ----
const bearer = ({ tenantId = TA, userType = "CRM", id = "staff-1", permissions = [], roles = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET, { expiresIn: "1h" })}`;
const CRM_FIN = bearer({ id: "staff-am", roles: ["AM"], permissions: ["payments:write", "payments:create", "accounts.admin:write", "accounts.journals:write"] });
const CRM_APP = bearer({ id: "staff-mo", roles: ["MO"], permissions: ["application:write"] });
const CRM_EVW = bearer({ id: "staff-ev", roles: ["EO"], permissions: ["events:write"] });
const CRM_EVC = bearer({ id: "staff-evc", roles: ["EO"], permissions: ["events:create"] });
const CRM_WILD = bearer({ id: "staff-wild", permissions: ["application:*", "events:*"] });
const CRM_EMPTY = bearer({ id: "staff-empty" });
const ASU = bearer({ id: "staff-asu", roles: ["ASU"], permissions: ["*"] });
const PORTAL = bearer({ userType: "PORTAL", id: "member-a", permissions: ["application:write", "events:write", "events:create", "payments:write"] });
const INTERNAL = { "x-internal-request": "true", "x-tenant-id": TA };

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

async function stripeRow({ purpose, tenantId = TA, status = "requires_capture", extra = {} }) {
  const pi = `pi_c_${(seq += 1)}`;
  PIS.set(pi, { id: pi, amount: 5000, currency: "eur", status, metadata: {} });
  const base = {
    tenantId, purpose, amount: 5000, currency: "eur", mode: "stripe", status,
    stripe: { paymentIntentId: pi, status }, audit: { createdBy: "seed" },
  };
  if (purpose === "applicationFee") Object.assign(base, { ledgerDomain: "membership", applicationId: oid() });
  else Object.assign(base, { ledgerDomain: "events", registrationId: oid(), eventCategoryCode: "CPD" });
  const doc = await Payment.create({ ...base, ...extra });
  return { pi, id: String(doc._id), doc };
}
async function manualRow({ status = "manual_review", extra = {} } = {}) {
  const doc = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: oid(), amount: 0,
    currency: "eur", mode: "external", source: "events-service", status, eventCategoryCode: "CPD",
    external: { externalRef: "manual-comp-x" }, audit: { createdBy: "seed" }, ...extra,
  });
  return { id: String(doc._id), doc };
}
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


const cmd = (transition, binding, extra = {}) => ({ binding, transition, reason: "approve", actorUserId: "staff-approver", ...extra });
const appBinding = (r) => ({ domain: "application", applicationId: r.doc.applicationId, purpose: "applicationFee" });
const regBinding = (r, extra = {}) => ({ domain: "registration", registrationId: r.doc.registrationId, purpose: r.doc.purpose, ...extra });
// Contract p5-bound-payment-v1: every bound call carries its canonical Idempotency-Key
// (<domain>:<transition>:<objectId>:<paymentRef>). Helpers add it unless a test overrides the
// header (null = send none).
function canonicalKey(transition, body, pi) {
  const b = body?.binding;
  if (!b || typeof b !== "object") return null;
  const objectId = b.domain === "application" ? b.applicationId : b.registrationId;
  const ref = transition === "capture" || transition === "cancel" ? pi : transition === "manual_record" ? "new" : b.paymentId;
  return [b.domain, transition, objectId, ref].join(":");
}
function keyed(transition, body, pi, headers) {
  const h = { ...INTERNAL, ...headers };
  if (!("Idempotency-Key" in headers)) {
    const k = canonicalKey(transition, body, pi);
    if (k) h["Idempotency-Key"] = k;
  } else if (headers["Idempotency-Key"] == null) delete h["Idempotency-Key"];
  return h;
}
const J_TRANSITION = { "": "manual_record", "/post": "manual_post", "/void": "manual_void" };
const cap = (r, body, headers = {}) => call("POST", `/api/payments/intents/${r.pi}/capture`, { headers: keyed("capture", body, r.pi, headers), body });
const can = (r, body, headers = {}) => call("POST", `/api/payments/intents/${r.pi}/cancel`, { headers: keyed("cancel", body, r.pi, headers), body });
const J = (sfx, body, headers = {}) => call("POST", `/api/journal/events/manual-payment${sfx}`, { headers: keyed(J_TRANSITION[sfx], body, null, headers), body });
const capturesOf = (pi) => CALLS.filter((c) => c[0] === "capture" && c[1] === pi);
// a registration row created under payer binding (#18 shape: target / registrationBinding)
const boundReg = (purpose = "eventRegistration") => stripeRow({ purpose }).then(async (r) => {
  await Payment.collection.updateOne({ _id: r.doc._id }, { $set: { registrationBinding: r.doc.registrationId, target: { entityType: "registration", entityId: r.doc.registrationId } } });
  return r;
});

test.before(async () => {
  if (skip) return;
  for (const [code, type] of [["1400", "Asset"], ["4510", "Income"], ["4520", "Income"], ["4500", "Income"], ["4900", "ContraIncome"]]) {
    await CoA.create({ tenantId: TA, code, description: `acct ${code}`, type });
  }
});

// ------------------------------------------------------------ envelope / caller class
test("B1 internal call without a bound command -> 400 PAYMENT_BINDING_REQUIRED on all five routes; nothing changes", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  const m = await manualRow();
  assert.equal((await cap(r, {})).code, "PAYMENT_BINDING_REQUIRED");
  assert.equal((await can(r, {})).code, "PAYMENT_BINDING_REQUIRED");
  for (const sfx of ["", "/post", "/void"]) {
    const res = await J(sfx, { paymentId: m.id, registrationId: oid(), amount: 0, method: "comp" });
    assert.equal(res.status, 400, sfx); assert.equal(res.code, "PAYMENT_BINDING_REQUIRED", sfx);
  }
  assert.equal(stripeMutations(r.pi), 0);
  assert.equal((await fresh(m.id)).status, "manual_review");
});

test("B2 internal header + any user identity header -> 403 MIXED_IDENTITY (never internal)", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  for (const h of [{ "x-user-id": "staff-1" }, { "x-user-type": "CRM" }, { "x-user-permissions": "[\"application:write\"]" }, { "x-gateway-signature": "x" }]) {
    const res = await cap(r, cmd("capture", appBinding(r)), h);
    assert.equal(res.status, 403, JSON.stringify(h)); assert.equal(res.code, "MIXED_IDENTITY");
  }
  // a user token + x-internal-request is judged as that user (containment path), not internal
  const res = await cap(r, cmd("capture", appBinding(r)), { authorization: CRM_FIN });
  assert.equal(res.status, 403); assert.equal(res.code, "PAYMENT_MUTATION_PERMISSION_REQUIRED");
  assert.equal(stripeMutations(r.pi), 0);
});

test("B3 strict envelope: unknown field, route/transition mismatch, bad reason, missing actor -> 400", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  const good = cmd("capture", appBinding(r));
  for (const [body, code] of [
    [{ ...good, tenantId: TC }, "UNKNOWN_FIELD"],
    [{ ...good, binding: { ...good.binding, profileId: oid() } }, "UNKNOWN_FIELD"],
    [{ ...good, transition: "cancel" }, "TRANSITION_ROUTE_MISMATCH"],
    [{ ...good, reason: "because" }, "REASON_NOT_ALLOWED"],
    [{ ...good, actorUserId: "" }, "ACTOR_REQUIRED"],
    [{ ...good, binding: { ...good.binding, registrationId: oid() } }, "PAYMENT_BINDING_REQUIRED"],
  ]) {
    const res = await cap(r, body);
    assert.equal(res.status, 400, `${code}: ${res.text.slice(0, 160)}`); assert.equal(res.code, code);
  }
  assert.equal(stripeMutations(r.pi), 0);
});

// ------------------------------------------------------------ binding resolution (fail closed)
test("B4 binding must equal the stored row: wrong object / purpose / domain -> 409 (field never named); other tenant 404; unbound 409", { skip }, async () => {
  const a = await stripeRow({ purpose: "applicationFee" });
  const reg = await boundReg("eventRegistration");
  const cases = [
    [a, cmd("capture", { ...appBinding(a), applicationId: oid() }), "PAYMENT_BINDING_MISMATCH"],
    [a, cmd("capture", { domain: "application", applicationId: a.doc.applicationId, purpose: "eventRegistration" }), "PURPOSE_NOT_ALLOWED"],
    [a, cmd("capture", { domain: "registration", registrationId: a.doc.applicationId, purpose: "eventRegistration" }), "PAYMENT_BINDING_MISMATCH"],
    [reg, cmd("capture", regBinding(reg, { purpose: "courseRegistration" })), "PAYMENT_BINDING_MISMATCH"],
    [reg, cmd("capture", regBinding(reg, { paymentId: oid() })), "PAYMENT_BINDING_MISMATCH"],
  ];
  for (const [r, body, code] of cases) {
    const res = await cap(r, body);
    assert.equal(res.status, 409, `${code} ${res.text.slice(0, 200)}`); assert.equal(res.code, code);
    if (code === "PAYMENT_BINDING_MISMATCH") {
      assert.ok(!/applicationId|registrationId|purpose|paymentId/.test(res.text.replace(/"code":"[A-Z_]+"/g, "")), `mismatched field not named: ${res.text.slice(0, 400)}`);
    }
  }
  const other = await stripeRow({ purpose: "applicationFee", tenantId: TC });
  const o = await cap(other, cmd("capture", appBinding(other)));
  assert.equal(o.status, 404); assert.equal(o.code, "PAYMENT_NOT_FOUND");
  const unbound = await stripeRow({ purpose: "applicationFee", extra: { applicationId: undefined } });
  const u = await cap(unbound, cmd("capture", { domain: "application", applicationId: oid(), purpose: "applicationFee" }));
  assert.equal(u.status, 409); assert.equal(u.code, "PAYMENT_UNBOUND");
  for (const r of [a, reg, other, unbound]) assert.equal(stripeMutations(r.pi), 0);
});

test("B4b subscriptionFee + applicationId: unverified without applicationBinding (409, no Stripe call); with it the bound applicationFee command resolves", { skip }, async () => {
  const legacy = await stripeRow({ purpose: "applicationFee", extra: { purpose: "subscriptionFee" } });
  for (const [fn, t] of [[cap, "capture"], [can, "cancel"]]) {
    const res = await fn(legacy, cmd(t, appBinding(legacy), { reason: t === "capture" ? "approve" : "reject" }));
    assert.equal(res.status, 409, res.text.slice(0, 200)); assert.equal(res.code, "PAYMENT_APPLICATION_BINDING_UNVERIFIED");
  }
  assert.equal(stripeMutations(legacy.pi), 0);
  const bound = await stripeRow({ purpose: "applicationFee", extra: { purpose: "subscriptionFee" } });
  await Payment.updateOne({ _id: bound.id }, { $set: { applicationBinding: bound.doc.applicationId } });
  const ok = await cap(bound, cmd("capture", appBinding(bound)));
  assert.equal(ok.status, 200, ok.text.slice(0, 200)); assert.equal(ok.data.captured, true);
  const wrong = await cap(bound, cmd("capture", { ...appBinding(bound), applicationId: oid() }));
  assert.equal(wrong.status, 409); assert.equal(wrong.code, "PAYMENT_BINDING_MISMATCH");
});

test("B5 pre-payer-binding registration row: capture 409 PAYMENT_BINDING_UNVERIFIED, cancel (releasing money) allowed", { skip }, async () => {
  const legacy = await stripeRow({ purpose: "eventRegistration" });
  const c = await cap(legacy, cmd("capture", regBinding(legacy)));
  assert.equal(c.status, 409); assert.equal(c.code, "PAYMENT_BINDING_UNVERIFIED");
  assert.equal(capturesOf(legacy.pi).length, 0);
  const x = await can(legacy, cmd("cancel", regBinding(legacy), { reason: "reject" }));
  assert.equal(x.status, 200, x.text.slice(0, 200)); assert.equal(x.data.status, "canceled");
});

// ------------------------------------------------------------ transitions
test("B6 application capture: 200, server-derived Stripe key, actor recorded as audit only; repeat -> alreadyCaptured, one Stripe capture", { skip }, async () => {
  const r = await stripeRow({ purpose: "applicationFee" });
  const first = await cap(r, cmd("capture", appBinding(r)));
  assert.equal(first.status, 200, first.text.slice(0, 300)); assert.equal(first.data.captured, true);
  const [call1] = capturesOf(r.pi);
  assert.equal(call1[2], `acct:capture:${r.id}:${r.pi}`);
  const row = await fresh(r.id);
  assert.equal(row.status, "succeeded");
  const audit = row.auditHistory.find((e) => e.eventType === "bound.capture");
  assert.ok(audit); assert.equal(audit.source, "internal"); assert.match(audit.message, /actor=staff-approver reason=approve/);
  // retry within the response-cache window: the identical response is replayed
  const replay = await cap(r, cmd("capture", appBinding(r)));
  assert.equal(replay.status, 200); assert.equal(replay.text, first.text);
  // retry after the cache is gone (TTL / restart): state-idempotent, no second Stripe capture
  clearIdempotencyCache();
  const again = await cap(r, cmd("capture", appBinding(r)));
  assert.equal(again.status, 200); assert.equal(again.data.alreadyCaptured, true);
  assert.equal(capturesOf(r.pi).length, 1);
});

test("B7 registration capture with link: set once; a conflicting link -> 409 PROFILE_ALREADY_BOUND before any capture", { skip }, async () => {
  const P1 = oid();
  const r = await boundReg("courseRegistration");
  await Payment.updateOne({ _id: r.doc._id }, { $set: { profileId: P1 } });
  const bad = await cap(r, cmd("capture", regBinding(r), { link: { profileId: oid() } }));
  assert.equal(bad.status, 409); assert.equal(bad.code, "PROFILE_ALREADY_BOUND");
  assert.equal(capturesOf(r.pi).length, 0);
  const ok = await cap(r, cmd("capture", regBinding(r), { link: { profileId: P1, memberId: "M-7" } }));
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  const row = await fresh(r.id);
  assert.equal(row.profileId, P1); assert.equal(row.memberId, "M-7");
  // link refused on application and on cancel
  const a = await stripeRow({ purpose: "applicationFee" });
  assert.equal((await cap(a, cmd("capture", appBinding(a), { link: { profileId: oid() } }))).code, "LINK_NOT_ALLOWED");
  assert.equal((await can(r, cmd("cancel", regBinding(r), { reason: "reject", link: { profileId: P1 } }))).code, "LINK_NOT_ALLOWED");
});

test("B8 superseded attempt: capture 409 PAYMENT_SUPERSEDED, cancel allowed; canceled row capture 409; Stripe not capturable 409 NOT_CAPTURABLE", { skip }, async () => {
  const s = await stripeRow({ purpose: "applicationFee", extra: { isActiveAttempt: false } });
  const c = await cap(s, cmd("capture", appBinding(s)));
  assert.equal(c.status, 409); assert.equal(c.code, "PAYMENT_SUPERSEDED");
  assert.equal((await can(s, cmd("cancel", appBinding(s), { reason: "reject" }))).status, 200);
  assert.equal(capturesOf(s.pi).length, 0);
  // after the cancel, capture is a conflicting transition
  const after = await cap(s, cmd("capture", appBinding(s)));
  assert.equal(after.status, 409);
  const n = await stripeRow({ purpose: "applicationFee", status: "payment_required" });
  PIS.get(n.pi).status = "requires_payment_method";
  const nc = await cap(n, cmd("capture", appBinding(n)));
  assert.equal(nc.status, 409); assert.equal(nc.code, "NOT_CAPTURABLE");
  assert.equal(capturesOf(n.pi).length, 0);
});

test("B9 live Stripe / expected mismatch (amount, currency, tenant metadata) -> 409 STRIPE_MISMATCH, nothing captured", { skip }, async () => {
  for (const mutate of [(pi) => { pi.amount = 4999; }, (pi) => { pi.currency = "gbp"; }, (pi) => { pi.metadata = { tenantId: TC }; }]) {
    const r = await stripeRow({ purpose: "applicationFee" });
    mutate(PIS.get(r.pi));
    const res = await cap(r, cmd("capture", appBinding(r)));
    assert.equal(res.status, 409); assert.equal(res.code, "STRIPE_MISMATCH");
    assert.equal(capturesOf(r.pi).length, 0);
  }
  const r = await stripeRow({ purpose: "applicationFee" });
  const res = await cap(r, cmd("capture", appBinding(r), { expected: { amount: 1, currency: "eur" } }));
  assert.equal(res.status, 409); assert.equal(res.code, "STRIPE_MISMATCH");
  // the transitional CRM user path gets the same Stripe check
  const u = await stripeRow({ purpose: "applicationFee" });
  PIS.get(u.pi).amount = 1;
  const ur = await call("POST", `/api/payments/intents/${u.pi}/capture`, { auth: CRM_APP });
  assert.equal(ur.status, 409); assert.equal(ur.code, "STRIPE_MISMATCH");
});

// ------------------------------------------------------------ idempotency (response cache)
test("B10 Idempotency-Key: only the deterministic form; same key + same body replays; same key + different body -> 409", { skip }, async () => {
  const r = await boundReg();
  const key = `registration:capture:${r.doc.registrationId}:${r.pi}`;
  const wrong = await cap(r, cmd("capture", regBinding(r)), { "Idempotency-Key": "caller-chosen-key-123" });
  assert.equal(wrong.status, 400); assert.equal(wrong.code, "IDEMPOTENCY_KEY_MISMATCH");
  // the pre-contract service-prefixed form is refused too, and a missing key is refused
  const svc = await cap(r, cmd("capture", regBinding(r)), { "Idempotency-Key": `events-service:capture:${r.doc.registrationId}:${r.id}` });
  assert.equal(svc.status, 400); assert.equal(svc.code, "IDEMPOTENCY_KEY_MISMATCH");
  const none = await cap(r, cmd("capture", regBinding(r)), { "Idempotency-Key": null });
  assert.equal(none.status, 400); assert.equal(none.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(capturesOf(r.pi).length, 0);
  const body = cmd("capture", regBinding(r), { link: { profileId: "a00000000000000000000aa1" } });
  const one = await cap(r, body, { "Idempotency-Key": key });
  const two = await cap(r, body, { "Idempotency-Key": key });
  assert.equal(one.status, 200, one.text.slice(0, 200)); assert.equal(two.text, one.text);
  const diff = await cap(r, { ...body, link: { profileId: "a00000000000000000000aa2" } }, { "Idempotency-Key": key });
  assert.equal(diff.status, 409); assert.equal(diff.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(capturesOf(r.pi).length, 1);
  assert.equal((await fresh(r.id)).profileId, "a00000000000000000000aa1");
});

// ------------------------------------------------------------ manual record / post / void
const recordCmd = (registrationId, record = {}, extra = {}) =>
  cmd("manual_record", { domain: "registration", registrationId, purpose: "courseRegistration" }, {
    reason: "crm_add_attendee", record: { amount: 2500, currency: "eur", method: "invoice", eventCategoryCode: "CPD", ...record }, ...extra,
  });

test("B11 manual record: 201 with the bound purpose; identical repeat -> 200 same payment; different -> 409 ALREADY_RECORDED; concurrent -> one row", { skip }, async () => {
  const reg = oid();
  const first = await J("", recordCmd(reg));
  assert.equal(first.status, 201, first.text.slice(0, 200));
  const row = await fresh(first.data.paymentId);
  assert.equal(row.purpose, "courseRegistration"); assert.equal(row.status, "manual_review"); assert.equal(row.audit.createdBy, "internal:staff-approver");
  const replay = await J("", recordCmd(reg));
  assert.equal(replay.status, 201); assert.equal(replay.text, first.text); // cached identical response
  // same key, different body -> 409 from the response cache
  const conflict = await J("", recordCmd(reg, { amount: 9999 }));
  assert.equal(conflict.status, 409); assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  clearIdempotencyCache(); // after TTL / restart the stored state decides
  const again = await J("", recordCmd(reg));
  assert.equal(again.status, 200); assert.equal(again.data.paymentId, first.data.paymentId); assert.equal(again.data.alreadyRecorded, true);
  clearIdempotencyCache();
  const diff = await J("", recordCmd(reg, { amount: 9999 }));
  assert.equal(diff.status, 409); assert.equal(diff.code, "ALREADY_RECORDED");
  const reg2 = oid();
  const both = await Promise.all([J("", recordCmd(reg2)), J("", recordCmd(reg2))]);
  assert.deepEqual(both.map((b) => b.status).sort(), [200, 201]);
  assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: reg2 }), 1);
  const reg3 = oid();
  const race = await Promise.all([J("", recordCmd(reg3)), J("", recordCmd(reg3, { amount: 1 }))]);
  assert.deepEqual(race.map((b) => b.status).sort(), [201, 409]);
  assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: reg3 }), 1);
});

test("B12 manual post / void transition table, incl. concurrent posts posting the GL once", { skip }, async () => {
  const P = oid();
  const reg = oid();
  const rec = await J("", recordCmd(reg));
  const pid = rec.data.paymentId;
  const b = { domain: "registration", registrationId: reg, purpose: "courseRegistration", paymentId: pid };
  // concurrent posts: one posts, the other is a no-op or a 409 - never a second GL entry
  const posts = await Promise.all([1, 2].map(() => J("/post", cmd("manual_post", b, { link: { profileId: P } }))));
  assert.ok(posts.some((p) => p.status === 200 && !p.data.alreadyPosted), posts.map((p) => p.text.slice(0, 120)).join(" | "));
  assert.equal(await GL.countDocuments({ tenantId: TA, docNo: `INV-EVT-${reg}` }), 1);
  assert.equal((await fresh(pid)).status, "payment_required");
  clearIdempotencyCache(); // state-based idempotency (beyond the response cache)
  const repeat = await J("/post", cmd("manual_post", b, { link: { profileId: P } }));
  assert.equal(repeat.status, 200); assert.equal(repeat.data.alreadyPosted, true);
  const v = await J("/void", cmd("manual_void", b, { reason: "reject" }));
  assert.equal(v.status, 409); assert.equal(v.code, "ALREADY_POSTED");

  const reg2 = oid();
  const rec2 = await J("", recordCmd(reg2, { method: "comp", amount: 0 }));
  const b2 = { domain: "registration", registrationId: reg2, purpose: "courseRegistration", paymentId: rec2.data.paymentId };
  assert.equal((await J("/void", cmd("manual_void", b2, { reason: "reject" }))).data.voided, true);
  clearIdempotencyCache();
  const v2 = await J("/void", cmd("manual_void", b2, { reason: "reject" }));
  assert.equal(v2.status, 200); assert.equal(v2.data.alreadyVoided, true);
  const p2 = await J("/post", cmd("manual_post", b2, { link: { profileId: P } }));
  assert.equal(p2.status, 409); assert.equal(p2.code, "ALREADY_VOIDED");
  // voiding freed the record key: the registration can be recorded again (once the cached
  // response of the first record has expired - see b7-payment-contract.md "manual_record key")
  clearIdempotencyCache();
  assert.equal((await J("", recordCmd(reg2, { method: "comp", amount: 0 }))).status, 201);
  // a bound post naming a different registration than the row's -> 409
  const mm = await J("/post", cmd("manual_post", { ...b, registrationId: oid() }, { link: { profileId: P } }));
  assert.equal(mm.status, 409); assert.equal(mm.code, "PAYMENT_BINDING_MISMATCH");
});

test("B13 the transitional CRM user path gets the same transition table (post after void -> 409, void after post -> 409)", { skip }, async () => {
  const P = oid();
  const m1 = await manualRow({ status: "canceled" });
  const r1 = await call("POST", "/api/journal/events/manual-payment/post", { auth: CRM_EVW, body: { paymentId: m1.id, method: "comp", profileId: P } });
  assert.equal(r1.status, 409); assert.equal(r1.code, "ALREADY_VOIDED");
  const m2 = await manualRow({ status: "succeeded" });
  const r2 = await call("POST", "/api/journal/events/manual-payment/void", { auth: CRM_EVW, body: { paymentId: m2.id } });
  assert.equal(r2.status, 409); assert.equal(r2.code, "ALREADY_POSTED");
  const m3 = await manualRow({ extra: { external: { externalRef: "manual-invoice-x" } } });
  const r3 = await call("POST", "/api/journal/events/manual-payment/post", { auth: CRM_EVW, body: { paymentId: m3.id, method: "comp", profileId: P } });
  assert.equal(r3.status, 409); assert.equal(r3.code, "METHOD_MISMATCH");
  const r4 = await call("POST", "/api/journal/events/manual-payment", { auth: CRM_EVC, body: { registrationId: oid(), amount: 0, method: "comp", deferPosting: false } });
  assert.equal(r4.status, 400); assert.equal(r4.code, "IMMEDIATE_POST_NOT_SUPPORTED");
});
