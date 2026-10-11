// Portal payment contract (Phase 2B-PARALLEL-2 correction) — application vs member payments.
//
// The client may calculate or choose an amount; the backend validates it against server-side
// rules and financial state:
//   APPLICATION: caller's own application in the trusted tenant (portal-service, as the
//     caller); category + payment type from that record; Credit Card -> annual fee, other
//     payment types -> quarter instalment or annual fee.
//   MEMBER: caller's own membership number; 0 < amount <= current outstanding balance.
//
// Uses a REAL throwaway mongod (as ledgerTenancy.test.js) for balances and postings; the
// portal-service / profile-service HTTP calls are stubbed at fetch. Skips without mongod.
//
//   node --test --test-force-exit src/tests/paymentContract.test.js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-payment-contract-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.NOTIFICATION_SERVICE_URL = "";
process.env.PROFILE_SERVICE_URL = "http://profile.test";
process.env.PORTAL_SERVICE_URL = "http://portal.test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_contract";

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ANNUAL = 32600;
const QUARTER = Math.round(ANNUAL / 4);

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
  mongodDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-contract-mongod-"));
  const port = await freePort();
  mongodProc = spawn("mongod", ["--dbpath", mongodDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  return `mongodb://127.0.0.1:${port}/payment_contract_test`;
}
const uri = await startMongo();
const skip = uri ? false : "no mongod on PATH and LEDGER_TEST_MONGO_URI unset";

const mongoose = (await import("mongoose")).default;
const { publisher } = await import("@projectShell/rabbitmq-middleware");
publisher.publish = async () => ({ success: true, eventId: "test" });

const { assertIntentAuthorized } = await import("../services/paymentIntentGuard.service.js");
const payments = await import("../services/payments.service.js");
const journal = await import("../controllers/journal.controller.js");
const { handleMemberCreated } = await import("../handlers/application.approval.listener.js");
const { ensureTenantChartOfAccounts } = await import("../services/coaProvisioning.service.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Product } = await import("../models/product.model.js");
const { default: Pricing } = await import("../models/pricing.model.js");

// ---- upstream stubs (portal-service applications, profile-service my-profile) ----
// applications[tenant][userId][applicationId] = { membershipCategory, paymentType }
const applications = {
  [A]: { "user-A": { "app-A-card": { membershipCategory: "General All Grades", paymentType: "Credit Card" },
                     "app-A-dd": { membershipCategory: "General All Grades", paymentType: "Direct Debit" } } },
  [B]: { "user-B": { "app-B": { membershipCategory: "General All Grades", paymentType: "Credit Card" } } },
};
const profiles = { [A]: { "user-A": { profileId: "prof-A", membershipNumber: "M-A1" } }, [B]: { "user-B": { profileId: "prof-B", membershipNumber: "M-B1" } } };
const upstreamCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const tenant = opts.headers?.["x-tenant-id"];
  const user = opts.headers?.["x-user-id"];
  upstreamCalls.push({ path: u.pathname, tenant, user });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let m = u.pathname.match(/^\/api\/subscription-details\/(.+)$/);
  if (m && u.host === "portal.test") {
    const app = applications[tenant]?.[user]?.[decodeURIComponent(m[1])];
    return app
      ? json(200, { status: "success", data: { applicationId: m[1], subscriptionDetails: app } })
      : json(404, { status: "fail", message: "Subscription details not found" });
  }
  if (u.pathname === "/api/profile/my-profile" && u.host === "profile.test") {
    const p = profiles[tenant]?.[user];
    return p ? json(200, { status: "success", data: p }) : json(404, { status: "fail" });
  }
  return json(404, {});
};

// A PORTAL caller as the auth middleware leaves it: trusted tenant in ctx/tenantId; the
// raw headers may carry anything (client-supplied x-tenant-id is never forwarded).
function portalCaller(tenantId, userId, rawHeaders = {}) {
  return {
    userType: "PORTAL",
    internalRequest: false,
    req: {
      ctx: { tenantId, userId },
      tenantId,
      headers: { authorization: "Bearer t", "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": userId, "x-user-type": "PORTAL", ...rawHeaders },
    },
  };
}
const catalogue = { getMembershipPricing: async ({ tenantId, categoryName }) => ({ annualFee: tenantId && /general all grades/i.test(categoryName) ? ANNUAL : null }) };
function guardApp({ tenantId = A, userId = "user-A", applicationId, amount, metadata = {}, raw } = {}) {
  return assertIntentAuthorized(
    {
      parsed: { amount, purpose: "subscriptionFee" },
      metadata: { applicationId, ...metadata },
      applicationId,
      isApplicationPayment: true,
      isEventRegistrationPayment: false,
      ctx: { tenantId },
      caller: portalCaller(tenantId, userId, raw),
    },
    catalogue,
  );
}
function guardMember({ tenantId = A, userId = "user-A", memberId, amount }) {
  return assertIntentAuthorized({
    parsed: { amount, purpose: "subscriptionFee" },
    metadata: { memberId },
    memberId,
    isApplicationPayment: false,
    isEventRegistrationPayment: false,
    ctx: { tenantId },
    caller: portalCaller(tenantId, userId),
  });
}
const year = new Date().getFullYear();

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
  for (const M of [GL, MatBal, CoA, Payment]) await M.syncIndexes();
  await ensureTenantChartOfAccounts(A);
  await ensureTenantChartOfAccounts(B);
  for (const t of [A, B]) {
    await Product.collection.insertOne({ _id: `prod-gag-${t}`, tenantId: t, code: "GAG", name: "General All Grades", isDeleted: false, isActive: true });
    await Pricing.collection.insertOne({ tenantId: t, productId: `prod-gag-${t}`, price: ANNUAL, isDeleted: false, isActive: true, effectiveFrom: new Date("2020-01-01"), effectiveTo: null });
  }
  // Member M-A1 (tenant A) owes 10000 on 1400 current.
  await journal.postBalancedJournal({
    date: `${year}-02-01`, tenantId: A, docType: "Invoice", docNo: "INV-M-A1", memo: "Subscription",
    lines: [
      { accountCode: "1400", dc: "D", amount: 10000, memberId: "M-A1", periodBucket: "current" },
      { accountCode: "4000", dc: "C", amount: 10000, revenueSubType: "fee" },
    ],
  });
});
test.after(async () => {
  globalThis.fetch = realFetch;
  if (skip) return;
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) mongodProc.kill("SIGTERM");
  if (mongodDir) fs.rmSync(mongodDir, { recursive: true, force: true });
});

// ------------------------------- APPLICATION -------------------------------

test("1 tenant-A application payment without memberId succeeds", { skip }, async () => {
  const r = await guardApp({ applicationId: "app-A-card", amount: ANNUAL });
  assert.equal(r.kind, "application");
  const call = upstreamCalls.at(-1);
  assert.equal(call.path, "/api/subscription-details/app-A-card");
  assert.equal(call.tenant, A);
});

test("2 initial quarter-instalment payment (non-card application) succeeds", { skip }, async () => {
  const r = await guardApp({ applicationId: "app-A-dd", amount: QUARTER });
  assert.deepEqual(r.allowed, [QUARTER, ANNUAL]);
  await guardApp({ applicationId: "app-A-dd", amount: ANNUAL }); // paying in full is also allowed
});

test("3 full credit-card application payment succeeds; a card applicant cannot pay only the quarter", { skip }, async () => {
  const r = await guardApp({ applicationId: "app-A-card", amount: ANNUAL });
  assert.deepEqual(r.allowed, [ANNUAL]);
  await assert.rejects(guardApp({ applicationId: "app-A-card", amount: QUARTER }), (e) => e.status === 400);
});

test("4 tenant B's application used by tenant A is rejected", { skip }, async () => {
  await assert.rejects(guardApp({ applicationId: "app-B", amount: ANNUAL }), (e) => e.status === 404);
  // ...and by another user in tenant B too (ownership, not just tenant).
  await assert.rejects(guardApp({ tenantId: B, userId: "user-B2", applicationId: "app-B", amount: ANNUAL }), (e) => e.status === 404);
});

test("5 invalid applicationId is rejected safely (404, no detail)", { skip }, async () => {
  await assert.rejects(guardApp({ applicationId: "does-not-exist", amount: ANNUAL }), (e) => e.status === 404 && e.message === "Application not found");
});

test("6 manipulated application amount / cheaper client category is rejected", { skip }, async () => {
  for (const amount of [1, QUARTER - 1, ANNUAL + 1, 0]) {
    await assert.rejects(guardApp({ applicationId: "app-A-dd", amount }), (e) => e.status === 400);
  }
  // The client's metadata category is ignored; the record's category prices the payment.
  const meta = { membershipCategory: "Students" };
  const r = await guardApp({ applicationId: "app-A-card", amount: ANNUAL, metadata: meta });
  assert.equal(r.annualFee, ANNUAL);
});

test("7 client-supplied tenant cannot override the trusted tenant", { skip }, async () => {
  // Tenant A caller naming tenant B in metadata and the raw x-tenant-id header.
  await assert.rejects(
    guardApp({ applicationId: "app-B", amount: ANNUAL, metadata: { tenantId: B }, raw: { "x-tenant-id": B } }),
    (e) => e.status === 404,
  );
  assert.equal(upstreamCalls.at(-1).tenant, A, "portal-service is asked under the trusted tenant");
});

test("8 a succeeded application payment reconciles to the application (tenant A)", { skip }, async () => {
  const payment = await Payment.create({
    tenantId: A, purpose: "subscriptionFee", amount: ANNUAL, currency: "eur", mode: "stripe",
    status: "succeeded", applicationId: "app-A-card", stripe: { paymentIntentId: "pi_app_A" },
  });
  await payments.postJournalForPayment(payment.toObject(), { tenantId: A });
  const rcp = await GL.findOne({ tenantId: A, docNo: `RCP-${payment._id}` }).lean();
  assert.ok(rcp, "receipt posted under tenant A");
  assert.ok(rcp.entries.some((e) => e.accountCode === "2020" && e.dc === "C" && e.applicationId === "app-A-card"));
  assert.equal(await GL.countDocuments({ tenantId: B, docNo: `RCP-${payment._id}` }), 0);
});

test("9 application proceeds payment -> approval -> member creation (invoice + credit claim to the member)", { skip }, async () => {
  await handleMemberCreated({
    eventId: "evt-mc",
    tenantId: A,
    data: {
      applicationId: "app-A-card", memberId: "M-A9", subscriptionId: "sub-A9", profileId: "prof-A9",
      effective: { subscriptionDetails: { membershipCategory: "General All Grades" } },
      subscriptionAttributes: { startDate: `${year}-01-01` },
    },
  });
  const claim = await GL.findOne({ tenantId: A, docNo: "CLAIM-app-A-card" }).lean();
  assert.ok(claim, "application credit claimed to the new member");
  assert.ok(claim.entries.some((e) => e.accountCode === "2020" && e.dc === "C" && e.memberId === "M-A9"));
  const invoice = await GL.findOne({ tenantId: A, docType: "Invoice", "entries.memberId": "M-A9" }).lean();
  assert.ok(invoice, "membership invoice posted for the new member");
});

// --------------------------------- MEMBER ----------------------------------

test("10 member pays the full outstanding balance", { skip }, async () => {
  const r = await guardMember({ memberId: "M-A1", amount: 10000 });
  assert.equal(r.kind, "member");
  assert.equal(r.outstandingCents, 10000);
});

test("11 member pays part of the outstanding balance", { skip }, async () => {
  await guardMember({ memberId: "M-A1", amount: 2500 });
  await guardMember({ memberId: "M-A1", amount: 1 });
});

test("12 amount above the outstanding balance is rejected", { skip }, async () => {
  await assert.rejects(guardMember({ memberId: "M-A1", amount: 10001 }), (e) => e.status === 400 && e.outstandingCents === 10000);
});

test("13 zero / negative amounts are rejected", { skip }, async () => {
  for (const amount of [0, -100]) {
    await assert.rejects(guardMember({ memberId: "M-A1", amount }), (e) => e.status === 400);
  }
});

test("14 another tenant's member is rejected", { skip }, async () => {
  // Tenant B caller naming tenant A's member: not their own membership number.
  await assert.rejects(guardMember({ tenantId: B, userId: "user-B", memberId: "M-A1", amount: 100 }), (e) => e.status === 403);
  // Even naming their own number, B has no outstanding balance in tenant A's ledger.
  await assert.rejects(guardMember({ tenantId: B, userId: "user-B", memberId: "M-B1", amount: 100 }), (e) => e.status === 400);
});

test("15 client-supplied tenant is ignored for member payments", { skip }, async () => {
  const caller = portalCaller(B, "user-B", { "x-tenant-id": A });
  await assert.rejects(
    assertIntentAuthorized({
      parsed: { amount: 100, purpose: "subscriptionFee" },
      metadata: { memberId: "M-A1", tenantId: A },
      memberId: "M-A1",
      isApplicationPayment: false,
      isEventRegistrationPayment: false,
      ctx: { tenantId: B },
      caller,
    }),
    (e) => e.status === 403,
  );
  assert.equal(upstreamCalls.at(-1).tenant, B);
});

test("16 member payment still reconciles: receipt credits the member's AR in tenant A", { skip }, async () => {
  const payment = await Payment.create({
    tenantId: A, purpose: "subscriptionFee", amount: 4000, currency: "eur", mode: "stripe",
    status: "succeeded", memberId: "M-A1", stripe: { paymentIntentId: "pi_mem_A" },
  });
  await payments.postJournalForPayment(payment.toObject(), { tenantId: A });
  const rcp = await GL.findOne({ tenantId: A, docNo: `RCP-${payment._id}` }).lean();
  assert.ok(rcp.entries.some((e) => e.accountCode === "1400" && e.dc === "C" && e.memberId === "M-A1"));
  const r = await guardMember({ memberId: "M-A1", amount: 6000 });
  assert.equal(r.outstandingCents, 6000, "outstanding reflects the reconciled payment");
  await assert.rejects(guardMember({ memberId: "M-A1", amount: 6001 }), (e) => e.status === 400);
});

test("portal caller with neither applicationId nor memberId is rejected", { skip }, async () => {
  await assert.rejects(
    assertIntentAuthorized({
      parsed: { amount: 100, purpose: "subscriptionFee" },
      metadata: {},
      isApplicationPayment: false,
      isEventRegistrationPayment: false,
      ctx: { tenantId: A },
      caller: portalCaller(A, "user-A"),
    }),
    (e) => e.status === 400,
  );
});
