// P5 write-off replay protection (owner gate for activating #17): a write-off docNo is the
// posting idempotency key, unique per tenant (glTransaction.model.js (tenantId, docNo) index).
//   - same docNo + same content  -> 200 "Already posted", the original posting, nothing new;
//   - same docNo + different amount / member / bucket -> 409 JOURNAL_REPLAY_CONFLICT;
//   - concurrent identical and differing requests -> exactly ONE posting, one rollup, and every
//     loser answered as a replay (200) or a conflict (409), never a 500 and never a 2nd posting.
// Drives the real handlers (internal POST /api/internal/members/writeoff and CRM
// POST /api/journal/writeoff) against a real throwaway mongod (as memberInvoiceIdempotency).
//   node --test --test-force-exit src/tests/writeoffReplay.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-wo-replay-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_wo_replay";

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-wo-replay-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/writeoff_replay_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
const published = [];
publisher.publish = async (...args) => { published.push(args); return { success: true, eventId: "test" }; };
const { internalWriteOff } = await import("../controllers/internal.reminderEligibility.controller.js");
const { writeOff } = await import("../controllers/journal.controller.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: CoA } = await import("../models/coa.model.js");

// Minimal res with the response.mw helpers the handlers use.
function call(handler, tenantId, body) {
  return new Promise((resolve) => {
    const res = {
      success: (data) => resolve({ status: 200, data }),
      created: (data) => resolve({ status: 201, data }),
      status: (s) => ({ json: (data) => resolve({ status: s, data }) }),
    };
    const req = { body, ctx: { tenantId, userId: "svc-test" }, tenantId, headers: {} };
    const next = (err) => resolve({ status: err?.status || 500, code: err?.code, err });
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}
const internal = (tenantId, body) => call(internalWriteOff, tenantId, body);
const crm = (tenantId, body) => call(writeOff, tenantId, body);
const wo = (docNo, amount, extra = {}) => ({ date: "2026-12-31", docNo, memberId: "M-1", amount, periodBucket: "arrears", ...extra });
const postings = (tenantId, docNo) => GL.countDocuments({ tenantId, docNo });

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of [GL, MatBal, CoA]) await M.syncIndexes();
  for (const t of [A, B]) await ensureTenantChartOfAccounts(t);
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

test("0 the (tenantId, docNo) unique index the guarantee relies on is in place", { skip }, async () => {
  const idx = await GL.collection.indexes();
  assert.ok(idx.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ tenantId: 1, docNo: 1 })));
});

test("1 first internal write-off posts once (201)", { skip }, async () => {
  const r = await internal(A, wo("WO-1-ARREARS", 25.5));
  assert.equal(r.status, 201);
  assert.equal(await postings(A, "WO-1-ARREARS"), 1);
});

test("2 same docNo + same content -> 200 Already posted, the original posting, nothing new", { skip }, async () => {
  const before = published.length;
  const r = await internal(A, wo("WO-1-ARREARS", 25.5, { memo: "retry", date: "2027-01-02" }));
  assert.equal(r.status, 200);
  assert.equal(r.data.docNo, "WO-1-ARREARS");
  assert.equal(await postings(A, "WO-1-ARREARS"), 1);
  assert.equal(published.length, before, "no second journal event");
});

test("3 same docNo + different amount -> 409 JOURNAL_REPLAY_CONFLICT, nothing written", { skip }, async () => {
  const r = await internal(A, wo("WO-1-ARREARS", 99));
  assert.equal(r.status, 409);
  assert.equal(r.code, "JOURNAL_REPLAY_CONFLICT");
  const doc = await GL.findOne({ tenantId: A, docNo: "WO-1-ARREARS" }).lean();
  assert.deepEqual(doc.entries.map((e) => e.amount), [25.5, 25.5]);
});

test("4 same docNo + different member or bucket -> 409", { skip }, async () => {
  assert.equal((await internal(A, wo("WO-1-ARREARS", 25.5, { memberId: "M-2" }))).status, 409);
  assert.equal((await internal(A, wo("WO-1-ARREARS", 25.5, { periodBucket: "current" }))).status, 409);
  assert.equal(await postings(A, "WO-1-ARREARS"), 1);
});

test("5 the CRM /journal/writeoff route has the same replay contract", { skip }, async () => {
  assert.equal((await crm(A, wo("WO-CRM-1", 10, { periodBucket: "current" }))).status, 201);
  assert.equal((await crm(A, wo("WO-CRM-1", 10, { periodBucket: "current" }))).status, 200);
  assert.equal((await crm(A, wo("WO-CRM-1", 11, { periodBucket: "current" }))).status, 409);
  assert.equal(await postings(A, "WO-CRM-1"), 1);
});

test("6 concurrent identical requests -> exactly one posting, one journal event, all others 200", { skip }, async () => {
  const before = published.length;
  const rows = await Promise.all(Array.from({ length: 12 }, () => internal(A, wo("WO-RACE-1", 40))));
  const statuses = rows.map((r) => r.status).sort();
  assert.equal(await postings(A, "WO-RACE-1"), 1);
  assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses ${statuses}`);
  assert.equal(statuses.filter((s) => s === 200).length, 11, `statuses ${statuses}`);
  assert.equal(published.length - before, 1, "exactly one journal.created event");
});

test("7 concurrent identical + differing amounts -> one posting; losers 200 (same) or 409 (different), never 500", { skip }, async () => {
  const bodies = [40, 40, 41, 40, 99, 40, 41, 40, 12.34, 40].map((amt) => wo("WO-RACE-2", amt));
  const rows = await Promise.all(bodies.map((b) => internal(A, b)));
  assert.equal(await postings(A, "WO-RACE-2"), 1);
  const winner = await GL.findOne({ tenantId: A, docNo: "WO-RACE-2" }).lean();
  const winAmt = winner.entries[0].amount;
  rows.forEach((r, i) => {
    assert.notEqual(r.status, 500, `request ${i} got 500`);
    if (bodies[i].amount === winAmt) assert.ok([200, 201].includes(r.status), `same-content request ${i} -> ${r.status}`);
    else assert.equal(r.status, 409, `different-content request ${i} -> ${r.status}`);
  });
  assert.equal(rows.filter((r) => r.status === 201).length, 1);
});

test("8 the materialized rollup is applied once despite concurrent duplicates", { skip }, async () => {
  const docs = await Promise.all(Array.from({ length: 6 }, () => internal(A, wo("WO-RACE-3", 7, { memberId: "M-ROLL" }))));
  assert.equal(docs.filter((r) => r.status === 201).length, 1);
  const bal = await MatBal.find({ tenantId: A, memberId: "M-ROLL", accountCode: "1400" }).lean();
  assert.equal(bal.length, 1);
  assert.equal(bal[0].bucket, "arrears");
  assert.equal(bal[0].amount, -7, "one 7.00 credit to 1400, not six");
});

test("9 the same docNo in another tenant is an independent posting", { skip }, async () => {
  assert.equal((await internal(B, wo("WO-1-ARREARS", 99))).status, 201);
  assert.equal(await postings(B, "WO-1-ARREARS"), 1);
  assert.equal(await postings(A, "WO-1-ARREARS"), 1);
});
