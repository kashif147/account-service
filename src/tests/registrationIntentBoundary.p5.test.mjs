// P5 (b12) neighbouring payment-mutation bypasses folded into the signed service boundary, on account's
// REAL router (real throwaway mongod, fake Stripe):
//   - POST /payments/intents with a registrationId can take over (cancel) an unposted manual record's
//     binding - the effect of manual_void. CRM user path: only with the EXACT events:write permission
//     (never any CRM). Internal path: signed "intent_registration" (events-service only); report mode
//     never rejects, enforce refuses unsigned / wrong caller BEFORE any Stripe or DB mutation.
//   - POST /payments/record-external (account #30 folded in): a bare internal header is refused in
//     every PAYMENT_SERVICE_AUTH_MODE; the CRM finance-write path is unchanged.
//
//   node --test --test-force-exit src/tests/registrationIntentBoundary.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-regintent-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-regintent-test-jwt-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_regintent";
delete process.env.AUTH_BYPASS_ENABLED;
const EV = "TEST-ONLY-regintent-events-secret-0123456789abcdef";
const PR = "TEST-ONLY-regintent-profile-secret-0123456789abcdef";
process.env.SVC_SIGNING_KEYS_EVENTS_SERVICE = `ev-1:${EV}`;
process.env.SVC_SIGNING_KEYS_PROFILE_SERVICE = `pr-1:${PR}`;
const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-regintent-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/registration_intent_boundary_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: ServiceAuthNonce } = await import("../models/serviceAuthNonce.model.js");
const { default: app } = await import("../app.js");
const S = await import("../lib/serviceSigning.js");

const STRIPE_CREATES = [];
let piSeq = 0;
stripeClient.paymentIntents.create = async (params) => {
  piSeq += 1;
  STRIPE_CREATES.push(params.amount);
  return { id: `pi_regintent_${piSeq}`, client_secret: `pi_regintent_${piSeq}_secret_x`, amount: params.amount, currency: params.currency, status: "requires_payment_method", metadata: params.metadata || {} };
};
stripeClient.paymentIntents.retrieve = async (id) => ({ id, status: "requires_payment_method", amount: 5000, currency: "eur", metadata: {} });

const token = (permissions) => `Bearer ${jwt.sign({ id: "staff-1", sub: "staff-1", tenantId: TA, userType: "CRM", roles: [], permissions }, SECRET, { expiresIn: "1h" })}`;
const CRM_NONE = token([]);
const CRM_CREATE = token(["events:create"]);
const CRM_WRITE = token(["events:write"]);
const CRM_FIN = token(["finance:write", "accounts.admin:write", "payments:write"]);
const oid = (n) => n.toString(16).padStart(24, "0");
let regSeq = 100;
const nextReg = () => oid((regSeq += 1));
const intentBody = (reg) => ({ purpose: "eventRegistration", amount: 5000, currency: "eur", registrationId: reg, ledgerDomain: "events" });

/** Sends one request; `signer` signs it over the exact bytes sent (lib/serviceSigning.js). */
async function send(method, urlPath, { auth, internal = false, body, signer } = {}) {
  const raw = JSON.stringify(body || {});
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  if (internal) Object.assign(headers, { "x-internal-request": "true", "x-tenant-id": TA });
  if (signer) {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString("base64url");
    const canonical = S.canonicalString({
      caller: signer.caller, kid: signer.kid, method, target: urlPath, tenant: TA, idem: "",
      bodySha256: S.sha256Hex(Buffer.from(raw, "utf8")), ts, nonce,
    });
    Object.assign(headers, { "x-svc-version": "1", "x-svc-caller": signer.caller, "x-svc-kid": signer.kid, "x-svc-ts": ts, "x-svc-nonce": nonce, "x-svc-sig": S.signCanonical(signer.secret, canonical) });
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, { method, headers, body: raw });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const EVENTS = { caller: "events-service", kid: "ev-1", secret: EV };
const PROFILE = { caller: "profile-service", kid: "pr-1", secret: PR };

async function seedManualHolder(reg) {
  const { insertedId } = await Payment.collection.insertOne({
    tenantId: TA, purpose: "eventRegistration", ledgerDomain: "events", registrationId: reg, registrationBinding: reg,
    target: { entityType: "registration", entityId: reg }, amount: 5000, currency: "eur", status: "manual_review",
    mode: "external", source: "events-service", external: { externalRef: `manual-manual-${reg}` },
    attemptNumber: 1, isActiveAttempt: true, audit: { createdBy: "staff-1" },
  });
  return insertedId;
}
const rowOf = (id) => Payment.findById(id).lean();
const holderOf = (reg) => Payment.findOne({ tenantId: TA, registrationBinding: reg }).lean();

function withMode(mode, fn) {
  return async () => {
    const prev = process.env.PAYMENT_SERVICE_AUTH_MODE;
    if (mode == null) delete process.env.PAYMENT_SERVICE_AUTH_MODE;
    else process.env.PAYMENT_SERVICE_AUTH_MODE = mode;
    try { await fn(); } finally {
      if (prev == null) delete process.env.PAYMENT_SERVICE_AUTH_MODE;
      else process.env.PAYMENT_SERVICE_AUTH_MODE = prev;
    }
  };
}
async function expectManualUntouched(manualId, reg) {
  const m = await rowOf(manualId);
  assert.equal(m.status, "manual_review", "manual record not cancelled");
  assert.equal(m.registrationBinding, reg, "manual record still holds the binding");
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  await Payment.syncIndexes();
  await ServiceAuthNonce.syncIndexes();
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ CRM user path (any mode)
test("RI1 CRM token WITHOUT events permissions cannot take over an unposted manual record (409, nothing cancelled, no Stripe)", { skip }, withMode("off", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const before = STRIPE_CREATES.length;
  const r = await send("POST", "/api/payments/intents", { auth: CRM_NONE, body: intentBody(reg) });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.code, "REGISTRATION_PAYMENT_HELD");
  assert.equal(STRIPE_CREATES.length, before, "no Stripe intent created");
  await expectManualUntouched(manual, reg);
}));

test("RI2 CRM token with events:create only (add-attendee authority) cannot take over a manual record", { skip }, withMode("off", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const r = await send("POST", "/api/payments/intents", { auth: CRM_CREATE, body: intentBody(reg) });
  assert.equal(r.status, 409, r.text);
  await expectManualUntouched(manual, reg);
}));

test("RI3 CRM token with the exact events:write permission (retry-payment authority) takes over: manual cancelled, card holds", { skip }, withMode("off", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const r = await send("POST", "/api/payments/intents", { auth: CRM_WRITE, body: intentBody(reg) });
  assert.equal(r.status, 200, r.text);
  const m = await rowOf(manual);
  assert.equal(m.status, "canceled");
  assert.equal(m.registrationBinding, undefined);
  const h = await holderOf(reg);
  assert.equal(h.stripe?.paymentIntentId, r.data.paymentIntentId || r.data.id);
}));

test("RI4 creating a registration intent with NO existing holder is unchanged for CRM callers", { skip }, withMode("off", async () => {
  const reg = nextReg();
  const r = await send("POST", "/api/payments/intents", { auth: CRM_NONE, body: intentBody(reg) });
  assert.equal(r.status, 200, r.text);
  assert.ok(await holderOf(reg));
}));

test("RI5 the CRM user path is not service-signed: in enforce mode it is still judged by the business permission only", { skip }, withMode("enforce", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const denied = await send("POST", "/api/payments/intents", { auth: CRM_NONE, body: intentBody(reg) });
  assert.equal(denied.status, 409);
  await expectManualUntouched(manual, reg);
  const ok = await send("POST", "/api/payments/intents", { auth: CRM_WRITE, body: intentBody(reg) });
  assert.equal(ok.status, 200, ok.text);
}));

// ------------------------------------------------------------------ internal path: signed boundary
test("RI6 report mode: an UNSIGNED internal takeover is measured, never rejected (compatibility only)", { skip }, withMode("report", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const r = await send("POST", "/api/payments/intents", { internal: true, body: intentBody(reg) });
  assert.equal(r.status, 200, r.text);
  assert.equal((await rowOf(manual)).status, "canceled");
}));

test("RI7 enforce mode: an UNSIGNED internal takeover is refused 401 before any Stripe or DB mutation", { skip }, withMode("enforce", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const before = STRIPE_CREATES.length;
  const r = await send("POST", "/api/payments/intents", { internal: true, body: intentBody(reg) });
  assert.equal(r.status, 401, r.text);
  assert.equal(r.code, "SERVICE_AUTH_REQUIRED");
  assert.equal(STRIPE_CREATES.length, before);
  await expectManualUntouched(manual, reg);
}));

test("RI8 enforce mode: events-service SIGNED internal takeover succeeds (manual cancelled, card holds)", { skip }, withMode("enforce", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const r = await send("POST", "/api/payments/intents", { internal: true, body: intentBody(reg), signer: EVENTS });
  assert.equal(r.status, 200, r.text);
  assert.equal((await rowOf(manual)).status, "canceled");
  assert.ok(await holderOf(reg));
}));

test("RI9 enforce mode: profile-service (not allow-listed for registrations) signing a takeover -> 403, nothing changes", { skip }, withMode("enforce", async () => {
  const reg = nextReg();
  const manual = await seedManualHolder(reg);
  const before = STRIPE_CREATES.length;
  const r = await send("POST", "/api/payments/intents", { internal: true, body: intentBody(reg), signer: PROFILE });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.code, "SERVICE_NOT_ALLOWED");
  assert.equal(STRIPE_CREATES.length, before);
  await expectManualUntouched(manual, reg);
}));

test("RI10 enforce mode: signature over a different body (tampered registrationId) -> 401, nothing changes", { skip }, withMode("enforce", async () => {
  const reg = nextReg();
  const other = nextReg();
  const manual = await seedManualHolder(reg);
  // sign for `other`, send for `reg`: build the signed headers then swap the body
  const raw = JSON.stringify(intentBody(other));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(18).toString("base64url");
  const canonical = S.canonicalString({ caller: EVENTS.caller, kid: EVENTS.kid, method: "POST", target: "/api/payments/intents", tenant: TA, idem: "", bodySha256: S.sha256Hex(Buffer.from(raw, "utf8")), ts, nonce });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/intents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-request": "true", "x-tenant-id": TA, "x-svc-version": "1", "x-svc-caller": EVENTS.caller, "x-svc-kid": EVENTS.kid, "x-svc-ts": ts, "x-svc-nonce": nonce, "x-svc-sig": S.signCanonical(EVENTS.secret, canonical) },
      body: JSON.stringify(intentBody(reg)),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
  await expectManualUntouched(manual, reg);
}));

test("RI11 the intent_registration verifier is scoped: an internal intent WITHOUT a registrationId is not evaluated", { skip }, withMode("enforce", async () => {
  const r = await send("POST", "/api/payments/intents", { internal: true, body: { purpose: "eventRegistration", amount: 5000, currency: "eur", ledgerDomain: "events", entityType: "event", entityId: oid(9) } });
  assert.notEqual(r.code, "SERVICE_AUTH_REQUIRED", r.text);
}));

// ------------------------------------------------------------------ record-external (account #30)
const recExt = () => ({ applicationId: oid(777), amount: 5000, currency: "eur", purpose: "applicationFee", method: "bank_transfer", reference: "p5-regintent" });
for (const mode of ["off", "report", "enforce"]) {
  test(`RI12 record-external: a bare internal header is refused in ${mode} mode and creates nothing`, { skip }, withMode(mode, async () => {
    const before = await Payment.countDocuments({ tenantId: TA, applicationId: oid(777) });
    const r = await send("POST", "/api/payments/record-external", { internal: true, body: recExt() });
    assert.ok(r.status === 403 || r.status === 401, `${r.status} ${r.text}`);
    assert.equal(await Payment.countDocuments({ tenantId: TA, applicationId: oid(777) }), before);
  }));
}
test("RI13 record-external: a signed internal call does not bypass the CRM-only rule (no internal branch exists)", { skip }, withMode("enforce", async () => {
  const r = await send("POST", "/api/payments/record-external", { internal: true, body: recExt(), signer: PROFILE });
  assert.ok(r.status === 403 || r.status === 401, `${r.status} ${r.text}`);
}));
test("RI14 record-external: CRM without finance write is refused (any CRM never suffices)", { skip }, async () => {
  const r = await send("POST", "/api/payments/record-external", { auth: CRM_WRITE, body: recExt() });
  assert.equal(r.status, 403, r.text);
});
test("RI15 record-external: CRM with finance write still reaches the handler (path unchanged)", { skip }, async () => {
  const r = await send("POST", "/api/payments/record-external", { auth: CRM_FIN, body: recExt() });
  assert.notEqual(r.status, 401, r.text);
  assert.notEqual(r.code, "CRM_ONLY", r.text);
  assert.notEqual(r.code, "FINANCE_PERMISSION_REQUIRED", r.text);
});
