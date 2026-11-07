// P5 S3 signed service authority on account's REAL router (real throwaway mongod, fake Stripe).
// Replays every bound-command contract case SIGNED by its allowed caller with PAYMENT_SERVICE_AUTH_MODE
// set per test, and proves: valid signed commands succeed; a fresh-nonce retry (same business key)
// replays the identical response with no second money movement; a replayed nonce is 409; tampered,
// stale, unsigned-internal and wrong-caller commands are refused BEFORE any Stripe or DB mutation in
// enforce mode; report mode never rejects; off mode is today's behaviour.
//
//   node --test --test-force-exit src/tests/serviceAuthRoutes.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/p5-bound-payment-commands.v1.json");
const C = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-svcauth-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-svcauth-test-jwt-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_svcauth";
delete process.env.AUTH_BYPASS_ENABLED;
const EV = "TEST-ONLY-route-events-secret-0123456789abcdef";
const PR = "TEST-ONLY-route-profile-secret-0123456789abcdef";
process.env.SVC_SIGNING_KEYS_EVENTS_SERVICE = `ev-1:${EV}`;
process.env.SVC_SIGNING_KEYS_PROFILE_SERVICE = `pr-1:${PR}`;

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-svcauth-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/service_auth_routes_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: ServiceAuthNonce } = await import("../models/serviceAuthNonce.model.js");
const { default: app } = await import("../app.js");
const S = await import("../lib/serviceSigning.js");

const PIS = new Map();
const MUTATIONS = [];
stripeClient.paymentIntents.retrieve = async (id) => {
  const pi = PIS.get(id);
  if (!pi) throw Object.assign(new Error("No such payment_intent"), { statusCode: 404 });
  return { ...pi };
};
stripeClient.paymentIntents.capture = async (id, _p, opts = {}) => {
  MUTATIONS.push(["capture", id, opts.idempotencyKey]);
  const pi = PIS.get(id); pi.status = "succeeded";
  return { ...pi, latest_charge: null };
};
stripeClient.paymentIntents.cancel = async (id, _p, opts = {}) => {
  MUTATIONS.push(["cancel", id, opts.idempotencyKey]);
  const pi = PIS.get(id); pi.status = "canceled";
  return { ...pi };
};

const callerFor = (body) => (body?.binding?.domain === "application" ? { caller: "profile-service", kid: "pr-1", secret: PR } : { caller: "events-service", kid: "ev-1", secret: EV });

/** Signs and sends one request; `opts.tamper(sent)` mutates what goes on the wire AFTER signing. */
async function send(request, { signer, nonce, ts, tamper, sign = true } = {}) {
  const raw = JSON.stringify(request.body);
  const headers = { "content-type": "application/json", ...request.headers };
  const sent = { method: request.method, path: request.path, headers, raw };
  if (sign) {
    const s = signer || callerFor(request.body);
    const tsV = ts ?? String(Math.floor(Date.now() / 1000));
    const nonceV = nonce || crypto.randomBytes(18).toString("base64url");
    const canonical = S.canonicalString({
      caller: s.caller, kid: s.kid, method: request.method, target: request.path,
      tenant: request.headers["x-tenant-id"], idem: request.headers["Idempotency-Key"] || "",
      bodySha256: S.sha256Hex(Buffer.from(raw, "utf8")), ts: tsV, nonce: nonceV,
    });
    Object.assign(headers, { "x-svc-version": "1", "x-svc-caller": s.caller, "x-svc-kid": s.kid, "x-svc-ts": tsV, "x-svc-nonce": nonceV, "x-svc-sig": S.signCanonical(s.secret, canonical) });
  }
  if (tamper) tamper(sent);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${sent.path}`, { method: sent.method, headers: sent.headers, body: sent.raw });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function seed(s) {
  if (!s) return;
  const T = C.ids.tenantId;
  const doc = {
    _id: new mongoose.Types.ObjectId(s._id), tenantId: T, purpose: s.purpose, ledgerDomain: s.ledgerDomain,
    amount: s.amount, currency: "eur", status: s.status, attemptNumber: 1, isActiveAttempt: true,
    eventCategoryCode: s.ledgerDomain === "events" ? "CPD" : undefined, audit: { createdBy: "svcauth-seed" },
    ...(s.applicationId ? { applicationId: s.applicationId } : {}),
    ...(s.applicationBinding ? { applicationBinding: s.applicationBinding } : {}),
    ...(s.registrationId ? { registrationId: s.registrationId } : {}),
    ...(s.registrationBinding ? { registrationBinding: s.registrationBinding, target: { entityType: "registration", entityId: s.registrationBinding } } : {}),
  };
  if (s.kind === "stripe") {
    Object.assign(doc, { mode: "stripe", source: "portal", stripe: { paymentIntentId: s.paymentIntentId, status: s.status } });
    PIS.set(s.paymentIntentId, { id: s.paymentIntentId, amount: s.amount, currency: "eur", status: s.status, metadata: { tenantId: T } });
  } else {
    Object.assign(doc, { mode: "external", source: "events-service", external: { externalRef: `manual-${s.method}-${s.registrationId}` }, metadata: { method: s.method } });
  }
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  await Payment.collection.insertOne(doc);
}

function withMode(mode, fn) {
  return async () => {
    const prev = process.env.PAYMENT_SERVICE_AUTH_MODE;
    process.env.PAYMENT_SERVICE_AUTH_MODE = mode;
    try { await fn(); } finally {
      if (prev == null) delete process.env.PAYMENT_SERVICE_AUTH_MODE; else process.env.PAYMENT_SERVICE_AUTH_MODE = prev;
    }
  };
}

const byName = (n) => C.cases.find((c) => c.name === n);
const stateOf = async (c) => (c.seed?._id ? (await Payment.findById(c.seed._id).lean())?.status : null);

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  await Payment.syncIndexes();
  await ServiceAuthNonce.syncIndexes();
  for (const [code, type] of [["1400", "Asset"], ["4510", "Income"], ["4520", "Income"], ["4500", "Income"], ["4900", "ContraIncome"], ["1200", "Asset"], ["1220", "Asset"], ["4010", "Income"], ["4090", "Income"]]) {
    await CoA.create({ tenantId: C.ids.tenantId, code, description: `acct ${code}`, type }).catch(() => {});
  }
  for (const c of [...C.cases, ...C.negative]) await seed(c.seed);
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) {
    const exited = new Promise((r) => mongodProc.once("exit", r));
    mongodProc.kill("SIGTERM");
    await exited;
  }
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

test("nonce store: unique (caller, nonce) and TTL indexes exist", { skip }, async () => {
  const idx = await ServiceAuthNonce.collection.indexes();
  assert.ok(idx.some((i) => i.unique && i.key.caller === 1 && i.key.nonce === 1));
  assert.ok(idx.some((i) => i.key.createdAt === 1 && i.expireAfterSeconds > 120));
});

// Refusals first (each case is consumed by its successful run later).
const TAMPER = [
  ["body bytes (whitespace only)", (s) => { s.raw += " "; }],
  ["body content", (s) => { s.raw = s.raw.replace("approve", "reject"); }],
  ["path", (s) => { s.path = s.path.replace("/capture", "/cancel"); }],
  ["raw query string", (s) => { s.path += "?a=1"; }],
  ["tenant header", (s) => { s.headers["x-tenant-id"] = "f".repeat(24); }],
  ["Idempotency-Key", (s) => { s.headers["Idempotency-Key"] += "x"; }],
  ["timestamp header", (s) => { s.headers["x-svc-ts"] = String(Number(s.headers["x-svc-ts"]) - 1); }],
  ["nonce header", (s) => { s.headers["x-svc-nonce"] = crypto.randomBytes(18).toString("base64url"); }],
  ["kid header (unknown kid)", (s) => { s.headers["x-svc-kid"] = "ev-9"; }],
];
for (const [label, tamper] of TAMPER) {
  test(`enforce: tampered ${label} -> 401 before any mutation`, { skip }, withMode("enforce", async () => {
    const c = byName("registration.capture.approve");
    const before = MUTATIONS.length;
    const res = await send(c.request, { tamper });
    assert.equal(res.status, 401, res.text.slice(0, 200));
    assert.match(res.code, /^SERVICE_AUTH_(INVALID|UNKNOWN_KID)$/);
    assert.equal(MUTATIONS.length, before);
    assert.equal(await stateOf(c), c.seed.status);
  }));
}

test("enforce: stale timestamp (-61 s) -> 401 SERVICE_AUTH_STALE, nothing moves", { skip }, withMode("enforce", async () => {
  const c = byName("registration.capture.approve");
  const res = await send(c.request, { ts: String(Math.floor(Date.now() / 1000) - 61) });
  assert.equal(res.status, 401);
  assert.equal(res.code, "SERVICE_AUTH_STALE");
  assert.equal(await stateOf(c), c.seed.status);
}));

test("enforce: wrong caller for the domain -> 403 SERVICE_NOT_ALLOWED, nothing moves", { skip }, withMode("enforce", async () => {
  const reg = byName("registration.capture.approve");
  const app_ = byName("application.capture.approve");
  const before = MUTATIONS.length;
  const r1 = await send(reg.request, { signer: { caller: "profile-service", kid: "pr-1", secret: PR } });
  const r2 = await send(app_.request, { signer: { caller: "events-service", kid: "ev-1", secret: EV } });
  const r3 = await send(byName("registration.manual_record.crm_add_attendee").request, { signer: { caller: "profile-service", kid: "pr-1", secret: PR } });
  for (const r of [r1, r2, r3]) { assert.equal(r.status, 403, r.text.slice(0, 200)); assert.equal(r.code, "SERVICE_NOT_ALLOWED"); }
  assert.equal(MUTATIONS.length, before);
  assert.equal(await stateOf(reg), reg.seed.status);
  assert.equal(await stateOf(app_), app_.seed.status);
}));

test("enforce: unsigned internal command -> 401 SERVICE_AUTH_REQUIRED", { skip }, withMode("enforce", async () => {
  const c = byName("registration.capture.approve");
  const res = await send(c.request, { sign: false });
  assert.equal(res.status, 401);
  assert.equal(res.code, "SERVICE_AUTH_REQUIRED");
  assert.equal(await stateOf(c), c.seed.status);
}));

test("enforce: case / trailing-slash path variants cannot skip the verifier", { skip }, withMode("enforce", async () => {
  const T = C.ids.tenantId;
  const body = { binding: { domain: "registration", registrationId: "b".repeat(24), purpose: "eventRegistration" }, transition: "manual_void", reason: "reject", actorUserId: "c".repeat(24) };
  for (const p of ["/api/journal/events/Manual-Payment/void", "/api/journal/events/manual-payment/void/", "/api/journal/events/MANUAL-PAYMENT", "/api/payments/intents/pi_x/CAPTURE", "/api/payments/intents/pi_x/cancel/"]) {
    const res = await send({ method: "POST", path: p, headers: { "x-internal-request": "true", "x-tenant-id": T, "Idempotency-Key": "k" }, body }, { sign: false });
    assert.equal(res.status, 401, `${p}: ${res.text.slice(0, 160)}`);
    assert.equal(res.code, "SERVICE_AUTH_REQUIRED", p);
  }
}));

test("report: an invalid signature is never rejected by the verifier (reaches the existing chain)", { skip }, withMode("report", async () => {
  const res = await send({ method: "POST", path: "/api/payments/intents/pi_svcauth_none/capture", headers: { "x-internal-request": "true", "x-tenant-id": C.ids.tenantId, "Idempotency-Key": "registration:capture:" + "b".repeat(24) + ":pi_svcauth_none" }, body: { binding: { domain: "registration", registrationId: "b".repeat(24), purpose: "eventRegistration" }, transition: "capture", reason: "approve", actorUserId: "c".repeat(24) } }, { tamper: (s) => { s.raw += " "; } });
  assert.notEqual(res.code, "SERVICE_AUTH_INVALID");
  assert.equal(res.status, 404, res.text.slice(0, 200)); // PAYMENT_NOT_FOUND from the bound-command chain
}));

test("off: unsigned internal command behaves as today (chain decides)", { skip }, withMode("off", async () => {
  const res = await send({ method: "POST", path: "/api/payments/intents/pi_svcauth_none2/capture", headers: { "x-internal-request": "true", "x-tenant-id": C.ids.tenantId, "Idempotency-Key": "registration:capture:" + "b".repeat(24) + ":pi_svcauth_none2" }, body: { binding: { domain: "registration", registrationId: "b".repeat(24), purpose: "eventRegistration" }, transition: "capture", reason: "approve", actorUserId: "c".repeat(24) } }, { sign: false });
  assert.equal(res.status, 404, res.text.slice(0, 200));
}));

// Per-operation enforcement on the real router: global report + the four events-only operations.
function withPerOperation(fn) {
  return async () => {
    const prev = [process.env.PAYMENT_SERVICE_AUTH_MODE, process.env.PAYMENT_SERVICE_AUTH_ENFORCE_OPERATIONS];
    process.env.PAYMENT_SERVICE_AUTH_MODE = "report";
    process.env.PAYMENT_SERVICE_AUTH_ENFORCE_OPERATIONS = "manual_record,manual_post,manual_void,intent_registration";
    try { await fn(); } finally {
      for (const [k, v] of [["PAYMENT_SERVICE_AUTH_MODE", prev[0]], ["PAYMENT_SERVICE_AUTH_ENFORCE_OPERATIONS", prev[1]]]) {
        if (v == null) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}
const RID_PO = "b".repeat(24);
const internalHeaders = (idem) => ({ "x-internal-request": "true", "x-tenant-id": C.ids.tenantId, "Idempotency-Key": idem });
const manualBody = (transition, extra = {}) => ({ binding: { domain: "registration", registrationId: RID_PO, purpose: "eventRegistration" }, transition, reason: "reject", actorUserId: "c".repeat(24), ...extra });
const PER_OP_ROUTES = [
  ["manual_record", "/api/journal/events/manual-payment", manualBody("manual_record", { amount: 1000, method: "invoice" }), `registration:manual_record:${RID_PO}:new`],
  ["manual_post", "/api/journal/events/manual-payment/post", manualBody("manual_post", { paymentId: "d".repeat(24) }), `registration:manual_post:${RID_PO}:${"d".repeat(24)}`],
  ["manual_void", "/api/journal/events/manual-payment/void", manualBody("manual_void", { paymentId: "d".repeat(24) }), `registration:manual_void:${RID_PO}:${"d".repeat(24)}`],
  ["intent_registration", "/api/payments/intents", { purpose: "eventRegistration", registrationId: RID_PO, amount: 1000, currency: "eur" }, "intent-po-1"],
];

for (const [op, p, body, idem] of PER_OP_ROUTES) {
  test(`per-operation enforce (report + list): ${op} unsigned internal -> 401, tampered -> 401, nothing moves`, { skip }, withPerOperation(async () => {
    const before = MUTATIONS.length;
    const payments = await Payment.countDocuments({});
    const missing = await send({ method: "POST", path: p, headers: internalHeaders(idem), body }, { sign: false });
    assert.equal(missing.status, 401, missing.text.slice(0, 200));
    assert.equal(missing.code, "SERVICE_AUTH_REQUIRED");
    const tampered = await send({ method: "POST", path: p, headers: internalHeaders(idem), body }, { signer: { caller: "events-service", kid: "ev-1", secret: EV }, tamper: (s) => { s.raw += " "; } });
    assert.equal(tampered.status, 401, tampered.text.slice(0, 200));
    assert.equal(tampered.code, "SERVICE_AUTH_INVALID");
    const wrong = await send({ method: "POST", path: p, headers: internalHeaders(idem), body }, { signer: { caller: "profile-service", kid: "pr-1", secret: PR } });
    assert.equal(wrong.status, 403, wrong.text.slice(0, 200));
    assert.equal(wrong.code, "SERVICE_NOT_ALLOWED");
    assert.equal(MUTATIONS.length, before);
    assert.equal(await Payment.countDocuments({}), payments);
  }));
}

test("per-operation enforce: a valid events signature passes the verifier on manual_void (chain decides), its replay is 409", { skip }, withPerOperation(async () => {
  const [, p, body, idem] = PER_OP_ROUTES[2];
  const nonce = crypto.randomBytes(18).toString("base64url");
  const first = await send({ method: "POST", path: p, headers: internalHeaders(idem), body }, { signer: { caller: "events-service", kid: "ev-1", secret: EV }, nonce });
  assert.ok(!String(first.code || "").startsWith("SERVICE_"), first.text.slice(0, 200));
  assert.ok(first.status >= 400 && first.status < 500, first.text.slice(0, 200)); // the bound-command chain refuses the fake row
  const replay = await send({ method: "POST", path: p, headers: internalHeaders(idem), body }, { signer: { caller: "events-service", kid: "ev-1", secret: EV }, nonce });
  assert.equal(replay.status, 409, replay.text.slice(0, 200));
  assert.equal(replay.code, "SERVICE_AUTH_REPLAY");
}));

test("per-operation enforce: profile-style unsigned internal capture/cancel are NOT refused (report) - chain decides", { skip }, withPerOperation(async () => {
  for (const t of ["capture", "cancel"]) {
    const res = await send({ method: "POST", path: `/api/payments/intents/pi_svcauth_po_${t}/${t}`, headers: { "x-internal-request": "true", "x-tenant-id": C.ids.tenantId, "Idempotency-Key": `application:${t}:x:pi_svcauth_po_${t}` }, body: { reason: "approve" } }, { sign: false });
    assert.ok(!String(res.code || "").startsWith("SERVICE_"), `${t}: ${res.text.slice(0, 200)}`);
  }
}));

for (const c of C.cases) {
  test(`enforce: signed ${c.name} succeeds; fresh-nonce retry replays identically; nonce replay 409; no second mutation`, { skip }, withMode("enforce", async () => {
    const nonce = crypto.randomBytes(18).toString("base64url");
    const first = await send(c.request, { nonce });
    assert.equal(first.status, c.expect.status, `${c.name}: ${first.text.slice(0, 300)}`);
    const moved = MUTATIONS.length;
    const retry = await send(c.request); // fresh nonce, same business Idempotency-Key and body
    assert.equal(retry.status, first.status);
    assert.equal(retry.text, first.text, `${c.name}: retry must replay the identical response`);
    const replay = await send(c.request, { nonce });
    assert.equal(replay.status, 409, replay.text.slice(0, 200));
    assert.equal(replay.code, "SERVICE_AUTH_REPLAY");
    assert.equal(MUTATIONS.length, moved, `${c.name}: no second Stripe mutation`);
  }));
}

// Last: production boot runs with autoIndex off (NODE_ENV=production), where Model.init() builds no
// index. connectDB must still create the replay-store indexes, or replays would pass as valid and
// nonce rows would never expire.
test("connectDB with autoIndex off still creates the nonce unique + TTL indexes", { skip }, async () => {
  const { connectDB } = await import("../config/db.js");
  await mongoose.disconnect();
  const probeUri = uri.replace(/\/[^/?]+(\?|$)/, "/service_auth_index_probe$1");
  await connectDB(probeUri, { autoIndex: false });
  try {
    const idx = await ServiceAuthNonce.collection.indexes();
    assert.ok(idx.some((i) => i.unique && i.key.caller === 1 && i.key.nonce === 1), JSON.stringify(idx));
    assert.ok(idx.some((i) => i.key.createdAt === 1 && i.expireAfterSeconds === 600), JSON.stringify(idx));
  } finally {
    await mongoose.connection.db.dropDatabase().catch(() => {});
  }
});
