// P5 (b9) scripts/backfill-application-binding.js + scripts/stripe-intent-status-readonly.js.
// REAL throwaway mongod; synthetic ids only.
//
//   node --test --test-force-exit src/tests/applicationBindingBackfill.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-appbind-backfill-"));
process.env.NODE_ENV = "test";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-appbind-backfill-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/appbind_backfill_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { default: Payment } = await import("../models/payment.model.js");
const { hasAuthoritativeApplicationBinding } = await import("../helpers/applicationBinding.js");
const bf = await import("../../scripts/backfill-application-binding.js");
const st = await import("../../scripts/stripe-intent-status-readonly.js");
const { ObjectId } = mongoose.Types;

const TA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const oid = (n) => n.toString(16).padStart(24, "0");
const P1 = oid(0xb1), P2 = oid(0xb2), HOLD = oid(0xb9), OTHER = oid(0xba);
const APP1 = "app-1111", APP2 = "app-2222", APPH = "app-hold";
const U1 = "user-1", U2 = "user-2";

const row = (id, app, pi, status, createdBy, extra = {}) => ({
  _id: new ObjectId(id), tenantId: TA, purpose: "subscriptionFee", applicationId: app, status, mode: "stripe",
  source: "portal", isActiveAttempt: true, amount: 1000, currency: "eur",
  stripe: { paymentIntentId: pi }, audit: { createdBy }, ...extra,
});
const entry = (id, app, pi, status, createdBy) => ({ paymentId: id, tenantId: TA, applicationId: app, stripePaymentIntentId: pi, status, createdBy, evidenceRef: "b8:portal-subscriptiondetails" });
const allow = () => JSON.stringify([entry(P1, APP1, "pi_1", "succeeded", U1), entry(P2, APP2, "pi_2", "authorization_expired", U2)]);
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "as-appbind-bk-")), n);
const ledger = () => mongoose.connection.collection(bf.LEDGER);
const deps = () => ({ Payment, ledger: ledger(), ObjectId });
const get = (id) => Payment.findById(id).lean();

test.before(async () => { if (!skip) await mongoose.connect(uri); });
test.after(async () => {
  if (!skip) await mongoose.disconnect();
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});
test.beforeEach(async () => {
  if (skip) return;
  await Payment.collection.deleteMany({});
  await ledger().deleteMany({});
  await Payment.collection.insertMany([
    row(P1, APP1, "pi_1", "succeeded", U1),
    row(P2, APP2, "pi_2", "authorization_expired", U2),
    row(HOLD, APPH, "pi_hold", "requires_capture", "user-hold"), // unprovable hold: never in the allow-list
    row(OTHER, APP1, "pi_other", "canceled", U1),                 // owner-only row: not in the allow-list
  ]);
});

test("BF1 dry run: per-row BIND verdicts, nothing written, no ledger", { skip }, async () => {
  const r = await bf.run(deps(), { allowRaw: allow() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { BIND: 2 });
  assert.equal((await get(P1)).applicationBinding, undefined);
  assert.equal(await ledger().countDocuments(), 0);
});

test("BF2 --execute requires --backup and an exact --expect-count", { skip }, async () => {
  assert.equal((await bf.run(deps(), { allowRaw: allow(), execute: true })).reason, "BACKUP_REQUIRED");
  assert.equal((await bf.run(deps(), { allowRaw: allow(), execute: true, backup: tmp("b.json"), expectCount: 3 })).reason, "EXPECT_COUNT_MISMATCH");
  assert.equal((await get(P1)).applicationBinding, undefined);
});

test("BF3 execute binds exactly the allow-listed rows; backup + ledger first; others untouched", { skip }, async () => {
  const backup = tmp("b.json");
  const r = await bf.run(deps(), { allowRaw: allow(), execute: true, backup, expectCount: 2 });
  assert.equal(r.bound, 2);
  assert.equal((await get(P1)).applicationBinding, APP1);
  assert.equal((await get(P2)).applicationBinding, APP2);
  assert.equal(hasAuthoritativeApplicationBinding(await get(P1)), true);
  for (const id of [HOLD, OTHER]) {
    const x = await get(id);
    assert.equal(x.applicationBinding, undefined);
    assert.equal(hasAuthoritativeApplicationBinding(x), false);
  }
  // nothing else changed on the bound rows
  const p1 = await get(P1);
  assert.equal(p1.status, "succeeded");
  assert.equal(p1.purpose, "subscriptionFee");
  const b = JSON.parse(fs.readFileSync(backup, "utf8"));
  assert.equal(b.rows.length, 2);
  assert.equal(b.rows.every((x) => x.applicationBinding === null), true);
  assert.equal(await ledger().countDocuments({ runId: r.runId, op: "bind" }), 2);
  // backup file is never overwritten
  await assert.rejects(() => bf.run(deps(), { allowRaw: allow(), execute: true, backup, expectCount: 2 }), /EEXIST/);
});

test("BF4 changed state is refused per row: status moved, bound to another app, creator differs", { skip }, async () => {
  await Payment.collection.updateOne({ _id: new ObjectId(P1) }, { $set: { status: "canceled" } });
  await Payment.collection.updateOne({ _id: new ObjectId(P2) }, { $set: { applicationBinding: "app-other" } });
  const r = await bf.run(deps(), { allowRaw: allow(), execute: true, backup: tmp("b.json"), expectCount: 2 });
  assert.deepEqual(r.counts, { REFUSED_STATUS_CHANGED: 1, REFUSED_BOUND_OTHER: 1 });
  assert.equal(r.bound, 0);
  assert.equal((await get(P1)).applicationBinding, undefined);
  assert.equal((await get(P2)).applicationBinding, "app-other");
  const wrongCreator = JSON.stringify([entry(P1, APP1, "pi_1", "canceled", "someone-else")]);
  assert.deepEqual((await bf.run(deps(), { allowRaw: wrongCreator })).counts, { REFUSED_CREATOR_CHANGED: 1 });
});

test("BF5 idempotent: a second run binds nothing and reports ALREADY_BOUND_SAME", { skip }, async () => {
  await bf.run(deps(), { allowRaw: allow(), execute: true, backup: tmp("b.json"), expectCount: 2 });
  const r = await bf.run(deps(), { allowRaw: allow(), execute: true, backup: tmp("b2.json"), expectCount: 2 });
  assert.deepEqual(r.counts, { ALREADY_BOUND_SAME: 2 });
  assert.equal(r.bound, 0);
});

test("BF6 a row that changes between plan and update is refused by the conditional filter", { skip }, async () => {
  const origFind = Payment.find.bind(Payment);
  const racing = {
    collection: Payment.collection,
    find: (q) => {
      const chain = origFind(q);
      const lean = chain.lean.bind(chain);
      chain.lean = async () => {
        const rows = await lean();
        await Payment.collection.updateOne({ _id: new ObjectId(P1) }, { $set: { status: "canceled" } }); // concurrent change
        return rows;
      };
      return chain;
    },
  };
  const r = await bf.run({ Payment: racing, ledger: ledger(), ObjectId }, { allowRaw: allow(), execute: true, backup: tmp("b.json"), expectCount: 2 });
  assert.equal(r.bound, 1);
  assert.equal(r.skippedConcurrent, 1);
  assert.equal((await get(P1)).applicationBinding, undefined);
  assert.equal((await ledger().findOne({ runId: r.runId, paymentId: P1 })).outcome, "REFUSED_CHANGED_DURING_RUN");
});

test("BF7 reverse unsets only this run's ledgered bindings that are unchanged", { skip }, async () => {
  const r = await bf.run(deps(), { allowRaw: allow(), execute: true, backup: tmp("b.json"), expectCount: 2 });
  await Payment.collection.updateOne({ _id: new ObjectId(P2) }, { $set: { applicationBinding: "app-rebound" } }); // later change by another path
  assert.equal((await bf.run(deps(), { reverse: true })).reason, "RUN_ID_REQUIRED");
  const dry = await bf.run(deps(), { reverse: true, runId: r.runId });
  assert.equal(dry.toUnset, 1);
  assert.equal((await get(P1)).applicationBinding, APP1);
  const rev = await bf.run(deps(), { reverse: true, runId: r.runId, execute: true, backup: tmp("r.json") });
  assert.equal(rev.unset, 1);
  assert.equal((await get(P1)).applicationBinding, undefined);
  assert.equal((await get(P2)).applicationBinding, "app-rebound");
});

test("BF8 allow-list validation: shape, duplicates, size", () => {
  assert.equal(bf.parseAllowList("nope").error, "ALLOW_LIST_NOT_JSON");
  assert.equal(bf.parseAllowList("[]").error, "ALLOW_LIST_EMPTY");
  assert.equal(bf.parseAllowList(JSON.stringify([{ paymentId: P1 }])).error, "ALLOW_LIST_FIELD_MISSING:tenantId");
  const e = entry(P1, APP1, "pi_1", "succeeded", U1);
  assert.equal(bf.parseAllowList(JSON.stringify([e, e])).error, "ALLOW_LIST_DUPLICATE");
  assert.equal(bf.parseAllowList(JSON.stringify(Array.from({ length: 26 }, (_, i) => entry(oid(i + 1), APP1, "pi", "s", U1)))).error, "ALLOW_LIST_TOO_LARGE");
});

test("ST1 read-only Stripe lookup: retrieve only, allow-listed projection, never client_secret", { skip }, async () => {
  const calls = [];
  const stripe = {
    paymentIntents: {
      retrieve: async (id, opts) => {
        calls.push({ id, opts });
        return { id, status: "requires_capture", amount: 8150, currency: "eur", amount_capturable: 8150, client_secret: "pi_hold_secret_SHOULD_NOT_APPEAR", customer: "cus_x", latest_charge: { payment_method_details: { card: { capture_before: 1793800000, last4: "4242" } } } };
      },
      capture: () => { throw new Error("must not be called"); },
      cancel: () => { throw new Error("must not be called"); },
    },
  };
  const logs = [];
  const r = await st.run({ Payment, stripe }, { listRaw: JSON.stringify([{ tenantId: TA, paymentId: HOLD }]), log: (l) => logs.push(l) });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [{ id: "pi_hold", opts: { expand: ["latest_charge"] } }]);
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ["amount", "amountCapturable", "captureBefore", "currency", "payment", "status"]);
  assert.equal(r.rows[0].captureBefore, new Date(1793800000 * 1000).toISOString());
  assert.equal(JSON.stringify(logs).includes("secret"), false);
  assert.equal(JSON.stringify(logs).includes("4242"), false);
  assert.equal(JSON.stringify(logs).includes("cus_"), false);
  assert.equal((await get(HOLD)).status, "requires_capture"); // nothing written
});
