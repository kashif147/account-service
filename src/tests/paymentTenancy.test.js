// Phase 2C Track A: payments are tenant-isolated and fail closed.
//  - every HTTP-facing payments function requires the trusted tenant (req.ctx); a missing
//    tenant is 401, never a global query;
//  - Stripe metadata is never a tenant authority: the PERSISTED payment decides; an unknown
//    PaymentIntent is not upserted, a metadata/caller tenant that disagrees with the record
//    is rejected, and metadata cannot re-point a payment's application/member.
// Real throwaway mongod (as paymentContract.test.js); skips without one.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-pay-tenancy-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_pay_tenancy";

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-pay-tenancy-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_tenancy_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const payments = await import("../services/payments.service.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Refund } = await import("../models/refund.model.js");

let payA, payB;
const succeeded = (pi, metadata = {}) => ({
  eventId: `evt_${pi}_${Math.random().toString(36).slice(2, 8)}`,
  type: "payment_intent.succeeded",
  payment: { paymentIntentId: pi, amount: 5000, currency: "eur", status: "succeeded", metadata },
});
const rejectsWith = (p, status) => assert.rejects(p, (e) => e.status === status || e.statusCode === status);

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of [GL, MatBal, CoA, Payment, Refund]) await M.syncIndexes();
  await ensureTenantChartOfAccounts(A);
  await ensureTenantChartOfAccounts(B);
  payA = await Payment.create({ tenantId: A, purpose: "subscriptionFee", amount: 5000, currency: "eur", mode: "stripe", status: "requires_action", memberId: "M-A", stripe: { paymentIntentId: "pi_A" } });
  payB = await Payment.create({ tenantId: B, purpose: "subscriptionFee", amount: 7000, currency: "eur", mode: "stripe", status: "requires_action", memberId: "M-B", applicationId: undefined, stripe: { paymentIntentId: "pi_B" } });
  await Payment.create({ tenantId: B, purpose: "subscriptionFee", amount: 7000, currency: "eur", mode: "stripe", status: "requires_action", applicationId: "app-B", stripe: { paymentIntentId: "pi_B_app" } });
  await Payment.create({ tenantId: A, purpose: "subscriptionFee", amount: 6000, currency: "eur", mode: "stripe", status: "requires_action", applicationId: "app-A", stripe: { paymentIntentId: "pi_A_app" } });
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// ---------------- missing trusted tenant: fail closed (401), never global ----------------
test("1 missing trusted tenant fails closed on every HTTP-facing payments function", { skip }, async () => {
  await rejectsWith(payments.findByStripePaymentIntent("pi_A", {}), 401);
  await rejectsWith(payments.findLatestApplicationPayment("app-A", {}), 401);
  await rejectsWith(payments.cancelPaymentIntent("pi_A", {}), 401);
  await rejectsWith(payments.capturePaymentIntent("pi_A", {}), 401);
  await rejectsWith(payments.listRefunds({}, {}), 401);
  await rejectsWith(payments.listByMemberIds(["M-A"], {}), 401);
  await rejectsWith(payments.createRefund({ mode: "external", paymentId: String(payA._id), amount: 100 }, {}), 401);
  await rejectsWith(payments.createIntent({ amount: 100, currency: "eur", purpose: "subscriptionFee" }, {}), 401);
  assert.equal(await Refund.countDocuments({}), 0, "nothing written");
});

// ---------------- read isolation / foreign identifiers ----------------
test("2 tenant A cannot read tenant B's payments by intent, application or member id", { skip }, async () => {
  assert.equal(await payments.findByStripePaymentIntent("pi_B", { tenantId: A }), null);
  assert.equal(await payments.findLatestApplicationPayment("app-B", { tenantId: A }), null);
  assert.deepEqual(await payments.listByMemberIds(["M-B"], { tenantId: A }), []);
  assert.ok(await payments.findByStripePaymentIntent("pi_B", { tenantId: B }), "B still reads its own");
});

// ---------------- write / refund isolation ----------------
test("3 tenant A cannot refund or cancel tenant B's payment", { skip }, async () => {
  await assert.rejects(payments.createRefund({ mode: "external", paymentId: String(payB._id), amount: 100 }, { tenantId: A }));
  await rejectsWith(payments.cancelPaymentIntent("pi_B", { tenantId: A }), 404);
  assert.equal(await Refund.countDocuments({}), 0);
  assert.equal((await Payment.findById(payB._id).lean()).status, "requires_action");
});

// ---------------- reconcile (HTTP, tenant-scoped) ----------------
test("4 HTTP reconcile of a foreign PaymentIntent is not found", { skip }, async () => {
  const deps = { retrievePaymentIntent: async () => ({ id: "pi_B", status: "succeeded", amount: 7000, currency: "eur", metadata: { tenantId: B } }) };
  await rejectsWith(payments.reconcilePaymentFromStripe({ paymentIntentId: "pi_B" }, { tenantId: A }, deps), 404);
  await rejectsWith(payments.reconcilePaymentFromStripe({ paymentIntentId: "pi_B" }, {}, deps), 401);
});

// ---------------- webhook: metadata is not a tenant authority ----------------
test("5 webhook whose metadata names another tenant is rejected and changes nothing", { skip }, async () => {
  const r = await payments.reconcileStripeEvent(succeeded("pi_A", { tenantId: B }), { metadataTenantId: B });
  assert.deepEqual(r, { ok: false, rejected: "tenant_mismatch" });
  const p = await Payment.findById(payA._id).lean();
  assert.equal(p.status, "requires_action");
  assert.equal(p.tenantId, A, "payment did not move tenant");
});

test("6 webhook for an unknown PaymentIntent does not create a payment in the metadata tenant", { skip }, async () => {
  const before = await Payment.countDocuments({});
  const r = await payments.reconcileStripeEvent(succeeded("pi_unknown", { tenantId: A }), { metadataTenantId: A });
  assert.deepEqual(r, { ok: false, rejected: "unknown_payment_intent" });
  assert.equal(await Payment.countDocuments({}), before);
});

test("7 a caller tenant that disagrees with the persisted payment is rejected", { skip }, async () => {
  const r = await payments.reconcileStripeEvent(succeeded("pi_B"), { tenantId: A });
  assert.deepEqual(r, { ok: false, rejected: "tenant_mismatch" });
  assert.equal((await Payment.findById(payB._id).lean()).status, "requires_action");
});

test("8 metadata cannot re-point a payment at another application", { skip }, async () => {
  await payments.reconcileStripeEvent(succeeded("pi_A_app", { tenantId: A, applicationId: "app-EVIL" }), { metadataTenantId: A });
  const p = await Payment.findOne({ tenantId: A, "stripe.paymentIntentId": "pi_A_app" }).lean();
  assert.equal(p.applicationId, "app-A");
  assert.equal(p.status, "succeeded");
});

test("9 a valid webhook (matching metadata) still reconciles in the payment's own tenant", { skip }, async () => {
  const r = await payments.reconcileStripeEvent(succeeded("pi_A", { tenantId: A, memberId: "M-A" }), { metadataTenantId: A });
  assert.notEqual(r?.rejected, "tenant_mismatch");
  const p = await Payment.findById(payA._id).lean();
  assert.equal(p.status, "succeeded");
  assert.equal(p.tenantId, A);
  assert.ok(await GL.findOne({ tenantId: A, docNo: `RCP-${payA._id}` }).lean(), "receipt posted in tenant A");
  assert.equal(await GL.countDocuments({ tenantId: B, docNo: `RCP-${payA._id}` }), 0);
});

test("10 webhook without any metadata tenant reconciles from the persisted record alone", { skip }, async () => {
  const r = await payments.reconcileStripeEvent(succeeded("pi_B", {}), {});
  assert.notEqual(r?.rejected, "tenant_mismatch");
  const p = await Payment.findById(payB._id).lean();
  assert.equal(p.status, "succeeded");
  assert.equal(p.tenantId, B);
});
