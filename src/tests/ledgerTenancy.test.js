// Ledger tenancy (Phase 2B-PARALLEL-2, Track B) — Tenant A/B against a REAL MongoDB.
//
// Starts a throwaway `mongod` (temp dbpath, random localhost port) when one is on PATH, or
// uses LEDGER_TEST_MONGO_URI. Skips (does not fail) when neither is available.
//
//   node --test --test-force-exit src/tests/ledgerTenancy.test.js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-ledger-tenancy-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let mongodProc = null;
let mongodDir = null;
async function startMongo() {
  if (process.env.LEDGER_TEST_MONGO_URI) return process.env.LEDGER_TEST_MONGO_URI;
  if (spawnSync("mongod", ["--version"]).status !== 0) return null;
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-ledger-mongod-"));
  const port = await freePort();
  mongodProc = spawn(
    "mongod",
    ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"],
    { stdio: "ignore" },
  );
  return `mongodb://127.0.0.1:${port}/ledger_tenancy_test`;
}

const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });

const { default: GL } = await import("../models/glTransaction.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: CreditNote } = await import("../models/creditNote.model.js");
const { default: ReportSnapshot } = await import("../models/reportSnapshot.model.js");
const { default: ReconciliationRecord } = await import("../models/reconciliationRecord.model.js");
const { default: JournalAdjustment } = await import("../models/journalAdjustment.model.js");
const { default: Balance } = await import("../models/balance.model.js");
const journal = await import("../controllers/journal.controller.js");
const reports = await import("../controllers/reports.controller.js");
const creditNotes = await import("../services/creditNote.service.js");
const recon = await import("../services/reconciliation.service.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");
const { memberOwed1400AllYears } = await import("../helpers/paymentReceiptAllocation.js");
const { glJournalReplicationFeed } = await import("../services/glJournalReplication.service.js");
const { handleSubscriptionCategoryChanged } = await import(
  "../rabbitMQ/listeners/subscription.category.change.listener.js"
);
const { EventTenantMismatchError } = await import("../helpers/eventTenant.js");
const { TENANT_SCOPE_ERROR } = await import("../models/plugins/tenantScoped.plugin.js");

const LEDGER_MODELS = [GL, CoA, MatBal, CreditNote, ReportSnapshot, ReconciliationRecord, JournalAdjustment, Balance];

// Minimal Express-like req/res for controller calls with a TRUSTED tenant in req.ctx.
function reqFor(tenantId, extra = {}) {
  return {
    ctx: { tenantId, userId: `user-${tenantId.slice(0, 1)}` },
    tenantId,
    user: { tenantId, userType: "CRM", permissions: ["*"] },
    headers: {},
    params: {},
    query: {},
    body: {},
    ...extra,
  };
}
function callController(fn, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      success(b) { resolve({ status: 200, body: b }); return this; },
      created(b) { resolve({ status: 201, body: b }); return this; },
    };
    Promise.resolve(fn(req, res, (err) => (err ? reject(err) : resolve({ status: 200 })))).catch(reject);
  });
}

const year = new Date().getFullYear();
const date = `${year}-03-01`;

async function postInvoice(tenantId, docNo, memberId, amount = 10000) {
  return journal.postBalancedJournal({
    date,
    tenantId,
    docType: "Invoice",
    docNo,
    memo: "test invoice",
    lines: [
      { accountCode: "1400", dc: "D", amount, memberId, periodBucket: "current" },
      { accountCode: "4000", dc: "C", amount, revenueSubType: "fee" },
    ],
  });
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of LEDGER_MODELS) await M.syncIndexes();
  await ensureTenantChartOfAccounts(A);
  await ensureTenantChartOfAccounts(B);
});

test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

test("guard: every ledger model rejects unscoped queries, findById, aggregate, bulkWrite and tenant changes", { skip }, async () => {
  const id = new mongoose.Types.ObjectId();
  const blocked = [
    () => GL.find({}),
    () => GL.findOne({ docNo: "X" }),
    () => GL.findById(id),
    () => GL.countDocuments({}),
    () => GL.updateOne({ _id: id }, { $set: { memo: "x" } }),
    () => GL.deleteMany({}),
    () => GL.aggregate([{ $unwind: "$entries" }]),
    () => GL.aggregate([{ $match: { tenantId: { $in: [A, B] } } }]),
    () => MatBal.bulkWrite([{ updateOne: { filter: { memberId: "M1" }, update: { $inc: { amount: 1 } }, upsert: true } }]),
    () => GL.updateOne({ tenantId: A, _id: id }, { $set: { tenantId: B } }),
    () => CoA.find({ tenantId: null }),
    () => ReportSnapshot.findOne({ type: "month-end", label: "2026-01" }),
  ];
  for (const fn of blocked) {
    await assert.rejects(fn, (e) => e.code === TENANT_SCOPE_ERROR, String(fn));
  }
  await assert.rejects(
    () => GL.create({ date, docType: "Invoice", docNo: "NO-TENANT", entries: [{ accountCode: "1", dc: "D", amount: 1 }, { accountCode: "2", dc: "C", amount: 1 }] }),
    /tenantId/,
  );
});

test("Tenant A posts a journal; rows and balances carry tenant A only", { skip }, async () => {
  await postInvoice(A, "INV-1", "M-A1", 10000);
  const glA = await GL.find({ tenantId: A, docNo: "INV-1" }).lean();
  assert.strictEqual(glA.length, 1);
  const balA = await MatBal.find({ tenantId: A, memberId: "M-A1" }).lean();
  assert.strictEqual(balA.length, 1);
  assert.strictEqual(balA[0].amount, 10000);
  assert.strictEqual(await MatBal.countDocuments({ tenantId: B }), 0);
  const owedA = await memberOwed1400AllYears("M-A1", { tenantId: A });
  assert.strictEqual(owedA.current, 10000);
});

test("Tenant B cannot read A's journal, balances or general ledger", { skip }, async () => {
  const listB = await callController(journal.listJournals, reqFor(B));
  assert.strictEqual(listB.body.total, 0);
  const listA = await callController(journal.listJournals, reqFor(A));
  assert.ok(listA.body.total >= 1);

  const owedB = await memberOwed1400AllYears("M-A1", { tenantId: B });
  assert.deepStrictEqual(owedB, { arrears: 0, current: 0 });

  const netB = await callController(reports.memberNetBalance, reqFor(B, { params: { memberId: "M-A1" } }));
  assert.strictEqual(netB.body.net, 0);
  const netA = await callController(reports.memberNetBalance, reqFor(A, { params: { memberId: "M-A1" } }));
  assert.strictEqual(netA.body.net, 10000);

  const stmtB = await callController(reports.memberStatement, reqFor(B, { params: { memberId: "M-A1" } }));
  const stmtBody = JSON.stringify(stmtB.body || {});
  assert.ok(!stmtBody.includes("INV-1"), "B's statement must not contain A's invoice");
});

test("Tenant B cannot update or delete A's rows", { skip }, async () => {
  const a = await GL.findOne({ tenantId: A, docNo: "INV-1" }).lean();
  const upd = await GL.updateOne({ _id: a._id, tenantId: B }, { $set: { memo: "hijack" } });
  assert.strictEqual(upd.matchedCount, 0);
  const del = await GL.deleteOne({ _id: a._id, tenantId: B });
  assert.strictEqual(del.deletedCount, 0);
  assert.strictEqual((await GL.findOne({ _id: a._id, tenantId: A }).lean()).memo, "test invoice");

  // Credit note drafted by A cannot be approved/cancelled/read by B.
  await creditNotes.createCreditNoteDraft({
    tenantId: A, docNo: "CN-1", memberId: "M-A1", invoiceDocNo: "INV-1", amount: 1000,
    reason: "test", effectiveDate: date, createdBy: "u",
  });
  await assert.rejects(() => creditNotes.approveCreditNote({ tenantId: B, docNo: "CN-1", approvedBy: "u" }), /not found/);
  await assert.rejects(() => creditNotes.cancelCreditNote({ tenantId: B, docNo: "CN-1", cancelledBy: "u" }), /not found/);
  await assert.rejects(() => creditNotes.getCreditNote("CN-1", B), /not found/);
  // B cannot draft a credit note against A's invoice either.
  await assert.rejects(
    () => creditNotes.createCreditNoteDraft({
      tenantId: B, docNo: "CN-B", memberId: "M-A1", invoiceDocNo: "INV-1", amount: 100,
      reason: "x", effectiveDate: date, createdBy: "u",
    }),
    /not found/,
  );
  assert.strictEqual((await CreditNote.findOne({ tenantId: A, docNo: "CN-1" }).lean()).status, "Draft");

  // Reconciliation record of A is invisible to B.
  const { records } = await recon.importBankReconciliationLines({
    tenantId: A, clearingAccountCode: "1220", lines: [{ externalReference: "PO-1", amount: 500 }], createdBy: "u",
  });
  await assert.rejects(() => recon.markReconciliationSettled({ recordId: records[0]._id, tenantId: B, actorId: "u" }), /not found/);
  await assert.rejects(() => recon.moveToSuspense({ recordId: records[0]._id, tenantId: B, suspenseReason: "x", matchedBy: "u" }), /not found/);
  const listB = await recon.listReconciliationRecords({ tenantId: B });
  assert.strictEqual(listB.total, 0);
});

test("month-end snapshots are per tenant; B never receives A's locked snapshot", { skip }, async () => {
  const period = `${year}-03`;
  const snapA = await callController(reports.monthEnd, reqFor(A, { query: { period, lock: "1" } }));
  const snapB = await callController(reports.monthEnd, reqFor(B, { query: { period, lock: "1" } }));
  assert.strictEqual(await ReportSnapshot.countDocuments({ tenantId: A }), 1);
  assert.strictEqual(await ReportSnapshot.countDocuments({ tenantId: B }), 1);
  assert.notStrictEqual(String(snapA.body._id), String(snapB.body._id));
  assert.ok(JSON.stringify(snapA.body.data).includes("M-A1"));
  assert.ok(!JSON.stringify(snapB.body.data).includes("M-A1"));
  const tbB = snapB.body.data.trialBalance;
  assert.ok(tbB.every((r) => !r.debit && !r.credit), "B's trial balance must be empty");
});

test("docNo is unique per tenant: B may reuse A's docNo without touching A's posting", { skip }, async () => {
  const b = await postInvoice(B, "INV-1", "M-B1", 2500);
  assert.strictEqual(b.tenantId, B);
  const a = await GL.findOne({ tenantId: A, docNo: "INV-1" }).lean();
  assert.strictEqual(a.entries[0].amount, 10000);
  // Idempotency stays inside the tenant: re-posting A's docNo returns A's row, not B's.
  const again = await postInvoice(A, "INV-1", "M-A1", 99999);
  assert.strictEqual(String(again._id), String(a._id));
  assert.strictEqual(await GL.countDocuments({ tenantId: A, docNo: "INV-1" }), 1);
  // Same docNo twice in one tenant is still rejected by the index.
  await assert.rejects(
    () => GL.create({ tenantId: B, date, docType: "Invoice", docNo: "INV-1", entries: [{ accountCode: "1400", dc: "D", amount: 1 }, { accountCode: "4000", dc: "C", amount: 1 }] }),
    /E11000/,
  );
});

test("trusted tenant wins over body/query/header tenant", { skip }, async () => {
  const req = reqFor(B, {
    body: { date, docNo: "RCP-OVR", memberId: "M-B1", amount: 700, clearingCode: "1210", tenantId: A },
    query: { tenantId: A },
    headers: { "x-tenant-id": A },
  });
  await callController(journal.receipt, req);
  assert.strictEqual(await GL.countDocuments({ tenantId: A, docNo: "RCP-OVR" }), 0);
  assert.strictEqual(await GL.countDocuments({ tenantId: B, docNo: "RCP-OVR" }), 1);

  const listReq = reqFor(B, { query: { tenantId: A, docType: "Invoice" }, headers: { "x-tenant-id": A } });
  const list = await callController(journal.listJournals, listReq);
  assert.ok(list.body.items.every((t) => t.tenantId === B));
});

test("a tenant without a provisioned chart cannot post (fail closed); provisioning is idempotent", { skip }, async () => {
  const C = "cccccccccccccccccccccccc";
  await assert.rejects(() => postInvoice(C, "INV-C", "M-C1"), /Unknown account/);
  const first = await ensureTenantChartOfAccounts(C);
  const second = await ensureTenantChartOfAccounts(C);
  assert.ok(first.inserted > 0);
  assert.strictEqual(second.inserted, 0);
  assert.strictEqual(await CoA.countDocuments({ tenantId: C }), first.inserted);
});

test("GL replication feed returns only the caller tenant's lines", { skip }, async () => {
  const out = await callController(glJournalReplicationFeed, reqFor(B, { body: { limit: 500 } }));
  assert.ok(out.body.lines.length >= 1, "B's own lines are returned");
  assert.ok(out.body.lines.every((l) => l.tenant_id === B));
  assert.ok(!JSON.stringify(out.body.lines).includes("M-A1"), "no A member lines in B's feed");
});

test("no trusted tenant -> 401 on ledger controllers", { skip }, async () => {
  const req = { ctx: {}, headers: { "x-tenant-id": A }, query: {}, params: {}, body: {} };
  await assert.rejects(() => callController(journal.listJournals, req), (e) => e.status === 401 || e.statusCode === 401);
});

test("ledger event consumer quarantines an envelope/data tenant mismatch", async () => {
  await assert.rejects(
    () => handleSubscriptionCategoryChanged({ tenantId: A, eventId: "e1", data: { tenantId: B, subscriptionId: "s1" } }),
    (e) => e instanceof EventTenantMismatchError,
  );
});
