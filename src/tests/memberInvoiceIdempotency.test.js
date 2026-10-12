// Phase 2B: handleMemberCreated must post at most ONE membership invoice per tenant +
// application, whatever calendar year a (re)delivered members.subscription.current.updated.v1
// is processed in. The invoice docNo embeds the posting year (INV-<year>-<applicationId>), so
// an exact-docNo pre-check alone lets a later-year replay post a second invoice.
// Real throwaway mongod (as paymentContract.test.js); skips without one.
import test, { mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-inv-idem-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_inv_idem";

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ANNUAL = 32600;

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-inv-idem-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/member_invoice_idempotency_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { handleMemberCreated } = await import("../handlers/application.approval.listener.js");
const payments = await import("../services/payments.service.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Product } = await import("../models/product.model.js");
const { default: Pricing } = await import("../models/pricing.model.js");

const year = new Date().getFullYear();
const event = (tenantId, applicationId, memberId, eventId = `evt-${tenantId}-${applicationId}`) => ({
  eventId,
  tenantId,
  data: {
    applicationId, memberId, subscriptionId: `sub-${applicationId}`, profileId: `prof-${applicationId}`,
    effective: { subscriptionDetails: { membershipCategory: "General All Grades" } },
    subscriptionAttributes: { startDate: `${year}-01-01` },
  },
});
const invoicesFor = (tenantId, applicationId) =>
  GL.countDocuments({ tenantId, docType: "Invoice", docNo: { $regex: `^INV-\\d{4}-${applicationId}$` } });
const claimsFor = (tenantId, applicationId) => GL.countDocuments({ tenantId, docNo: `CLAIM-${applicationId}` });

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of [GL, MatBal, CoA, Payment]) await M.syncIndexes();
  for (const t of [A, B]) {
    await ensureTenantChartOfAccounts(t);
    await Product.collection.insertOne({ _id: `prod-gag-${t}`, tenantId: t, code: "GAG", name: "General All Grades", isDeleted: false, isActive: true });
    await Pricing.collection.insertOne({ tenantId: t, productId: `prod-gag-${t}`, price: ANNUAL, isDeleted: false, isActive: true, effectiveFrom: new Date("2020-01-01"), effectiveTo: null });
  }
  // app-paid (tenant A) paid its application fee: the member-created event must claim that credit.
  const payment = await Payment.create({
    tenantId: A, purpose: "subscriptionFee", amount: ANNUAL, currency: "eur", mode: "stripe",
    status: "succeeded", applicationId: "app-paid", stripe: { paymentIntentId: "pi_app_paid" },
  });
  await payments.postJournalForPayment(payment.toObject(), { tenantId: A });
});
test.after(async () => {
  mock.timers.reset();
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

test("1 first member-created event posts exactly one invoice", { skip }, async () => {
  await handleMemberCreated(event(A, "app-1", "M-1"));
  assert.equal(await invoicesFor(A, "app-1"), 1);
});

test("2 replay of the same event in the same year posts no second invoice", { skip }, async () => {
  await handleMemberCreated(event(A, "app-1", "M-1"));
  assert.equal(await invoicesFor(A, "app-1"), 1);
});

test("3 replay of the same event in a later year posts no second invoice", { skip }, async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(`${year + 1}-01-15T10:00:00Z`) });
  try {
    await handleMemberCreated(event(A, "app-1", "M-1"));
  } finally {
    mock.timers.reset();
  }
  assert.equal(await invoicesFor(A, "app-1"), 1, "a later-year replay must not post INV-<year+1>-app-1");
});

test("4 another tenant with the same applicationId gets its own single invoice", { skip }, async () => {
  await handleMemberCreated(event(B, "app-1", "M-B1"));
  assert.equal(await invoicesFor(B, "app-1"), 1);
  assert.equal(await invoicesFor(A, "app-1"), 1, "tenant A unaffected");
});

test("5 the application credit claim stays unique across replays (incl. a later year)", { skip }, async () => {
  await handleMemberCreated(event(A, "app-paid", "M-P"));
  await handleMemberCreated(event(A, "app-paid", "M-P"));
  mock.timers.enable({ apis: ["Date"], now: new Date(`${year + 1}-02-01T10:00:00Z`) });
  try {
    await handleMemberCreated(event(A, "app-paid", "M-P"));
  } finally {
    mock.timers.reset();
  }
  assert.equal(await claimsFor(A, "app-paid"), 1);
  assert.equal(await invoicesFor(A, "app-paid"), 1);
});

test("6 concurrent duplicate delivery posts one invoice", { skip }, async () => {
  await Promise.all([1, 2, 3].map(() => handleMemberCreated(event(A, "app-race", "M-R"))));
  assert.equal(await invoicesFor(A, "app-race"), 1);
});

test("7 a sibling application whose id extends this one is not mistaken for it, and PRORATA is not an invoice match", { skip }, async () => {
  // app-1's invoice (and its INV-<y>-app-1-PRORATA adjustment) must not satisfy app-10's check.
  await handleMemberCreated(event(A, "app-10", "M-10"));
  assert.equal(await invoicesFor(A, "app-10"), 1);
  assert.equal(await invoicesFor(A, "app-1"), 1);
});

test("8 regex metacharacters in an application id are matched literally", { skip }, async () => {
  await handleMemberCreated(event(A, "app.x+(1)", "M-X"));
  await handleMemberCreated(event(A, "app.x+(1)", "M-X"));
  assert.equal(await GL.countDocuments({ tenantId: A, docType: "Invoice", docNo: { $regex: "^INV-\\d{4}-app\\.x\\+\\(1\\)$" } }), 1);
  assert.equal(await GL.countDocuments({ tenantId: A, docType: "Invoice", docNo: { $regex: "^INV-\\d{4}-appXx" } }), 0);
});
