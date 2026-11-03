// GET /api/payments/attempts - CRM Online Payments grid over persisted Payment attempts.
// REAL app router + REAL throwaway mongod; fake PDP (PERMIT iff the test token carries
// `${resource}:${action}`), fake profile-/subscription-service for display enrichment, no Stripe
// network calls. Rows are inserted raw so createdAt / secrets / metadata are controlled.
//
//   node --test --test-force-exit src/tests/paymentAttempts.p5.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-pay-attempts-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.JWT_SECRET = "p5-payment-attempts-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_attempts";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TB = "bbbbbbbbbbbbbbbbbbbbbbbb";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-pay-attempts-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_attempts_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
}
const decode = (t) => { try { return jwt.verify(String(t || "").replace(/^Bearer /, ""), SECRET); } catch { return null; } };

// ---- fake PDP ----
const pdp = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  const claims = decode(body.token);
  const permit = Boolean(claims && (claims.permissions || []).includes(`${body.resource}:${body.action}`));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(permit
    ? { success: true, decision: "PERMIT", user: { id: claims.id, tenantId: claims.tenantId, userType: claims.userType, roles: claims.roles || [], permissions: claims.permissions || [] } }
    : { success: false, decision: "DENY", reason: "TEST_PDP_DENY" }));
});

// ---- fake profile-service / subscription-service (display enrichment) ----
// Contact details are returned on purpose: the endpoint must never pass them through.
const upstreamCalls = [];
const upstreamAuth = [];
const profileSvc = http.createServer((req, res) => {
  upstreamCalls.push(req.url);
  upstreamAuth.push(req.headers.authorization ? "bearer" : "none");
  res.setHeader("content-type", "application/json");
  const m = /^\/api\/applications\/([^/?]+)/.exec(req.url);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (id === "APP-FAIL") { res.statusCode = 500; return res.end("{}"); }
    return res.end(JSON.stringify({ data: {
      applicationId: id,
      applicationStatus: "submitted",
      personalDetails: {
        personalInfo: { forename: "Test", surname: `Applicant ${id}` },
        contactInfo: { mobileNumber: "+353000000000", personalEmail: "leak-check@example.invalid" },
        normalizedEmail: "leak-check@example.invalid",
      },
      subscriptionDetails: { membershipCategory: "GENERAL", paymentFrequency: "Annually", paymentType: "Card Payment" },
    } }));
  }
  if (req.url.startsWith("/api/profile/search")) {
    return res.end(JSON.stringify({ data: { results: [{ _id: "pf0000000000000000000001", membershipNumber: "M-100", personalInfo: { fullName: "Member Hundred" }, contactInfo: { mobileNumber: "+353000000001" }, normalizedEmail: "leak-check@example.invalid" }] } }));
  }
  if (req.url.startsWith("/api/v1/subscriptions")) {
    return res.end(JSON.stringify({ data: { data: [{ isCurrent: true, membershipCategory: "GENERAL", subscriptionStatus: "Active", paymentFrequency: "Annually", paymentType: "Card Payment" }] } }));
  }
  return res.end(JSON.stringify({ data: null }));
});

await new Promise((r) => pdp.listen(0, "127.0.0.1", r));
await new Promise((r) => profileSvc.listen(0, "127.0.0.1", r));
process.env.POLICY_SERVICE_URL = `http://127.0.0.1:${pdp.address().port}`;
process.env.PROFILE_SERVICE_URL = `http://127.0.0.1:${profileSvc.address().port}`;
process.env.SUBSCRIPTION_SERVICE_URL = `http://127.0.0.1:${profileSvc.address().port}`;

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
const published = [];
publisher.publish = async (type, data) => { published.push({ type, data }); return { success: true, eventId: "test" }; };
const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { processStripeEvent } = await import("../controllers/webhook.controller.js");
const { default: app } = await import("../app.js");

after(async () => {
  pdp.close();
  profileSvc.close();
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  if (mongodProc) mongodProc.kill("SIGKILL");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// ---- callers ----
const bearer = ({ tenantId = TA, userType, id, permissions = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles: [], permissions }, SECRET, { expiresIn: "1h" })}`;
const CRM_A = bearer({ userType: "CRM", id: "staff-a", permissions: ["accounts.journals:read"] });
const CRM_B = bearer({ tenantId: TB, userType: "CRM", id: "staff-b", permissions: ["accounts.journals:read"] });
const CRM_NOPERM = bearer({ userType: "CRM", id: "staff-mo", permissions: ["profiles:read", "payments:read"] });
const PORTAL_ALL = bearer({ userType: "PORTAL", id: "member-a", permissions: ["accounts.journals:read", "payments:read", "accounts.reports:read"] });

async function call(url, { auth, headers = {} } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const h = { ...headers };
    if (auth) h.authorization = auth;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers: h });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, data: json?.data ?? null, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---- fixtures ----
const oid = () => new mongoose.Types.ObjectId();
const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const at = (minutesAgo) => new Date(T0 - minutesAgo * 60000);
const ids = {};
const seedStripe = (key) => ({
  paymentIntentId: `pi_${key}`,
  clientSecret: `pi_${key}_secret_DO_NOT_LEAK`,
  checkoutUrl: "https://checkout.invalid/DO_NOT_LEAK",
  customerId: "cus_DO_NOT_LEAK",
  paymentMethodId: "pm_DO_NOT_LEAK",
  chargeId: "ch_DO_NOT_LEAK",
  failureMessage: "provider free text DO_NOT_LEAK",
  nextAction: { type: "redirect_to_url", url: "https://next.invalid/DO_NOT_LEAK" },
});
function pay(key, over = {}) {
  const _id = oid();
  ids[key] = _id;
  return {
    _id,
    tenantId: TA,
    purpose: "applicationFee",
    ledgerDomain: "membership",
    amount: 5000,
    currency: "eur",
    status: "created",
    attemptNumber: 1,
    isActiveAttempt: true,
    source: "portal",
    mode: "stripe",
    metadata: { secretMeta: "meta_DO_NOT_LEAK" },
    payer: { userId: "member-a", userType: "PORTAL" },
    audit: { createdBy: "member-a" },
    webhookEventIds: ["evt_seed_DO_NOT_LEAK"],
    auditHistory: [{ eventId: "evt_seed_DO_NOT_LEAK", eventType: "seed", status: "created", receivedAt: new Date(T0) }],
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
    stripe: { ...seedStripe(key), ...(over.stripe || {}) },
  };
}
function receipt(paymentKey, { tenantId = TA, status = "PENDING", amount = 5000, prefix = "RCP-" } = {}) {
  return {
    _id: oid(),
    tenantId,
    date: at(1),
    docType: "Receipt",
    docNo: `${prefix}${ids[paymentKey]}`,
    memo: "Receipt",
    settlement: { provider: "Stripe", status },
    entries: [
      { accountCode: "1220", dc: "D", amount },
      { accountCode: "2020", dc: "C", amount, applicationId: "APP-X" },
      { accountCode: "5100", dc: "D", amount: 100 },
      { accountCode: "1220", dc: "C", amount: 100 },
    ],
    createdAt: at(1),
    updatedAt: at(1),
  };
}

const ALLOWED_KEYS = [
  "id", "attemptNumber", "isActiveAttempt", "supersededAt", "purpose", "ledgerDomain", "source", "mode",
  "amount", "currency", "lifecycleStatus", "providerStatus", "amountCaptured", "amountRefunded",
  "applicationId", "registrationId", "profileId", "memberId", "payerUserType", "createdAt", "authorisedAt",
  "capturedAt", "canceledAt", "capturableUntil", "failureCode", "cancellationReason", "paymentIntentId",
  "receipt", "membershipNumber", "fullName", "membershipCategory", "membershipStatus", "joinDate",
  "renewalDate", "billingCycle", "paymentMethod", "actions",
].sort();
const RECEIPT_KEYS = ["id", "docNo", "date", "settlementStatus", "settlementProvider", "paidAmount"].sort();

const FILLERS = 60;
let tenantATotal = 0;

if (!skip) {
  await mongoose.connect(uri);
  await Payment.init();
  const A = [
    pay("auth", { status: "requires_capture", applicationId: "APP-AUTH", attemptNumber: 2, authorisedAt: at(9), capturableUntil: new Date(T0 + 7 * 86400000), createdAt: at(10) }),
    pay("authOld", { status: "canceled", applicationId: "APP-AUTH", attemptNumber: 1, isActiveAttempt: false, supersededAt: at(10), supersededReason: "retry", stripe: { canceledAt: at(10), cancellationReason: "abandoned" }, createdAt: at(20) }),
    pay("cancel", { status: "canceled", applicationId: "APP-CANC", stripe: { canceledAt: at(25), cancellationReason: "requested_by_customer" }, createdAt: at(30) }),
    pay("captured", { status: "succeeded", applicationId: "APP-CAP", stripe: { capturedAt: at(39) }, createdAt: at(40) }),
    pay("failed", { status: "failed", applicationId: "APP-FAILED", stripe: { failureCode: "card_declined" }, createdAt: at(50) }),
    pay("refunded", { status: "refunded", applicationId: "APP-REF", createdAt: at(60) }),
    pay("partial", { status: "partially_refunded", applicationId: "APP-PART", createdAt: at(70) }),
    pay("partialFull", { status: "partially_refunded", amount: 4000, applicationId: "APP-PFULL", createdAt: at(80) }),
    pay("event", { status: "requires_capture", purpose: "eventRegistration", ledgerDomain: "events", registrationId: "REG-1", profileId: "pf0000000000000000000009", createdAt: at(90) }),
    pay("enrichFail", { status: "created", applicationId: "APP-FAIL", createdAt: at(100) }),
    pay("member", { status: "succeeded", purpose: "subscriptionFee", memberId: "M-100", createdAt: at(110) }),
    pay("manual", { status: "manual_review", mode: "external", purpose: "eventRegistration", ledgerDomain: "events", registrationId: "REG-2", stripe: { paymentIntentId: undefined }, createdAt: at(120) }),
    pay("expired", { status: "authorization_expired", applicationId: "APP-EXP", createdAt: at(130) }),
    pay("refundReq", { status: "refund_required", applicationId: "APP-RREQ", createdAt: at(140) }),
  ];
  // Fillers share ONE createdAt so the _id tie-break is exercised across page boundaries.
  for (let i = 0; i < FILLERS; i += 1) {
    A.push(pay(`fill${i}`, { status: "created", purpose: "subscriptionFee", applicationId: undefined, createdAt: at(200) }));
  }
  const B = [
    pay("bAuth", { tenantId: TB, status: "requires_capture", applicationId: "APP-AUTH", createdAt: at(5) }),
    pay("bCap", { tenantId: TB, status: "succeeded", applicationId: "APP-BCAP", createdAt: at(15) }),
  ];
  for (const d of [...A, ...B]) {
    if (d.stripe.paymentIntentId === undefined) delete d.stripe.paymentIntentId;
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  }
  await Payment.collection.insertMany([...A, ...B]);
  tenantATotal = A.length;
  await GLTransaction.collection.insertMany([
    receipt("captured"),
    receipt("partial"),
    receipt("member"),
    receipt("refunded"),
    receipt("bCap", { tenantId: TB }),
  ]);
  await Refund.collection.insertMany([
    { tenantId: TA, paymentId: ids.refunded, mode: "stripe", amount: 5000, currency: "eur", createdAt: at(55) },
    { tenantId: TA, paymentId: ids.partial, mode: "stripe", amount: 2000, currency: "eur", createdAt: at(65) },
    { tenantId: TA, paymentId: ids.partialFull, mode: "stripe", amount: 1500, currency: "eur", createdAt: at(75) },
    { tenantId: TA, paymentId: ids.partialFull, mode: "stripe", amount: 2500, currency: "eur", createdAt: at(74) },
    // a refund recorded under ANOTHER tenant for a tenant-A payment id is never counted
    { tenantId: TB, paymentId: ids.partial, mode: "stripe", amount: 3000, currency: "eur", createdAt: at(64) },
  ]);
}

const URL = "/api/payments/attempts";
const byId = (items, key) => items.find((i) => i.id === String(ids[key]));

test("authorised hold (requires_capture) is visible before approval: authorised, no receipt, canRefund false", { skip }, async () => {
  const r = await call(`${URL}?applicationId=APP-AUTH`, { auth: CRM_A });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.items.length, 2, "active + superseded attempt, tenant B's APP-AUTH row absent");
  const a = byId(r.data.items, "auth");
  assert.equal(a.lifecycleStatus, "authorised");
  assert.equal(a.providerStatus, "requires_capture");
  assert.equal(a.receipt, null);
  assert.equal(a.amountCaptured, 0);
  assert.equal(a.amountRefunded, 0);
  assert.deepEqual(a.actions, { canRefund: false });
  assert.equal(a.isActiveAttempt, true);
  assert.equal(a.attemptNumber, 2);
  assert.ok(a.capturableUntil && a.authorisedAt);
  assert.equal(a.paymentIntentId, "pi_auth");
  assert.equal(a.payerUserType, "PORTAL");
  assert.equal(a.fullName, "Test Applicant APP-AUTH");
  assert.equal(a.membershipCategory, "GENERAL");
  const old = byId(r.data.items, "authOld");
  assert.equal(old.isActiveAttempt, false);
  assert.ok(old.supersededAt);
  assert.equal(old.lifecycleStatus, "cancelled");
});

test("cancelled hold (rejected application) is visible: cancelled, no receipt; expired hold is cancelled too", { skip }, async () => {
  const r = await call(`${URL}?applicationId=APP-CANC`, { auth: CRM_A });
  assert.equal(r.status, 200);
  const c = byId(r.data.items, "cancel");
  assert.equal(c.lifecycleStatus, "cancelled");
  assert.equal(c.providerStatus, "canceled");
  assert.equal(c.cancellationReason, "requested_by_customer");
  assert.ok(c.canceledAt);
  assert.equal(c.receipt, null);
  assert.equal(c.actions.canRefund, false);
  const e = byId((await call(`${URL}?applicationId=APP-EXP`, { auth: CRM_A })).data.items, "expired");
  assert.equal(e.lifecycleStatus, "cancelled");
  assert.equal(e.providerStatus, "authorization_expired");
});

test("captured payment: captured + receipt link (grid fields), canRefund true only for an unapproved PENDING receipt row", { skip }, async () => {
  const r = await call(`${URL}?applicationId=APP-CAP`, { auth: CRM_A });
  const c = byId(r.data.items, "captured");
  assert.equal(c.lifecycleStatus, "captured");
  assert.equal(c.amountCaptured, 5000);
  assert.equal(c.amountRefunded, 0);
  assert.deepEqual(Object.keys(c.receipt).sort(), RECEIPT_KEYS);
  assert.equal(c.receipt.docNo, `RCP-${ids.captured}`);
  assert.equal(c.receipt.settlementStatus, "PENDING");
  assert.equal(c.receipt.settlementProvider, "Stripe");
  assert.equal(c.receipt.paidAmount, 5000);
  assert.ok(c.receipt.date);
  assert.equal(c.actions.canRefund, true);
  // approved member payment (memberId set): captured with receipt, but the grid's rule excludes it
  const all = (await call(`${URL}?limit=200`, { auth: CRM_A })).data.items;
  const m = byId(all, "member");
  assert.equal(m.lifecycleStatus, "captured");
  assert.ok(m.receipt);
  assert.equal(m.actions.canRefund, false);
  assert.equal(m.membershipNumber, "M-100");
  assert.equal(m.membershipStatus, "Active");
  // refund_required = captured funds owed back; refund endpoint refuses it, so canRefund false
  const rr = byId(all, "refundReq");
  assert.equal(rr.lifecycleStatus, "captured");
  assert.equal(rr.amountCaptured, 5000);
  assert.equal(rr.actions.canRefund, false);
});

test("failed -> failed; full refund -> refunded; partial -> partially_refunded with Refund-derived amounts", { skip }, async () => {
  const all = (await call(`${URL}?limit=200`, { auth: CRM_A })).data.items;
  const f = byId(all, "failed");
  assert.equal(f.lifecycleStatus, "failed");
  assert.equal(f.failureCode, "card_declined");
  assert.equal(f.amountCaptured, 0);
  assert.equal(f.actions.canRefund, false);
  const full = byId(all, "refunded");
  assert.equal(full.lifecycleStatus, "refunded");
  assert.equal(full.amountCaptured, 5000);
  assert.equal(full.amountRefunded, 5000);
  assert.equal(full.actions.canRefund, false);
  const part = byId(all, "partial");
  assert.equal(part.lifecycleStatus, "partially_refunded");
  assert.equal(part.amountCaptured, 5000);
  assert.equal(part.amountRefunded, 2000, "tenant B's refund row for the same payment id is not counted");
  assert.equal(part.actions.canRefund, true);
  // stored partially_refunded but the Refund rows cover the whole amount -> refunded
  const pf = byId(all, "partialFull");
  assert.equal(pf.providerStatus, "partially_refunded");
  assert.equal(pf.lifecycleStatus, "refunded");
  assert.equal(pf.amountRefunded, 4000);
  assert.equal(pf.actions.canRefund, false);
  // manual external record awaiting posting is not guessed
  const man = byId(all, "manual");
  assert.equal(man.lifecycleStatus, "unknown");
  assert.equal(man.mode, "external");
  // enrichment failure for one application does not fail the page
  const ef = byId(all, "enrichFail");
  assert.equal(ef.lifecycleStatus, "pending");
  assert.equal(ef.fullName, null);
});

test("webhook retry (same Stripe event id) does not duplicate an attempt or its history", { skip }, async () => {
  const doc = pay("replay", { status: "requires_action", applicationId: "APP-REPLAY", webhookEventIds: [], auditHistory: [], createdAt: at(3) });
  await Payment.collection.insertOne(doc);
  const event = {
    id: "evt_replay_1",
    type: "payment_intent.amount_capturable_updated",
    created: Math.floor(T0 / 1000),
    data: { object: { id: "pi_replay", object: "payment_intent", amount: 5000, currency: "eur", status: "requires_capture", created: Math.floor(T0 / 1000), metadata: { tenantId: TA, applicationId: "APP-REPLAY" } } },
  };
  const first = await processStripeEvent(event);
  assert.equal(first?.ok, true);
  const afterFirst = await Payment.findOne({ tenantId: TA, "stripe.paymentIntentId": "pi_replay" }).lean();
  assert.equal(afterFirst.status, "requires_capture");
  const second = await processStripeEvent(event);
  assert.equal(second?.duplicate, true);
  assert.equal(await Payment.countDocuments({ "stripe.paymentIntentId": "pi_replay" }), 1);
  const afterSecond = await Payment.findOne({ tenantId: TA, "stripe.paymentIntentId": "pi_replay" }).lean();
  assert.equal(afterSecond.auditHistory.length, afterFirst.auditHistory.length);
  assert.deepEqual(afterSecond.webhookEventIds, ["evt_replay_1"]);
  const r = await call(`${URL}?applicationId=APP-REPLAY`, { auth: CRM_A });
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].lifecycleStatus, "authorised");
  await Payment.collection.deleteOne({ _id: doc._id });
});

test("pagination: keyset cursor walks every tenant-A row exactly once in stable order; default/cap limits", { skip }, async () => {
  const seen = [];
  let cursor = null;
  let pages = 0;
  let total = null;
  do {
    const r = await call(`${URL}?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { auth: CRM_A });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.items.length <= 7);
    if (total === null) total = r.data.total;
    assert.equal(r.data.total, total, "total is the filter total, independent of the cursor");
    seen.push(...r.data.items.map((i) => i.id));
    cursor = r.data.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  assert.equal(new Set(seen).size, seen.length, "no overlap");
  assert.equal(seen.length, tenantATotal, "no gaps");
  assert.equal(total, tenantATotal);
  const expected = (await Payment.find({ tenantId: TA }).sort({ createdAt: -1, _id: -1 }).select({ _id: 1 }).lean()).map((d) => String(d._id));
  assert.deepEqual(seen, expected);
  for (const id of [ids.bAuth, ids.bCap]) assert.ok(!seen.includes(String(id)));

  const d = await call(URL, { auth: CRM_A });
  assert.equal(d.data.limit, 50);
  assert.equal(d.data.items.length, 50);
  assert.ok(d.data.nextCursor);
  const max = await call(`${URL}?limit=200`, { auth: CRM_A });
  assert.equal(max.data.items.length, tenantATotal);
  assert.equal(max.data.nextCursor, null);
  assert.equal((await call(`${URL}?limit=201`, { auth: CRM_A })).status, 400);
  assert.equal((await call(`${URL}?limit=0`, { auth: CRM_A })).status, 400);
});

test("filters: status (lifecycle), purpose, registrationId, mode, dates", { skip }, async () => {
  const st = async (s) => (await call(`${URL}?status=${s}&limit=200`, { auth: CRM_A })).data.items.map((i) => i.id).sort();
  assert.deepEqual(await st("authorised"), [ids.auth, ids.event].map(String).sort());
  assert.deepEqual(await st("refunded"), [ids.refunded, ids.partialFull].map(String).sort());
  assert.deepEqual(await st("partially_refunded"), [String(ids.partial)]);
  assert.deepEqual(await st("refunded,partially_refunded"), [ids.refunded, ids.partialFull, ids.partial].map(String).sort());
  assert.deepEqual(await st("cancelled"), [ids.authOld, ids.cancel, ids.expired].map(String).sort());
  assert.deepEqual(await st("captured"), [ids.captured, ids.member, ids.refundReq].map(String).sort());
  assert.deepEqual(await st("unknown"), [String(ids.manual)]);
  assert.deepEqual(await st("failed,authorised"), [ids.failed, ids.auth, ids.event].map(String).sort());
  const statusCount = (await call(`${URL}?status=refunded`, { auth: CRM_A })).data.total;
  assert.equal(statusCount, 2);

  const ev = (await call(`${URL}?purpose=eventRegistration&limit=200`, { auth: CRM_A })).data.items;
  assert.deepEqual(ev.map((i) => i.id).sort(), [ids.event, ids.manual].map(String).sort());
  const reg = (await call(`${URL}?registrationId=REG-1`, { auth: CRM_A })).data.items;
  assert.deepEqual(reg.map((i) => i.id), [String(ids.event)]);
  assert.equal(reg[0].ledgerDomain, "events");
  const ext = (await call(`${URL}?mode=external`, { auth: CRM_A })).data.items;
  assert.deepEqual(ext.map((i) => i.id), [String(ids.manual)]);
  const none = await call(`${URL}?from=2026-11-01&to=2026-11-02`, { auth: CRM_A });
  assert.equal(none.data.items.length, 0);
  assert.equal(none.data.total, 0);
});

test("invalid / unknown query params -> 400", { skip }, async () => {
  for (const qs of [
    "status=captured,bogus",
    "status=succeeded",
    "status=captured&status=failed",
    "purpose=nope",
    "mode=cash",
    "from=not-a-date",
    "limit=abc",
    "cursor=garbage",
    "applicationId[$ne]=x",
    "applicationId=bad%20id",
    "tenantId=" + TB,
    "skip=10",
  ]) {
    const r = await call(`${URL}?${qs}`, { auth: CRM_A });
    assert.equal(r.status, 400, `${qs}: ${r.status}`);
  }
});

test("authz: unauthenticated 401, internal header 401, PORTAL 403 CRM_ONLY, missing permission 403", { skip }, async () => {
  assert.equal((await call(URL)).status, 401);
  assert.equal((await call(URL, { headers: { "x-internal-request": "true", "x-tenant-id": TA } })).status, 401);
  const p = await call(URL, { auth: PORTAL_ALL });
  assert.equal(p.status, 403);
  assert.equal(p.code, "CRM_ONLY");
  assert.equal((await call(URL, { auth: CRM_NOPERM })).status, 403);
});

test("tenant scope: only the verified tenant's rows; tenant header / query cannot change it", { skip }, async () => {
  const b = await call(`${URL}?limit=200`, { auth: CRM_B });
  assert.equal(b.status, 200);
  assert.deepEqual(b.data.items.map((i) => i.id).sort(), [ids.bAuth, ids.bCap].map(String).sort());
  assert.equal(b.data.total, 2);
  const bCap = byId(b.data.items, "bCap");
  assert.equal(bCap.receipt.docNo, `RCP-${ids.bCap}`);
  // A tenant-A token asking for tenant B via header is refused (auth.js: 403 TENANT_CONTEXT_MISMATCH)
  const spoof = await call(URL, { auth: CRM_A, headers: { "x-tenant-id": TB } });
  assert.equal(spoof.status, 403);
  assert.equal(spoof.code, "TENANT_CONTEXT_MISMATCH");
  assert.ok(!spoof.text.includes(String(ids.bAuth)));
  assert.equal((await call(`${URL}?tenantId=${TB}`, { auth: CRM_A })).status, 400);
  // a tenant-B cursor/applicationId filter from tenant A still only yields tenant-A rows
  const a = await call(`${URL}?applicationId=APP-BCAP`, { auth: CRM_A });
  assert.equal(a.data.items.length, 0);
});

test("response items carry exactly the allow-listed keys; secrets / metadata / history / contact details never leak", { skip }, async () => {
  const r = await call(`${URL}?limit=200`, { auth: CRM_A });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ["items", "limit", "nextCursor", "total"]);
  for (const item of r.data.items) {
    assert.deepEqual(Object.keys(item).sort(), ALLOWED_KEYS, `keys of ${item.id}`);
    assert.deepEqual(Object.keys(item.actions), ["canRefund"]);
    if (item.receipt) assert.deepEqual(Object.keys(item.receipt).sort(), RECEIPT_KEYS);
  }
  for (const needle of ["DO_NOT_LEAK", "clientSecret", "checkoutUrl", "customerId", "paymentMethodId", "chargeId", "metadata", "auditHistory", "webhookEventIds", "nextAction", "failureMessage", "tenantId", "leak-check@example.invalid", "+353000000000", "+353000000001", "entries"]) {
    assert.ok(!r.text.includes(needle), `response must not contain ${needle}`);
  }
  // enrichment forwarded the caller's identity (no anonymous upstream call) and stayed batched
  assert.ok(upstreamAuth.length > 0 && upstreamAuth.every((a) => a === "bearer"));
});
