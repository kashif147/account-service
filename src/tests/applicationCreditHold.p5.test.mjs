// P5 application credit hold (owner policy): an application approved onto an EXISTING profile
// whose 2020 application credit was not transferred by CLAIM-<applicationId> is HELD pending
// finance review - recorded as a marker only (no journal, no invoice, no transfer, no refund).
// Real throwaway mongod (as memberInvoiceIdempotency.test.js); skips without one.
//
//   npm run test:node -- src/tests/applicationCreditHold.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-hold-"));
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.JWT_SECRET = "p5-application-credit-hold-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_hold";
delete process.env.AUTH_BYPASS_ENABLED;

const SECRET = process.env.JWT_SECRET;
const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ANNUAL = 32600;
const FEE = 3100;

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-hold-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/application_credit_hold_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });
const { handleApplicationApproved, handleMemberCreated } = await import("../handlers/application.approval.listener.js");
const payments = await import("../services/payments.service.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Product } = await import("../models/product.model.js");
const { default: Pricing } = await import("../models/pricing.model.js");
const { default: Hold, HOLD_STATUS } = await import("../models/applicationCreditHold.model.js");
const { default: app } = await import("../app.js");

const year = new Date().getFullYear();
// applications.review.processed.v1 as profile-service publishes it (envelope + data tenant).
const processed = (tenantId, applicationId, memberId, isExistingProfile, { dataTenantId = tenantId, eventId } = {}) => ({
  eventId: eventId || `proc-${tenantId}-${applicationId}`,
  tenantId,
  data: {
    applicationId, profileId: `prof-${applicationId}`, memberId, isExistingProfile, tenantId: dataTenantId,
    effective: { subscriptionDetails: { membershipCategory: "General All Grades" } },
  },
});
// members.subscription.current.updated.v1 (envelope tenant only).
const currentUpdated = (tenantId, applicationId, memberId) => ({
  eventId: `cur-${tenantId}-${applicationId}`,
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
const holdsFor = (tenantId, applicationId) => Hold.find({ tenantId, applicationId }).lean();

async function paidApplication(tenantId, applicationId, amount = FEE) {
  const payment = await Payment.create({
    tenantId, purpose: "subscriptionFee", amount, currency: "eur", mode: "stripe",
    status: "succeeded", applicationId, applicationBinding: applicationId,
    stripe: { paymentIntentId: `pi_${tenantId.slice(0, 4)}_${applicationId}` },
  });
  await payments.postJournalForPayment(payment.toObject(), { tenantId });
}

const bearer = ({ userType, id, tenantId = A, permissions = [], roles = [] }) =>
  `Bearer ${jwt.sign({ id, sub: id, tenantId, userType, roles, permissions }, SECRET, { expiresIn: "10m" })}`;

async function get(url, auth) {
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  try {
    const headers = {};
    if (auth) headers.authorization = auth;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, data: json?.data ?? null, code: json?.code ?? json?.error?.code ?? null };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (skip) return;
  for (let i = 0; i < 50; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500, autoIndex: false }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await mongoose.connection.db.dropDatabase();
  for (const M of [GL, MatBal, CoA, Payment, Hold]) await M.syncIndexes();
  for (const t of [A, B]) {
    await ensureTenantChartOfAccounts(t);
    await Product.collection.insertOne({ _id: `prod-gag-${t}`, tenantId: t, code: "GAG", name: "General All Grades", isDeleted: false, isActive: true });
    await Pricing.collection.insertOne({ tenantId: t, productId: `prod-gag-${t}`, price: ANNUAL, isDeleted: false, isActive: true, effectiveFrom: new Date("2020-01-01"), effectiveTo: null });
  }
  await paidApplication(A, "app-link");
  await paidApplication(A, "app-new", ANNUAL);
  await paidApplication(A, "app-return");
  await paidApplication(A, "app-claimfirst", ANNUAL);
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

test("1 existing-profile LINK with unallocated credit (live subscription, no current.updated): hold recorded, no CLAIM, no invoice", { skip }, async () => {
  const glBefore = await GL.countDocuments({ tenantId: A });
  await handleApplicationApproved(processed(A, "app-link", "B-LINK", true));
  const holds = await holdsFor(A, "app-link");
  assert.equal(holds.length, 1);
  assert.equal(holds[0].status, HOLD_STATUS.PENDING);
  assert.equal(holds[0].reasonCode, "EXISTING_PROFILE_APPROVAL_CREDIT_UNALLOCATED");
  assert.equal(holds[0].amountCentsAtDetection, FEE);
  assert.equal(holds[0].memberId, "B-LINK");
  assert.equal(await claimsFor(A, "app-link"), 0);
  assert.equal(await invoicesFor(A, "app-link"), 0);
  assert.equal(await GL.countDocuments({ tenantId: A }), glBefore, "no journal of any kind is posted");
});

test("2 redelivery of the processed event is idempotent (one row, unchanged)", { skip }, async () => {
  const [before] = await holdsFor(A, "app-link");
  const glBefore = await GL.countDocuments({ tenantId: A });
  await handleApplicationApproved(processed(A, "app-link", "B-LINK", true));
  await handleApplicationApproved(processed(A, "app-link", "B-LINK", true, { eventId: "proc-redelivered" }));
  const holds = await holdsFor(A, "app-link");
  assert.equal(holds.length, 1);
  assert.equal(String(holds[0].detectedAt), String(before.detectedAt));
  assert.equal(holds[0].sourceEventId, before.sourceEventId);
  assert.equal(await GL.countDocuments({ tenantId: A }), glBefore);
});

test("3 new-profile path unchanged: no hold, current.updated posts invoice + CLAIM as before", { skip }, async () => {
  await handleApplicationApproved(processed(A, "app-new", "M-NEW", false));
  assert.equal((await holdsFor(A, "app-new")).length, 0);
  await handleMemberCreated(currentUpdated(A, "app-new", "M-NEW"));
  assert.equal(await invoicesFor(A, "app-new"), 1);
  assert.equal(await claimsFor(A, "app-new"), 1);
  assert.equal((await holdsFor(A, "app-new")).length, 0);
});

test("4 existing-profile LINK with no application credit: no hold", { skip }, async () => {
  await handleApplicationApproved(processed(A, "app-nocredit", "B-X", true));
  assert.equal((await holdsFor(A, "app-nocredit")).length, 0);
  assert.equal(await claimsFor(A, "app-nocredit"), 0);
});

test("5 existing profile WITHOUT a live subscription: the later CLAIM (normal flow) releases the hold", { skip }, async () => {
  await handleApplicationApproved(processed(A, "app-return", "B-RET", true));
  assert.equal((await holdsFor(A, "app-return"))[0].status, HOLD_STATUS.PENDING);
  await handleMemberCreated(currentUpdated(A, "app-return", "B-RET"));
  assert.equal(await claimsFor(A, "app-return"), 1);
  const [h] = await holdsFor(A, "app-return");
  assert.equal(h.status, HOLD_STATUS.RELEASED_BY_CLAIM);
  assert.equal(h.releasedClaimDocNo, "CLAIM-app-return");
});

test("6 CLAIM already posted before the processed event arrives: no hold", { skip }, async () => {
  await handleMemberCreated(currentUpdated(A, "app-claimfirst", "B-CF"));
  assert.equal(await claimsFor(A, "app-claimfirst"), 1);
  await handleApplicationApproved(processed(A, "app-claimfirst", "B-CF", true));
  assert.equal((await holdsFor(A, "app-claimfirst")).length, 0);
});

test("7 tenant scoping: another tenant's credit is never seen; a tenant mismatch records nothing", { skip }, async () => {
  // Tenant B, same applicationId as A's held one, but B has no credit for it.
  await handleApplicationApproved(processed(B, "app-link", "B-LINK", true));
  assert.equal((await holdsFor(B, "app-link")).length, 0);
  // Envelope A, data B: quarantined (throws to the consumer), no hold anywhere.
  await assert.rejects(
    () => handleApplicationApproved(processed(A, "app-mismatch", "B-M", true, { dataTenantId: B })),
    (e) => e.code === "EVENT_TENANT_MISMATCH",
  );
  assert.equal(await Hold.countDocuments({ tenantId: A, applicationId: "app-mismatch" }), 0);
  assert.equal(await Hold.countDocuments({ tenantId: B, applicationId: "app-mismatch" }), 0);
});

test("8 listing is CRM finance read only and tenant-scoped", { skip }, async () => {
  const url = "/api/finance/application-credit-holds";
  assert.equal((await get(url)).status, 401);
  assert.equal((await get(url, bearer({ userType: "PORTAL", id: "member-1", permissions: ["payments:read"] }))).status, 403);
  assert.equal((await get(url, bearer({ userType: "CRM", id: "staff-none", permissions: ["application:write"] }))).status, 403);
  assert.equal((await get(url, bearer({ userType: "CRM", id: "staff-rep", permissions: ["accounts.reports:read"] }))).status, 403);

  const okA = await get(`${url}?status=pending_finance_review`, bearer({ userType: "CRM", id: "staff-fin", permissions: ["payments:read"] }));
  assert.equal(okA.status, 200);
  const apps = okA.data.items.map((i) => i.applicationId).sort();
  assert.deepEqual(apps, ["app-link"]);
  assert.equal(okA.data.items[0].currentUnallocatedCents, FEE);

  const allA = await get(url, bearer({ userType: "CRM", id: "staff-fin", permissions: ["payments:read"] }));
  assert.deepEqual(allA.data.items.map((i) => i.applicationId).sort(), ["app-link", "app-return"]);

  const okB = await get(url, bearer({ userType: "CRM", id: "staff-fin-b", tenantId: B, permissions: ["payments:read"] }));
  assert.equal(okB.status, 200);
  assert.equal(okB.data.total, 0);

  const bad = await get(`${url}?status=allocated`, bearer({ userType: "CRM", id: "staff-fin", permissions: ["payments:read"] }));
  assert.equal(bad.status, 400);
});
