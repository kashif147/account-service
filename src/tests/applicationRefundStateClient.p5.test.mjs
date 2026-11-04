// P5 application refund state - account-service signer + client for profile-service's signed lookup
// (GET /api/internal/applications/:applicationId/refund-state) and its use by the CRM refund path.
//
//   1. shared vectors: contracts/p5-service-signing.application-refund-state.v1.json is byte-identical
//      in profile-service (verifier); SHA-256 pinned here and there; account signs each vector exactly.
//   2. provider mapping against a local profile stand-in (real HTTP): verified / auth / business /
//      unavailable (incl. 3 s-style timeout), what is and is not sent.
//   3. REAL app + REAL throwaway mongod + Stripe stub, REFUND_POLICY_MODE=enforce, the provider app.js
//      installs: every failure refuses with the distinct code + reason and makes NO Stripe call.
// In-test random signing key and JWT secret.
//
//   node --test src/tests/applicationRefundStateClient.p5.test.mjs
import test, { after, beforeEach } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-state-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.JWT_SECRET = `refund-state-test-${crypto.randomBytes(24).toString("hex")}`;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_refund_state";
delete process.env.AUTH_BYPASS_ENABLED;
delete process.env.REFUND_POLICY_MODE;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_SHA256 = "41c8a9c1b68c06ce2b623d97397035a84696185fe8c60926e8f3ed20bd073652";
const RAW = fs.readFileSync(path.join(HERE, "..", "..", "contracts", "p5-service-signing.application-refund-state.v1.json"));
const V = JSON.parse(RAW.toString("utf8"));

const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const KID = "as-test-1";
const SIGN_SECRET = crypto.randomBytes(32).toString("hex");

const signing = await import("../lib/profileRequestSigning.js");
const { fetchApplicationRefundState, DEFAULT_TIMEOUT_MS } = await import("../services/applicationRefundState.client.js");

// ---------------------------------------------------------------- local profile stand-in
// Verifies what profile-service verifies (independently re-derived from the vector contract's
// canonical format) and answers whatever the test scripts.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}
const lp = (n, v) => `${n}=${Buffer.byteLength(String(v ?? ""), "utf8")}:${v ?? ""}`;
function standInVerify(req, secret) {
  const h = req.headers;
  const canonical = ["p5-svc-sig/1", lp("aud", "profile-service"), lp("caller", h["x-svc-caller"]), lp("kid", h["x-svc-kid"]),
    lp("method", req.method), lp("target", req.url), lp("tenant", h["x-tenant-id"]), lp("idem", ""),
    lp("body", crypto.createHash("sha256").update("").digest("hex")), lp("ts", h["x-svc-ts"]), lp("nonce", h["x-svc-nonce"])].join("\n");
  const want = crypto.createHmac("sha256", secret).update(canonical).digest("base64url");
  return typeof h["x-svc-sig"] === "string" && h["x-svc-sig"].length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(h["x-svc-sig"]));
}
const stand = { requests: [], respond: null, seenNonces: new Set() };
const standServer = http.createServer((req, res) => {
  const rec = { method: req.method, url: req.url, headers: { ...req.headers }, verified: standInVerify(req, SIGN_SECRET) };
  stand.requests.push(rec);
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  if (stand.seenNonces.has(req.headers["x-svc-nonce"])) return send(401, { success: false, code: "SERVICE_AUTH_REPLAY" });
  stand.seenNonces.add(req.headers["x-svc-nonce"]);
  const m = /^\/api\/internal\/applications\/([^/]+)\/refund-state$/.exec(req.url);
  if (!rec.verified || !m) return send(401, { success: false, code: "SERVICE_AUTH_INVALID" });
  const r = stand.respond ? stand.respond({ applicationId: decodeURIComponent(m[1]), tenantId: req.headers["x-tenant-id"] }) : null;
  if (!r) return send(200, { data: { applicationId: decodeURIComponent(m[1]), tenantId: req.headers["x-tenant-id"], status: "submitted" } });
  if (r.delayMs) return setTimeout(() => send(r.status || 200, r.body ?? {}), r.delayMs);
  if (r.destroy) return req.socket.destroy();
  return send(r.status, r.body);
});
await new Promise((r) => standServer.listen(0, "127.0.0.1", r));
const STAND = `http://127.0.0.1:${standServer.address().port}`;

const ENV = () => ({ PROFILE_SERVICE_URL: STAND, PROFILE_SIGNING_KID: KID, PROFILE_SIGNING_SECRET: SIGN_SECRET });
const silent = { info() {}, warn() {}, error() {} };
const lookup = (args, deps = {}) => fetchApplicationRefundState(args, { env: ENV(), logger: silent, ...deps });

// ---------------------------------------------------------------- real app + mongod setup (before any test is registered)
let mongodProc = null;
let mongodDir = null;
async function startMongo() {
  if (spawnSync("mongod", ["--version"]).status !== 0) return null;
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-refund-state-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/refund_state_client_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH";

process.env.PROFILE_SERVICE_URL = STAND;
process.env.PROFILE_SIGNING_KID = KID;
process.env.PROFILE_SIGNING_SECRET = SIGN_SECRET;

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const stripe = { createCalls: 0, refunds: [] };
stripeClient.refunds.create = async (params) => {
  stripe.createCalls += 1;
  const refund = { id: `re_rs_${stripe.refunds.length + 1}`, charge: "ch_rs", amount: params.amount, payment_intent: params.payment_intent, metadata: { ...(params.metadata || {}) } };
  stripe.refunds.push(refund);
  return refund;
};
stripeClient.refunds.list = async ({ payment_intent }) => ({ data: stripe.refunds.filter((r) => r.payment_intent === payment_intent) });
stripeClient.charges.retrieve = async () => ({});

const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: RefundOperation } = await import("../models/refundOperation.model.js");
const { default: MemberRefundReservation } = await import("../models/memberRefundReservation.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { default: MaterializedBalance } = await import("../models/materializedBalance.model.js");
const { default: app } = await import("../app.js"); // installs the real provider
const { default: request } = await import("supertest");
const appServer = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });

after(async () => {
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => standServer.close(r));
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  if (mongodProc) mongodProc.kill("SIGKILL");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

const CRM_AM = `Bearer ${jwt.sign({ id: "staff-am", sub: "staff-am", tenantId: TA, userType: "CRM", roles: ["AM"], permissions: ["payments:write", "payments:read"] }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
async function refund(b) {
  const res = await request(appServer).post("/api/payments/refunds").set("content-type", "application/json").set("authorization", CRM_AM).send(b);
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = null; }
  return { status: res.status, code: json?.code ?? null, reason: json?.details?.reason ?? null, text: res.text };
}
let seq = 0;
async function seedFlowA(applicationId, amount = 5000) {
  seq += 1;
  const _id = new mongoose.Types.ObjectId();
  const pi = `pi_rs_${seq}`;
  await Payment.collection.insertOne({
    _id, tenantId: TA, purpose: "applicationFee", ledgerDomain: "membership", amount, currency: "eur", status: "succeeded",
    attemptNumber: 1, isActiveAttempt: true, source: "portal", mode: "stripe", applicationId,
    stripe: { paymentIntentId: pi, chargeId: `ch_rs_${seq}`, status: "succeeded" },
    audit: { createdBy: "member-x" }, webhookEventIds: [], auditHistory: [], createdAt: new Date(), updatedAt: new Date(),
  });
  await GLTransaction.collection.insertOne({
    tenantId: TA, date: new Date(), docType: "Receipt", docNo: `RCP-${_id}`, settlement: { provider: "Stripe", status: "PENDING" },
    entries: [{ accountCode: "1220", dc: "D", amount }, { accountCode: "2020", dc: "C", amount, applicationId }],
    createdAt: new Date(), updatedAt: new Date(),
  });
  await MaterializedBalance.collection.insertOne({ tenantId: TA, memberId: `app:${applicationId}`, accountCode: "2020", bucket: "current", year: new Date().getFullYear(), ledgerDomain: "membership", amount: -amount, updatedAt: new Date() });
  return { _id, pi };
}
const body = (pi) => ({ mode: "stripe", paymentIntentId: pi, payoutMethod: "credit_card", amount: 2000 });

if (!skip) {
  await mongoose.connect(uri);
  await Promise.all([Payment.init(), Refund.init(), RefundOperation.init(), MemberRefundReservation.init()]);
}

// ---------------------------------------------------------------- 1. shared vectors
test("vector file is the pinned contract shared with profile-service", () => {
  assert.equal(crypto.createHash("sha256").update(RAW).digest("hex"), VECTORS_SHA256);
  assert.equal(V.audience, "profile-service");
  assert.equal(V.caller, "account-service");
  assert.equal(V.operation, "application_refund_state");
  assert.equal(signing.AUDIENCE, "profile-service");
  assert.equal(signing.CALLER, "account-service");
});

test("canonicalization reproduces every vector, incl. the p5-service-signing.v1 compatibility vector", () => {
  for (const v of V.vectors) {
    const i = v.input;
    const bodySha256 = signing.sha256Hex(Buffer.from(i.body, "utf8"));
    assert.equal(bodySha256, v.expect.bodySha256, v.name);
    const canonical = signing.canonicalString({ ...i, bodySha256 });
    assert.equal(canonical, v.expect.canonical, v.name);
    assert.equal(signing.signCanonical(v.secret, canonical), v.expect.sig, v.name);
  }
});

test("signatureHeaders signs each refund-state vector exactly (the bytes profile-service verifies)", () => {
  for (const v of V.vectors.filter((x) => x.input.aud === "profile-service")) {
    const i = v.input;
    const h = signing.signatureHeaders({
      method: i.method, url: `http://profile-service:4002${i.target}`, tenant: i.tenant,
      env: { PROFILE_SIGNING_KID: i.kid, PROFILE_SIGNING_SECRET: v.secret }, now: Number(i.ts) * 1000, nonce: i.nonce,
    });
    assert.deepEqual(h, { "x-svc-version": "1", "x-svc-caller": "account-service", "x-svc-kid": i.kid, "x-svc-ts": i.ts, "x-svc-nonce": i.nonce, "x-svc-sig": v.expect.sig }, v.name);
  }
});

test("signer config: unset, short secret or bad kid -> null (never an unsigned or weak request)", () => {
  assert.equal(signing.signingConfig({}), null);
  assert.equal(signing.signingConfig({ PROFILE_SIGNING_KID: KID, PROFILE_SIGNING_SECRET: "short" }), null);
  assert.equal(signing.signingConfig({ PROFILE_SIGNING_KID: "bad kid", PROFILE_SIGNING_SECRET: SIGN_SECRET }), null);
  assert.equal(signing.signingConfig({ PROFILE_SIGNING_SECRET: SIGN_SECRET }), null);
  // the S3 signer variables (other direction) are never read
  assert.equal(signing.signingConfig({ ACCOUNT_SIGNING_KID: KID, ACCOUNT_SIGNING_SECRET: SIGN_SECRET }), null);
});

// ---------------------------------------------------------------- 2. provider mapping
beforeEach(() => {
  stand.requests = [];
  stand.respond = null;
});

test("verified: signed GET, exact path, tenant header; NO user token, gateway identity or internal flag forwarded", async () => {
  const r = await lookup({ tenantId: TA, applicationId: "APP-1" });
  assert.deepEqual(r, { applicationId: "APP-1", tenantId: TA, status: "submitted" });
  assert.equal(stand.requests.length, 1);
  const [q] = stand.requests;
  assert.equal(q.method, "GET");
  assert.equal(q.url, "/api/internal/applications/APP-1/refund-state");
  assert.equal(q.verified, true);
  assert.equal(q.headers["x-tenant-id"], TA);
  assert.equal(q.headers["x-svc-caller"], "account-service");
  assert.equal(q.headers["x-svc-kid"], KID);
  for (const h of ["authorization", "x-internal-request", "x-jwt-verified", "x-auth-source", "x-user-id", "x-user-type", "x-user-roles", "x-user-permissions", "idempotency-key", "content-type"]) {
    assert.equal(q.headers[h], undefined, `${h} must not be sent`);
  }
  for (const status of ["in-progress", "processed", "rejected"]) {
    stand.respond = ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId, status } } });
    assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-1" }), { applicationId: "APP-1", tenantId: TA, status });
  }
  // every call signs with a fresh nonce
  assert.equal(new Set(stand.requests.map((x) => x.headers["x-svc-nonce"])).size, stand.requests.length);
});

test("PROFILE_SERVICE_URL with or without /api resolves to the same signed path", async () => {
  for (const base of [STAND, `${STAND}/`, `${STAND}/api`, `${STAND}/api/`]) {
    const r = await lookup({ tenantId: TA, applicationId: "APP-2" }, { env: { ...ENV(), PROFILE_SERVICE_URL: base } });
    assert.equal(r.status, "submitted", base);
  }
  assert.ok(stand.requests.every((q) => q.url === "/api/internal/applications/APP-2/refund-state" && q.verified));
});

test("auth rejected by profile (401 / 403, any code) -> unverified, reason auth", async () => {
  for (const [status, code] of [[401, "SERVICE_AUTH_INVALID"], [401, "SERVICE_AUTH_STALE"], [401, "SERVICE_AUTH_REPLAY"], [401, "SERVICE_AUTH_UNKNOWN_KID"], [403, "SERVICE_NOT_ALLOWED"], [401, "SERVICE_AUTH_REQUIRED"]]) {
    stand.respond = () => ({ status, body: { success: false, code } });
    assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-3" }), { unverified: true, reason: "auth" }, code);
  }
  // a wrong key really is rejected by the stand-in (no stubbing of the verdict)
  const r = await lookup({ tenantId: TA, applicationId: "APP-3" }, { env: { ...ENV(), PROFILE_SIGNING_SECRET: crypto.randomBytes(32).toString("hex") } });
  assert.deepEqual(r, { unverified: true, reason: "auth" });
});

test("business: 404, 422, id / tenant mismatch, unknown status -> unverified, reason business", async () => {
  const cases = [
    () => ({ status: 404, body: { success: false, code: "APPLICATION_NOT_FOUND" } }),
    () => ({ status: 422, body: { success: false, code: "APPLICATION_STATE_UNRECOGNISED" } }),
    ({ tenantId }) => ({ status: 200, body: { data: { applicationId: "APP-OTHER", tenantId, status: "submitted" } } }),
    ({ applicationId }) => ({ status: 200, body: { data: { applicationId, tenantId: TB, status: "submitted" } } }),
    ({ applicationId }) => ({ status: 200, body: { data: { applicationId, status: "submitted" } } }),
    ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId, status: "approved" } } }),
    ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId, status: "SUBMITTED" } } }),
    ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId } } }),
  ];
  for (const c of cases) {
    stand.respond = c;
    assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-4" }), { unverified: true, reason: "business" });
  }
  // invalid identifiers are never sent
  const before = stand.requests.length;
  for (const applicationId of ["", "a/b", "x".repeat(65), "../x", "APP 1"]) {
    assert.deepEqual(await lookup({ tenantId: TA, applicationId }), { unverified: true, reason: "business" });
  }
  assert.deepEqual(await lookup({ tenantId: "not-a-tenant", applicationId: "APP-4" }), { unverified: true, reason: "business" });
  assert.equal(stand.requests.length, before);
});

test("unavailable: timeout, transport, 5xx, other status, malformed body, signer / URL not configured", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 3000);
  stand.respond = () => ({ delayMs: 400, status: 200, body: { data: {} } });
  const t0 = Date.now();
  assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-5" }, { timeoutMs: 100 }), { unavailable: true, reason: "timeout" });
  assert.ok(Date.now() - t0 < 350, "bounded by the timeout, not the upstream");
  stand.respond = () => ({ destroy: true });
  assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-5" }), { unavailable: true, reason: "transport" });
  const closed = `http://127.0.0.1:${await freePort()}`;
  assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-5" }, { env: { ...ENV(), PROFILE_SERVICE_URL: closed } }), { unavailable: true, reason: "transport" });
  for (const [status, reason] of [[500, "upstream_5xx"], [502, "upstream_5xx"], [503, "upstream_5xx"], [409, "upstream_status"], [429, "upstream_status"], [400, "upstream_status"], [302, "upstream_status"]]) {
    stand.respond = () => ({ status, body: { success: false, code: "SERVICE_AUTH_STORE_UNAVAILABLE" } });
    const r = await lookup({ tenantId: TA, applicationId: "APP-5" });
    if (status === 302) assert.equal(r.unavailable, true);
    else assert.deepEqual(r, { unavailable: true, reason }, String(status));
  }
  for (const body of ["not json", "", "[]", { status: "success" }, { data: null }]) {
    stand.respond = () => ({ status: 200, body });
    assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-5" }), { unavailable: true, reason: "malformed_response" });
  }
  const before = stand.requests.length;
  assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-5" }, { env: { PROFILE_SERVICE_URL: STAND } }), { unavailable: true, reason: "not_configured" });
  assert.deepEqual(await lookup({ tenantId: TA, applicationId: "APP-5" }, { env: { PROFILE_SIGNING_KID: KID, PROFILE_SIGNING_SECRET: SIGN_SECRET } }), { unavailable: true, reason: "not_configured" });
  assert.equal(stand.requests.length, before, "nothing is sent unsigned or to a default URL");
});

test("client logs carry no signature, nonce, secret or headers", async () => {
  const lines = [];
  const logger = { info: (o) => lines.push(o), warn: (o) => lines.push(o), error: (o) => lines.push(o) };
  await fetchApplicationRefundState({ tenantId: TA, applicationId: "APP-6" }, { env: ENV(), logger });
  stand.respond = () => ({ status: 401, body: { success: false, code: "SERVICE_AUTH_INVALID" } });
  await fetchApplicationRefundState({ tenantId: TA, applicationId: "APP-6" }, { env: ENV(), logger });
  assert.equal(lines.length, 2);
  const text = JSON.stringify(lines);
  for (const q of stand.requests) {
    assert.ok(!text.includes(q.headers["x-svc-sig"]));
    assert.ok(!text.includes(q.headers["x-svc-nonce"]));
  }
  assert.ok(!text.includes(SIGN_SECRET));
  assert.deepEqual(lines.map((l) => [l.outcome, l.reason]), [["verified", null], ["unverified", "auth"]]);
});

// ---------------------------------------------------------------- 3. CRM refund path (real app)
test("enforce: each lookup failure refuses with its distinct code + reason and never calls Stripe", { skip }, async () => {
  process.env.REFUND_POLICY_MODE = "enforce";
  const cases = [
    ["auth 401", () => ({ status: 401, body: { code: "SERVICE_AUTH_INVALID" } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "auth"],
    ["auth 403", () => ({ status: 403, body: { code: "SERVICE_NOT_ALLOWED" } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "auth"],
    ["not found", () => ({ status: 404, body: { code: "APPLICATION_NOT_FOUND" } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "business"],
    ["unrecognised", () => ({ status: 422, body: { code: "APPLICATION_STATE_UNRECOGNISED" } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "business"],
    ["id mismatch", ({ tenantId }) => ({ status: 200, body: { data: { applicationId: "APP-ELSE", tenantId, status: "submitted" } } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "business"],
    ["tenant mismatch", ({ applicationId }) => ({ status: 200, body: { data: { applicationId, tenantId: TB, status: "submitted" } } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "business"],
    ["unknown status", ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId, status: "approved" } } }), 409, "REFUND_APPLICATION_STATE_UNVERIFIED", "business"],
    ["store down 503", () => ({ status: 503, body: { code: "SERVICE_AUTH_STORE_UNAVAILABLE" } }), 503, "REFUND_APPLICATION_STATE_UNAVAILABLE", "unavailable"],
    ["mode off 503", () => ({ status: 503, body: { code: "APPLICATION_STATE_LOOKUP_DISABLED" } }), 503, "REFUND_APPLICATION_STATE_UNAVAILABLE", "unavailable"],
    ["500", () => ({ status: 500, body: {} }), 503, "REFUND_APPLICATION_STATE_UNAVAILABLE", "unavailable"],
    ["transport", () => ({ destroy: true }), 503, "REFUND_APPLICATION_STATE_UNAVAILABLE", "unavailable"],
    ["timeout", () => ({ delayMs: 3600, status: 200, body: {} }), 503, "REFUND_APPLICATION_STATE_UNAVAILABLE", "unavailable"],
    ["processed, no CLAIM", ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId, status: "processed" } } }), 409, "REFUND_INCONSISTENT_APPROVED_NO_TRANSFER", null],
  ];
  for (const [name, respond, status, code, reason] of cases) {
    const p = await seedFlowA(`APP-RS-${seq + 1}`);
    stand.respond = respond;
    const before = stripe.createCalls;
    const t0 = Date.now();
    const r = await refund(body(p.pi));
    assert.equal(r.status, status, `${name}: ${r.text}`);
    assert.equal(r.code, code, name);
    assert.equal(r.reason, reason, name);
    assert.equal(stripe.createCalls, before, `${name}: no Stripe call`);
    assert.equal(await Refund.countDocuments({ tenantId: TA, paymentId: p._id }), 0, `${name}: no Refund row`);
    assert.equal(await RefundOperation.countDocuments({ tenantId: TA, paymentId: p._id }), 0, `${name}: no operation left`);
    const row = await Payment.findById(p._id).lean();
    assert.equal((row.refundReservations || []).length, 0, `${name}: no reservation held`);
    if (name === "timeout") assert.ok(Date.now() - t0 < 3500 + 1500, "bounded by the 3 s client timeout");
  }
  // the signature actually verified on every call the provider made
  assert.ok(stand.requests.length >= cases.length - 0);
  assert.ok(stand.requests.every((q) => q.verified && q.headers.authorization === undefined));
});

test("enforce: verified unapproved application -> flow A refund proceeds (one Stripe call)", { skip }, async () => {
  process.env.REFUND_POLICY_MODE = "enforce";
  for (const status of ["submitted", "in-progress", "rejected"]) {
    const p = await seedFlowA(`APP-OK-${seq + 1}`);
    stand.respond = ({ applicationId, tenantId }) => ({ status: 200, body: { data: { applicationId, tenantId, status } } });
    const before = stripe.createCalls;
    const r = await refund(body(p.pi));
    assert.equal(r.status, 200, r.text);
    assert.equal(stripe.createCalls, before + 1);
    const q = stand.requests.at(-1);
    assert.equal(q.url, `/api/internal/applications/APP-OK-${seq}/refund-state`);
    assert.equal(q.headers["x-tenant-id"], TA);
  }
});

test("report: decision and reason recorded, nothing new refused", { skip }, async () => {
  delete process.env.REFUND_POLICY_MODE;
  const p = await seedFlowA(`APP-REP-${seq + 1}`);
  stand.respond = () => ({ status: 401, body: { code: "SERVICE_AUTH_INVALID" } });
  const r = await refund(body(p.pi));
  assert.equal(r.status, 200, r.text);
  const [op] = await RefundOperation.find({ tenantId: TA, paymentId: p._id }).lean();
  assert.equal(op.policy.flow, "A");
  assert.equal(op.policy.wouldRefuse, "REFUND_APPLICATION_STATE_UNVERIFIED");
  assert.equal(op.policy.wouldRefuseReason, "auth");
});
