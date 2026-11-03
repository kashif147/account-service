// P5 payment integration (#18 payer binding x #22 bound command): the REAL serialized caller requests
// (recorded from the events-service / profile-service clients, fixtures/p5-recorded-caller-requests.v1.json)
// replayed through the REAL app router against a REAL throwaway mongod (fake Stripe), asserting the
// resulting DB state transitions; plus real concurrency (Promise.all) on the manual lifecycle and
// retries after partial failures.
//
//   node --test --test-force-exit src/tests/paymentIntegration.p5.test.mjs
//
// Skips (does not fail) when no mongod is on PATH and LEDGER_TEST_MONGO_URI is unset.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-payinteg-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-payment-integration-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_integ";
delete process.env.AUTH_BYPASS_ENABLED;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REC = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/p5-recorded-caller-requests.v1.json"), "utf8"));
const PH = REC.placeholders;
const SECRET = process.env.JWT_SECRET;
const TA = PH.tenantId;
let seq = 0;
const oid = () => (0xd0000 + (seq += 1)).toString(16).padStart(24, "0");

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-payinteg-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_integration_test`;
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
const listener = await import("../handlers/eventRegistration.approval.listener.js");

// ---- fake Stripe (create honours idempotency keys like Stripe does) ----
const PIS = new Map();
const CALLS = [];
const idemCache = new Map();
let piSeq = 0;
let failNextCapture = 0;
stripeClient.paymentIntents.create = async (params, opts = {}) => {
  const key = opts.idempotencyKey;
  if (key && idemCache.has(key)) return idemCache.get(key);
  piSeq += 1;
  const id = `pi_integ_${piSeq}`;
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
stripeClient.paymentIntents.capture = async (id, _p, opts = {}) => {
  CALLS.push(["capture", id, opts.idempotencyKey]);
  if (failNextCapture > 0) {
    failNextCapture -= 1;
    throw Object.assign(new Error("simulated Stripe network failure"), { type: "StripeConnectionError" });
  }
  const pi = PIS.get(id);
  pi.status = "succeeded";
  return { ...pi, latest_charge: null };
};
stripeClient.paymentIntents.cancel = async (id, _p, opts = {}) => {
  CALLS.push(["cancel", id, opts.idempotencyKey]);
  const pi = PIS.get(id);
  if (pi) pi.status = "canceled";
  return { ...(pi || { id }), status: "canceled" };
};

const CRM = `Bearer ${jwt.sign({ id: "staff-1", sub: "staff-1", tenantId: TA, userType: "CRM", roles: [], permissions: ["events:write", "events:create"], exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;

async function call(method, url, { auth, headers = {}, body } = {}) {
  // bound to 127.0.0.1 explicitly and awaited, so the request can only reach THIS server instance
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
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

// ---- recorded caller requests: substitute ONLY the placeholder ids ----
function recorded(caller, name, ids = {}) {
  const r = REC.requests[caller].find((x) => x.name === name);
  assert.ok(r, `${caller} ${name} recorded`);
  let s = JSON.stringify(r);
  for (const [k, v] of Object.entries(ids)) if (v != null) s = s.split(PH[k]).join(String(v));
  return JSON.parse(s);
}
function replay(caller, name, ids) {
  const r = recorded(caller, name, ids);
  const headers = { ...r.headers };
  delete headers["Content-Type"];
  return call("POST", r.path, { headers, body: r.body });
}
const ev = (name, ids) => replay("events-service", name, ids);
const pf = (name, ids) => replay("profile-service", name, ids);
const fresh = (id) => Payment.findById(id).lean();
const glFor = (paymentId) => GL.countDocuments({ tenantId: TA, docNo: `RCP-EVT-MANUAL-${paymentId}` });
const holders = (reg) => Payment.find({ tenantId: TA, registrationBinding: String(reg) }).lean();

async function boundStripeReg({ status = "requires_capture" } = {}) {
  piSeq += 1;
  const pi = `pi_integ_seed_${piSeq}`;
  PIS.set(pi, { id: pi, amount: 5000, currency: "eur", status, metadata: {} });
  const reg = oid();
  const doc = await Payment.create({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: reg, registrationBinding: reg,
    target: { entityType: "registration", entityId: reg }, amount: 5000, currency: "eur", mode: "stripe", status,
    stripe: { paymentIntentId: pi, status }, eventCategoryCode: "CPD", audit: { createdBy: "seed" },
  });
  return { pi, reg, id: String(doc._id) };
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  await Payment.syncIndexes();
  for (const [code, type] of [["1210", "Asset"], ["1400", "Asset"], ["4510", "Income"], ["4520", "Income"], ["4500", "Income"], ["4900", "ContraIncome"]]) {
    await CoA.create({ tenantId: TA, code, description: `acct ${code}`, type });
  }
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ recorded caller lifecycle
test("R1 recorded events requests: record -> void -> record (same cache window) -> post -> retry -> void-after-post", { skip }, async () => {
  const reg = oid();
  const r1 = await ev("manual_record.crm_add_attendee", { registrationId: reg });
  assert.equal(r1.status, 201, r1.text.slice(0, 300));
  const p1 = await fresh(r1.data.paymentId);
  assert.equal(p1.status, "manual_review"); assert.equal(p1.registrationBinding, reg);
  assert.equal(p1.idempotencyKey, `acct:manual_record:${reg}`);
  assert.equal(p1.profileId, PH.profileId, "link from the recorded command is set once");

  const v1 = await ev("manual_void.reject", { registrationId: reg, paymentId: r1.data.paymentId });
  assert.equal(v1.status, 200, v1.text.slice(0, 300));
  const p1v = await fresh(r1.data.paymentId);
  assert.equal(p1v.status, "canceled"); assert.equal(p1v.registrationBinding, undefined); assert.equal(p1v.idempotencyKey, undefined);
  assert.equal(p1v.bindingReleaseReason, "REPLACE_RELEASED_BINDING:manual_void");

  // identical request, identical Idempotency-Key, still inside the 5-minute response cache window
  const r2 = await ev("manual_record.crm_add_attendee", { registrationId: reg });
  assert.equal(r2.status, 201, r2.text.slice(0, 300));
  assert.notEqual(r2.data.paymentId, r1.data.paymentId, "the voided id is never replayed");
  const p2 = await fresh(r2.data.paymentId);
  assert.equal(p2.status, "manual_review"); assert.equal(p2.registrationBinding, reg);
  assert.equal((await holders(reg)).length, 1);

  const post = await ev("manual_post.approve", { registrationId: reg, paymentId: r2.data.paymentId });
  assert.equal(post.status, 200, post.text.slice(0, 300));
  assert.equal((await fresh(r2.data.paymentId)).status, "succeeded");
  assert.equal(await glFor(r2.data.paymentId), 1);
  assert.equal(await glFor(r1.data.paymentId), 0, "voided record never posted");

  clearIdempotencyCache(); // a retry after the cache is gone: the stored state decides
  const again = await ev("manual_post.approve", { registrationId: reg, paymentId: r2.data.paymentId });
  assert.equal(again.status, 200); assert.equal(again.data.alreadyPosted, true);
  assert.equal(await glFor(r2.data.paymentId), 1, "no second GL posting");

  const voidPosted = await ev("manual_void.event_cancelled", { registrationId: reg, paymentId: r2.data.paymentId });
  assert.equal(voidPosted.status, 409); assert.equal(voidPosted.code, "ALREADY_POSTED");
  assert.equal((await fresh(r2.data.paymentId)).status, "succeeded");
});

test("R2 recorded events capture/cancel against bound card rows: state transitions, retries, one Stripe mutation", { skip }, async () => {
  const a = await boundStripeReg();
  const c1 = await ev("capture.approve", { registrationId: a.reg, paymentId: a.id, paymentIntentId: a.pi });
  assert.equal(c1.status, 200, c1.text.slice(0, 300));
  const pa = await fresh(a.id);
  assert.equal(pa.status, "succeeded"); assert.equal(pa.profileId, PH.profileId); assert.equal(pa.registrationBinding, a.reg);
  const c2 = await ev("capture.approve", { registrationId: a.reg, paymentId: a.id, paymentIntentId: a.pi });
  assert.equal(c2.status, 200); assert.equal(c2.text, c1.text, "identical retry -> identical response");
  assert.equal(CALLS.filter((c) => c[0] === "capture" && c[1] === a.pi).length, 1);

  for (const reason of ["reject", "event_cancelled"]) {
    const b = await boundStripeReg();
    const x = await ev(`cancel.${reason}`, { registrationId: b.reg, paymentId: b.id, paymentIntentId: b.pi });
    assert.equal(x.status, 200, x.text.slice(0, 300));
    const pb = await fresh(b.id);
    assert.equal(pb.status, "canceled");
    assert.equal(CALLS.filter((c) => c[0] === "cancel" && c[1] === b.pi).length, 1);
  }
  // a released (replaced) registration row never captures, even with a well-formed command
  const r = await boundStripeReg();
  await Payment.updateOne({ _id: r.id }, { $unset: { registrationBinding: "" } });
  const other = await Payment.create({ tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: r.reg, registrationBinding: r.reg,
    amount: 5000, currency: "eur", mode: "external", status: "manual_review", external: { externalRef: `manual-manual-${r.reg}` }, audit: { createdBy: "seed" } });
  const blocked = await ev("capture.approve", { registrationId: r.reg, paymentId: r.id, paymentIntentId: r.pi });
  assert.equal(blocked.status, 409, blocked.text.slice(0, 300));
  assert.ok(["PAYMENT_NOT_BOUND", "PAYMENT_BINDING_UNVERIFIED"].includes(blocked.code), blocked.code);
  assert.equal(CALLS.filter((c) => c[0] === "capture" && c[1] === r.pi).length, 0);
  assert.equal(String((await holders(r.reg))[0]._id), String(other._id));
});

test("R3 recorded profile capture/cancel: bound application row transitions; an unbound legacy row fails closed", { skip }, async () => {
  const mk = async (extra = {}) => {
    piSeq += 1;
    const pi = `pi_integ_app_${piSeq}`;
    PIS.set(pi, { id: pi, amount: 5000, currency: "eur", status: "requires_capture", metadata: {} });
    const applicationId = oid();
    const doc = await Payment.create({ tenantId: TA, purpose: "applicationFee", ledgerDomain: "membership", applicationId, amount: 5000, currency: "eur",
      mode: "stripe", status: "requires_capture", stripe: { paymentIntentId: pi, status: "requires_capture" }, audit: { createdBy: "seed" }, ...extra });
    return { pi, applicationId, id: String(doc._id) };
  };
  const a = await mk();
  const c = await pf("application.capture.approve", { applicationId: a.applicationId, paymentId: a.id, paymentIntentId: a.pi });
  assert.equal(c.status, 200, c.text.slice(0, 300));
  assert.equal((await fresh(a.id)).status, "succeeded");
  const b = await mk();
  const x = await pf("application.cancel.reject", { applicationId: b.applicationId, paymentId: b.id, paymentIntentId: b.pi });
  assert.equal(x.status, 200, x.text.slice(0, 300));
  assert.equal((await fresh(b.id)).status, "canceled");
  // legacy subscriptionFee row without the authoritative application binding: refused, nothing moves
  const u = await mk({ purpose: "subscriptionFee" });
  const y = await pf("application.capture.approve", { applicationId: u.applicationId, paymentId: u.id, paymentIntentId: u.pi });
  assert.equal(y.status, 409, y.text.slice(0, 300));
  assert.equal((await fresh(u.id)).status, "requires_capture");
  assert.equal(CALLS.filter((k) => k[1] === u.pi && k[0] !== "retrieve").length, 0);
});

// ------------------------------------------------------------ concurrency
test("C1 manual post vs void (recorded requests, concurrent): exactly one applies; GL matches the final state", { skip }, async () => {
  for (let round = 0; round < 8; round += 1) {
    const reg = oid();
    const rec = await ev("manual_record.crm_add_attendee", { registrationId: reg });
    assert.equal(rec.status, 201);
    const id = rec.data.paymentId;
    const [post, vd] = await Promise.all([
      ev("manual_post.approve", { registrationId: reg, paymentId: id }),
      ev("manual_void.reject", { registrationId: reg, paymentId: id }),
    ]);
    const p = await fresh(id);
    assert.ok([200, 409].includes(post.status) && [200, 409].includes(vd.status), `${post.status}/${vd.status}`);
    if (p.status === "succeeded") {
      assert.equal(post.status, 200); assert.equal(vd.status, 409);
      assert.equal(await glFor(id), 1); assert.equal(p.registrationBinding, reg);
    } else {
      assert.equal(p.status, "canceled", `round ${round}: ${p.status}`);
      assert.equal(vd.status, 200); assert.equal(post.status, 409);
      assert.equal(await glFor(id), 0); assert.equal(p.registrationBinding, undefined);
    }
  }
});

test("C2 duplicate post (concurrent, same and cleared cache): one GL posting, never 500", { skip }, async () => {
  const reg = oid();
  const rec = await ev("manual_record.crm_add_attendee", { registrationId: reg });
  const id = rec.data.paymentId;
  const res = await Promise.all(Array.from({ length: 8 }, () => ev("manual_post.approve", { registrationId: reg, paymentId: id })));
  for (const r of res) assert.ok([200, 409].includes(r.status), `${r.status} ${r.code}`);
  assert.ok(res.some((r) => r.status === 200));
  assert.equal(await glFor(id), 1);
  assert.equal((await fresh(id)).status, "succeeded");
  clearIdempotencyCache();
  const late = await Promise.all(Array.from({ length: 4 }, () => ev("manual_post.approve", { registrationId: reg, paymentId: id })));
  for (const r of late) { assert.equal(r.status, 200); assert.equal(r.data.alreadyPosted, true); }
  assert.equal(await glFor(id), 1);
});

test("C3 manual-to-card release vs manual record: one holder; after the card dies a new manual record is accepted (key freed)", { skip }, async () => {
  for (let round = 0; round < 6; round += 1) {
    const reg = oid();
    const rec = await ev("manual_record.crm_add_attendee", { registrationId: reg });
    assert.equal(rec.status, 201);
    const [card, again] = await Promise.all([
      call("POST", "/api/payments/intents", { auth: CRM, body: { purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" } }),
      ev("manual_record.crm_add_attendee", { registrationId: reg }),
    ]);
    const h = await holders(reg);
    assert.equal(h.length, 1, `round ${round}: card ${card.status}/${card.code} again ${again.status}/${again.code}`);
    const manual = await fresh(rec.data.paymentId);
    if (card.status === 200) {
      assert.equal(h[0].mode, "stripe");
      assert.equal(manual.status, "canceled"); assert.equal(manual.idempotencyKey, undefined, "MANUAL_TO_CARD frees the record key");
      assert.equal(manual.bindingReleaseReason, "REPLACE_RELEASED_BINDING:manual_to_card");
      // the card intent dies (cancelled), its binding is releasable; a fresh manual record must now succeed
      clearIdempotencyCache();
      await Payment.updateOne({ _id: h[0]._id }, { $set: { status: "canceled" } });
      const next = await ev("manual_record.crm_add_attendee", { registrationId: reg });
      assert.equal(next.status, 201, `round ${round}: ${next.status} ${next.code}`);
      const n = await fresh(next.data.paymentId);
      assert.equal(n.status, "manual_review"); assert.equal(n.registrationBinding, reg);
      assert.equal((await holders(reg)).length, 1);
    } else {
      assert.equal(String(h[0]._id), rec.data.paymentId);
      assert.equal(manual.status, "manual_review");
    }
    // the identical repeat never created a second manual row while one was live
    assert.ok([200, 201, 409].includes(again.status), `${again.status} ${again.code}`);
  }
});

test("C4 record -> void -> record inside the cache window, concurrent void + record: never a replayed dead id", { skip }, async () => {
  for (let round = 0; round < 6; round += 1) {
    const reg = oid();
    const r1 = await ev("manual_record.crm_add_attendee", { registrationId: reg });
    const [vd, r2] = await Promise.all([
      ev("manual_void.reject", { registrationId: reg, paymentId: r1.data.paymentId }),
      ev("manual_record.crm_add_attendee", { registrationId: reg }),
    ]);
    assert.equal(vd.status, 200);
    // r2 either linearised before the void (it then returned r1, which the void cancelled) or after it
    // (a new live record). A third record must always resolve to a LIVE record, never the voided one.
    const r3 = await ev("manual_record.crm_add_attendee", { registrationId: reg });
    assert.ok([200, 201].includes(r3.status), `${r3.status} ${r3.code}`);
    const p3 = await fresh(r3.data.paymentId);
    assert.equal(p3.status, "manual_review", `round ${round}: r2 ${r2.status}, r3 -> ${p3.status}`);
    assert.notEqual(r3.data.paymentId, r1.data.paymentId);
    assert.equal((await holders(reg)).length, 1);
    assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: reg, status: "manual_review" }), 1);
  }
});

// ------------------------------------------------------------ retries after partial failures
test("F1 GL posting fails after the post claim: claim reverted, nothing posted; retry with the same key posts exactly once", { skip }, async () => {
  const reg = oid();
  const rec = await ev("manual_record.crm_add_attendee", { registrationId: reg });
  const id = rec.data.paymentId;
  const saved = await CoA.find({ tenantId: TA }).lean();
  await CoA.deleteMany({ tenantId: TA });
  const fail = await ev("manual_post.approve", { registrationId: reg, paymentId: id });
  assert.ok(fail.status >= 400, `expected a failure, got ${fail.status}`);
  const pf1 = await fresh(id);
  assert.equal(pf1.status, "manual_review", "claim released back to manual_review");
  assert.equal(pf1.registrationBinding, reg, "binding kept");
  assert.equal(await glFor(id), 0);
  await CoA.insertMany(saved.map(({ _id, ...r }) => r));
  const ok = await ev("manual_post.approve", { registrationId: reg, paymentId: id }); // same key: failures are not cached
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal((await fresh(id)).status, "succeeded");
  assert.equal(await glFor(id), 1);
});

test("F2 Stripe capture fails after the transition checks: row unchanged; retry uses the same server-derived key and captures once", { skip }, async () => {
  const a = await boundStripeReg();
  failNextCapture = 1;
  const fail = await ev("capture.approve", { registrationId: a.reg, paymentId: a.id, paymentIntentId: a.pi });
  assert.ok(fail.status >= 400, `expected a failure, got ${fail.status}`);
  assert.equal((await fresh(a.id)).status, "requires_capture");
  const ok = await ev("capture.approve", { registrationId: a.reg, paymentId: a.id, paymentIntentId: a.pi });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  const caps = CALLS.filter((c) => c[0] === "capture" && c[1] === a.pi);
  assert.equal(caps.length, 2, "one failed + one successful Stripe call");
  assert.equal(caps[0][2], caps[1][2], "the retry reuses the identical Stripe idempotency key");
  assert.ok(String(caps[0][2]).startsWith("acct:capture:"), "key derived by account, not the caller");
  assert.equal((await fresh(a.id)).status, "succeeded");
});

test("F3 record succeeded but the response was lost: the retried recorded request returns the same record, no second row", { skip }, async () => {
  const reg = oid();
  const direct = await listener.postManualEventPayment({ tenantId: TA, registrationId: reg, amount: 5000, currency: "eur", method: "manual", eventCategoryCode: "CPD", userId: "staff-1" });
  const retry = await ev("manual_record.crm_add_attendee", { registrationId: reg });
  assert.equal(retry.status, 200, retry.text.slice(0, 300));
  assert.equal(retry.data.paymentId, direct.paymentId); assert.equal(retry.data.alreadyRecorded, true);
  assert.equal(await Payment.countDocuments({ tenantId: TA, registrationId: reg }), 1);
});
