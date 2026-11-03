// P5 cross-service payment command contract (contracts/p5-bound-payment-commands.v1.json).
//
// The SAME fixture file is committed byte-identically in account-service, events-service and
// profile-service. The callers' tests assert that their serialized requests equal each case's
// `request`; this test replays every `request` against account's REAL router (real throwaway
// mongod, fake Stripe) and asserts:
//   - `expect` (status + data fields),
//   - an identical retry (same key + same body) returns the identical response,
//   - a conflicting retry (same key, different body) is 409 IDEMPOTENCY_CONFLICT,
//   - every `negative` case is refused with its code and nothing moves at Stripe.
// Drift: the SHA-256 below is pinned in all three repos; editing one copy fails that repo's
// suite until all three copies (and pins) are updated together.
//
//   node --test --test-force-exit src/tests/paymentContract.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CONTRACT_SHA256 = "f0d9d619e1f17c3868d4dc6b73772bdeeebbe0b6e48cd11e245ad9116253a065";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/p5-bound-payment-commands.v1.json");
const RAW = fs.readFileSync(FIXTURE);
const C = JSON.parse(RAW.toString("utf8"));

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-paycontract-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.JWT_SECRET = "p5-payment-contract-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_contract";
delete process.env.AUTH_BYPASS_ENABLED;

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-paycontract-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_contract_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { default: stripeClient } = await import("../lib/stripe.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: app } = await import("../app.js");
const { clearIdempotencyCache } = await import("../middlewares/idempotency.js");

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

async function send(request, bodyOverride) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${request.path}`, {
      method: request.method,
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(bodyOverride ?? request.body),
    });
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
    _id: new mongoose.Types.ObjectId(s._id),
    tenantId: T,
    purpose: s.purpose,
    ledgerDomain: s.ledgerDomain,
    amount: s.amount,
    currency: "eur",
    status: s.status,
    attemptNumber: 1,
    isActiveAttempt: true,
    eventCategoryCode: s.ledgerDomain === "events" ? "CPD" : undefined,
    audit: { createdBy: "contract-seed" },
    ...(s.applicationId ? { applicationId: s.applicationId } : {}),
    ...(s.applicationBinding ? { applicationBinding: s.applicationBinding } : {}),
    ...(s.registrationId ? { registrationId: s.registrationId } : {}),
    ...(s.registrationBinding
      ? { registrationBinding: s.registrationBinding, target: { entityType: "registration", entityId: s.registrationBinding } }
      : {}),
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

function assertSubset(actual, expected, label) {
  for (const [k, v] of Object.entries(expected || {})) {
    if (v === "<new>") assert.match(String(actual?.[k] ?? ""), /^[a-f0-9]{24}$/, `${label} data.${k}`);
    else assert.deepEqual(actual?.[k], v, `${label} data.${k}`);
  }
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  await Payment.syncIndexes();
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

test("contract fixture is the pinned version (byte-identical across the three repos)", () => {
  assert.equal(crypto.createHash("sha256").update(RAW).digest("hex"), CONTRACT_SHA256);
  assert.equal(C.contract, "p5-bound-payment-commands");
  assert.equal(C.version, 1);
});

for (const c of C.cases) {
  test(`contract ${c.name}: accepted, identical retry replays, conflicting retry 409`, { skip }, async () => {
    const first = await send(c.request);
    assert.equal(first.status, c.expect.status, `${c.name}: ${first.text.slice(0, 300)}`);
    assertSubset(first.data, c.expect.data, c.name);
    const retry = await send(c.request);
    assert.equal(retry.status, first.status, `${c.name} retry`);
    assert.equal(retry.text, first.text, `${c.name} retry must replay the identical response`);
    const conflicting = await send(c.request, { ...c.request.body, actorUserId: "d0000000000000000000ffff" });
    assert.equal(conflicting.status, 409, `${c.name} conflicting: ${conflicting.text.slice(0, 200)}`);
    assert.equal(conflicting.code, "IDEMPOTENCY_CONFLICT");
    // After the response cache is gone (TTL / restart) the stored state still decides: the same
    // command is a no-op that reports the same payment, never a second money movement.
    const before = MUTATIONS.length;
    clearIdempotencyCache();
    const late = await send(c.request);
    assert.ok(late.status === 200 || late.status === 201, `${c.name} late retry: ${late.text.slice(0, 200)}`);
    if (c.expect.data?.paymentId && c.expect.data.paymentId !== "<new>") assert.equal(late.data.paymentId, c.expect.data.paymentId);
    if (c.expect.data?.paymentId === "<new>") assert.equal(late.data.paymentId, first.data.paymentId);
    assert.equal(MUTATIONS.length, before, `${c.name}: a late retry must not move money again`);
  });
}

for (const n of C.negative) {
  test(`contract negative: ${n.name} -> ${n.expect.status} ${n.expect.code}`, { skip }, async () => {
    const res = await send(n.request);
    assert.equal(res.status, n.expect.status, res.text.slice(0, 200));
    assert.equal(res.code, n.expect.code);
    assert.equal(MUTATIONS.filter((m) => m[1] === n.seed.paymentIntentId).length, 0);
    assert.equal((await Payment.findById(n.seed._id).lean()).status, n.seed.status);
  });
}

test("contract: every Stripe money movement used the server-derived key", { skip }, async () => {
  for (const [kind, pi, key] of MUTATIONS) {
    const row = await Payment.findOne({ "stripe.paymentIntentId": pi }).lean();
    assert.equal(key, `acct:${kind}:${row._id}:${pi}`);
  }
});
