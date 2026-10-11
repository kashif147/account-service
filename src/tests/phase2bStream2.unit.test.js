// Phase 2B Stream 2 — handler/service-level Tenant A/B regression tests for account-service:
//   C-06 reconcile re-derives from Stripe, H-11 intent pricing/ownership, H-12 BatchDetail
//   tenant isolation, H-15 idempotency cache isolation, H-29 envelope tenant on
//   members.subscription.current.updated.v1, H-27 event-cancellation refund validation.
// No database: model statics are replaced with in-memory fakes; Stripe/profile-service are
// injected fakes (deps) or a patched global fetch.
//
//   node --test --test-force-exit src/tests/phase2bStream2.unit.test.js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-p2b-unit-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_phase2b";
process.env.PROFILE_SERVICE_URL = "http://profile.invalid";
process.env.PORTAL_SERVICE_URL = "http://portal.invalid";

const { idempotency, clearIdempotencyCache, getIdempotencyCacheSize } = await import(
  "../middlewares/idempotency.js"
);
const payments = await import("../services/payments.service.js");
const { assertIntentAuthorized } = await import("../services/paymentIntentGuard.service.js");
const { default: Payment } = await import("../models/payment.model.js");
const { default: Product } = await import("../models/product.model.js");
const { default: Pricing } = await import("../models/pricing.model.js");
const { default: CoA } = await import("../models/coa.model.js");
const { default: MaterializedBalance } = await import("../models/materializedBalance.model.js");
const { default: GLTransaction } = await import("../models/glTransaction.model.js");
const { default: BatchDetail } = await import("../models/batch.detail.model.js");
const { default: User } = await import("../models/user.model.js");
const batchCtl = await import("../controllers/batch.detail.controller.js");
const { processEventCancellationRefunds } = await import("../services/eventCancellationRefund.service.js");
const { resolveEventTenant } = await import("../helpers/eventTenant.js");
const { handleMemberCreated } = await import("../handlers/application.approval.listener.js");

const A = "tenant-A";
const B = "tenant-B";

function q(result) {
  const p = Promise.resolve(result);
  const o = {
    lean: () => o,
    select: () => o,
    sort: () => o,
    skip: () => o,
    limit: () => o,
    then: (a, b) => p.then(a, b),
    catch: (b) => p.catch(b),
  };
  return o;
}

function patch(model, impls) {
  const orig = {};
  for (const [k, v] of Object.entries(impls)) {
    orig[k] = Object.prototype.hasOwnProperty.call(model, k) ? model[k] : undefined;
    model[k] = v;
  }
  return () => {
    for (const k of Object.keys(impls)) {
      if (orig[k] === undefined) delete model[k];
      else model[k] = orig[k];
    }
  };
}

function mkRes() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}

// ======================= H-15 idempotency =======================

function idemReq({ tenantId, userId = "u1", path: p = "/intents", baseUrl = "/api/payments", key = "same-key-123" }) {
  return {
    method: "POST",
    baseUrl,
    path: p,
    ctx: tenantId ? { tenantId, userId } : undefined,
    header: (n) => (n === "Idempotency-Key" ? key : null),
  };
}
function runIdem(req, { status = 200, body = { ok: true } } = {}) {
  const res = mkRes();
  let handled = false;
  idempotency()(req, res, () => {
    handled = true;
    res.status(status).json(body);
  });
  return { res, handled };
}

test("H15-A same Idempotency-Key from Tenant B never replays Tenant A's response", () => {
  clearIdempotencyCache();
  const a = runIdem(idemReq({ tenantId: A }), { body: { secret: "tenant-A-data" } });
  assert.equal(a.handled, true);
  const b = runIdem(idemReq({ tenantId: B, userId: "u1" }), { body: { mine: "B" } });
  assert.equal(b.handled, true, "tenant B request must be processed, not replayed");
  assert.deepEqual(b.res.body, { mine: "B" });
});

test("H15-B same tenant, different user: no replay", () => {
  clearIdempotencyCache();
  runIdem(idemReq({ tenantId: A, userId: "u1" }), { body: { who: "u1" } });
  const other = runIdem(idemReq({ tenantId: A, userId: "u2" }), { body: { who: "u2" } });
  assert.equal(other.handled, true);
  assert.deepEqual(other.res.body, { who: "u2" });
});

test("H15-C same tenant+user, different route: no replay", () => {
  clearIdempotencyCache();
  runIdem(idemReq({ tenantId: A, path: "/intents" }), { body: { r: 1 } });
  const other = runIdem(idemReq({ tenantId: A, path: "/refunds" }), { body: { r: 2 } });
  assert.equal(other.handled, true);
});

test("H15-D same tenant+user+route replays the cached 2xx with its original status", () => {
  clearIdempotencyCache();
  runIdem(idemReq({ tenantId: A }), { status: 201, body: { id: 7 } });
  const again = runIdem(idemReq({ tenantId: A }), { body: { id: 8 } });
  assert.equal(again.handled, false);
  assert.equal(again.res.statusCode, 201);
  assert.deepEqual(again.res.body, { id: 7 });
});

test("H15-E non-2xx responses are not cached (retry with same key is processed)", () => {
  clearIdempotencyCache();
  runIdem(idemReq({ tenantId: A }), { status: 400, body: { err: true } });
  assert.equal(getIdempotencyCacheSize(), 0);
  const retry = runIdem(idemReq({ tenantId: A }), { body: { ok: 1 } });
  assert.equal(retry.handled, true);
});

test("H15-F no trusted tenant => nothing cached", () => {
  clearIdempotencyCache();
  runIdem(idemReq({ tenantId: null }));
  assert.equal(getIdempotencyCacheSize(), 0);
});

// ======================= C-06 reconcile from Stripe =======================

function reconcileDeps({ owner = A, pi } = {}) {
  const calls = { findOne: [], reconcile: [] };
  return {
    calls,
    deps: {
      Payment: {
        findOne: (f) => {
          calls.findOne.push(f);
          return q(f.tenantId === owner && f["stripe.paymentIntentId"] === "pi_1" ? { _id: "pay-1", tenantId: owner } : null);
        },
      },
      getStripe: () => ({
        paymentIntents: {
          retrieve: async (id) =>
            pi || { id, status: "requires_capture", amount: 32600, amount_received: 0, currency: "eur", metadata: { tenantId: owner } },
        },
      }),
      reconcileStripeEvent: async (input, ctx) => {
        calls.reconcile.push({ input, ctx });
        return { ok: true };
      },
    },
  };
}

test("C06-A Tenant A: amount/status come from Stripe, not the request body", async () => {
  const { deps, calls } = reconcileDeps();
  const out = await payments.reconcilePaymentFromStripe(
    { eventId: "e", type: "x", payment: { paymentIntentId: "pi_1", amount: 1, status: "succeeded", currency: "usd" } },
    { tenantId: A, userId: "u1" },
    deps,
  );
  assert.equal(calls.findOne[0].tenantId, A);
  const sent = calls.reconcile[0];
  assert.equal(sent.input.payment.amount, 32600);
  assert.equal(sent.input.payment.status, "requires_capture");
  assert.equal(sent.input.payment.currency, "eur");
  assert.equal(sent.ctx.scopeToTenantId, A);
  assert.equal(out.amount, 32600);
});

test("C06-B Tenant B cannot reconcile Tenant A's PaymentIntent (404, no Stripe/reconcile call)", async () => {
  const { deps, calls } = reconcileDeps({ owner: A });
  await assert.rejects(
    payments.reconcilePaymentFromStripe({ paymentIntentId: "pi_1" }, { tenantId: B }, deps),
    (e) => e.status === 404,
  );
  assert.equal(calls.reconcile.length, 0);
});

test("C06-C Stripe metadata naming another tenant is rejected", async () => {
  const { deps, calls } = reconcileDeps({
    owner: A,
    pi: { id: "pi_1", status: "succeeded", amount: 100, amount_received: 100, currency: "eur", metadata: { tenantId: B } },
  });
  await assert.rejects(
    payments.reconcilePaymentFromStripe({ paymentIntentId: "pi_1" }, { tenantId: A }, deps),
    (e) => e.status === 404,
  );
  assert.equal(calls.reconcile.length, 0);
});

test("C06-D missing trusted tenant is rejected", async () => {
  const { deps } = reconcileDeps();
  await assert.rejects(
    payments.reconcilePaymentFromStripe({ paymentIntentId: "pi_1" }, {}, deps),
    (e) => e.status === 401,
  );
});

test("C06-E reconcileStripeEvent with scopeToTenantId pins the lookup and refuses to upsert", async () => {
  const filters = [];
  const restore = patch(Payment, {
    findOne: (f) => (filters.push(f), q(null)),
    findOneAndUpdate: () => {
      throw new Error("must not upsert");
    },
  });
  try {
    await assert.rejects(
      payments.reconcileStripeEvent(
        { eventId: "e1", type: "manual-reconcile.succeeded", payment: { paymentIntentId: "pi_1", amount: 1, currency: "eur", status: "succeeded" } },
        { tenantId: B, scopeToTenantId: B },
      ),
      (e) => e.status === 404,
    );
    assert.equal(filters[0].tenantId, B);
  } finally {
    restore();
  }
});

// ======================= H-11 intent pricing / ownership =======================

// Corrected contract (Phase 2B-P2): application category/payment type come from the caller's
// own application record (portal-service); member payments are capped at the outstanding
// balance. Full matrix: paymentContract.test.js.
const pricingDeps = (annualFee = 32600, mine = { profileId: "prof-A", membershipNumber: "M-A" }) => ({
  getMembershipPricing: async ({ tenantId }) => ({ annualFee: tenantId ? annualFee : null }),
  fetchMyPortalProfile: async () => mine,
  fetchMyApplicationSubscription: async () => ({ membershipCategory: "General All Grades", paymentType: "Direct Debit" }),
  getMemberOutstandingCents: async () => 10000,
});
const PORTAL = { userType: "PORTAL", internalRequest: false, req: {} };

test("H11-A portal application payment of 1 cent is rejected (catalogue price 32600)", async () => {
  await assert.rejects(
    assertIntentAuthorized(
      {
        parsed: { amount: 1, purpose: "subscriptionFee" },
        metadata: { membershipCategory: "General All Grades", applicationId: "app-1" },
        applicationId: "app-1",
        isApplicationPayment: true,
        isEventRegistrationPayment: false,
        ctx: { tenantId: A },
        caller: PORTAL,
      },
      pricingDeps(),
    ),
    (e) => e.status === 400,
  );
});

test("H11-B portal application payment accepts the annual fee and the quarterly instalment", async () => {
  for (const amount of [32600, Math.round(32600 / 4)]) {
    const r = await assertIntentAuthorized(
      {
        parsed: { amount, purpose: "subscriptionFee" },
        metadata: { membershipCategory: "General All Grades" },
        applicationId: "app-1",
        isApplicationPayment: true,
        isEventRegistrationPayment: false,
        ctx: { tenantId: A },
        caller: PORTAL,
      },
      pricingDeps(),
    );
    assert.equal(r.checked, true);
  }
});

test("H11-C portal user cannot pay against another member's memberId (403)", async () => {
  await assert.rejects(
    assertIntentAuthorized(
      {
        parsed: { amount: 5000, purpose: "subscriptionFee" },
        metadata: {},
        memberId: "M-B",
        isApplicationPayment: false,
        isEventRegistrationPayment: false,
        ctx: { tenantId: A },
        caller: PORTAL,
      },
      pricingDeps(),
    ),
    (e) => e.status === 403,
  );
});

test("H11-D portal user paying on their own account (own memberId) is allowed", async () => {
  const r = await assertIntentAuthorized(
    {
      parsed: { amount: 5000, purpose: "subscriptionFee" },
      metadata: {},
      memberId: "M-A",
      isApplicationPayment: false,
      isEventRegistrationPayment: false,
      ctx: { tenantId: A },
      caller: PORTAL,
    },
    pricingDeps(),
  );
  assert.equal(r.checked, true);
});

test("H11-E portal user cannot claim another profileId; profile lookup failure fails closed (503)", async () => {
  await assert.rejects(
    assertIntentAuthorized(
      {
        parsed: { amount: 100, purpose: "eventRegistration" },
        metadata: {},
        profileId: "prof-B",
        isApplicationPayment: false,
        isEventRegistrationPayment: true,
        ctx: { tenantId: A },
        caller: PORTAL,
      },
      pricingDeps(),
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    assertIntentAuthorized(
      {
        parsed: { amount: 100, purpose: "subscriptionFee" },
        metadata: {},
        memberId: "M-A",
        isApplicationPayment: false,
        isEventRegistrationPayment: false,
        ctx: { tenantId: A },
        caller: PORTAL,
      },
      { ...pricingDeps(), fetchMyPortalProfile: async () => { throw new Error("down"); } },
    ),
    (e) => e.status === 503,
  );
});

test("H11-F CRM users and internal S2S calls are unchanged (no re-pricing)", async () => {
  for (const caller of [{ userType: "CRM" }, { internalRequest: true }]) {
    const r = await assertIntentAuthorized(
      {
        parsed: { amount: 1, purpose: "applicationFee" },
        metadata: {},
        applicationId: "app-1",
        memberId: "M-B",
        isApplicationPayment: true,
        isEventRegistrationPayment: false,
        ctx: { tenantId: A },
        caller,
      },
      { getMembershipPricing: async () => assert.fail("not called"), fetchMyPortalProfile: async () => assert.fail("not called") },
    );
    assert.equal(r.checked, false);
  }
});

test("H11-G createIntent (real) rejects a 1-cent portal application payment before Stripe/Payment, using Tenant A catalogue", async () => {
  const origFetch = globalThis.fetch;
  const portalTenants = [];
  globalThis.fetch = async (url, opts) => {
    portalTenants.push(opts?.headers?.["x-tenant-id"]);
    return new Response(
      JSON.stringify({ status: "success", data: { applicationId: "app-1", subscriptionDetails: { membershipCategory: "General All Grades", paymentType: "Credit Card" } } }),
      { status: 200 },
    );
  };
  const productFilters = [];
  const r1 = patch(Product, { findOne: (f) => (productFilters.push(f), q({ _id: "prod-1", code: "GAG", name: "General All Grades" })) });
  const r2 = patch(Pricing, { findOne: () => q({ _id: "pr-1", price: 32600, isActive: true }) });
  const r3 = patch(CoA, { findOne: () => q({ code: "4000" }) });
  const r4 = patch(Payment, { findOne: () => { throw new Error("STOP_AFTER_GUARD"); } });
  try {
    await assert.rejects(
      payments.createIntent(
        { purpose: "subscriptionFee", amount: 1, currency: "eur", metadata: { applicationId: "app-1", membershipCategory: "General All Grades", tenantId: B } },
        { tenantId: A, userId: "member-1" },
        { userType: "PORTAL", internalRequest: false, req: { headers: {}, ctx: { tenantId: A }, tenantId: A } },
      ),
      (e) => e.status === 400,
    );
    assert.equal(productFilters[0].tenantId, A, "catalogue resolved in the trusted tenant, not metadata tenant");
    assert.ok(portalTenants.every((t) => t === A), "application looked up under the trusted tenant");
    await assert.rejects(
      payments.createIntent(
        { purpose: "subscriptionFee", amount: 32600, currency: "eur", metadata: { applicationId: "app-1", membershipCategory: "General All Grades" } },
        { tenantId: A, userId: "member-1" },
        { userType: "PORTAL", internalRequest: false, req: { headers: {}, ctx: { tenantId: A }, tenantId: A } },
      ),
      /STOP_AFTER_GUARD/,
      "correct price passes the guard and proceeds to the existing flow",
    );
  } finally {
    globalThis.fetch = origFetch;
    r1(); r2(); r3(); r4();
  }
});

test("H11-H createIntent (real) rejects a portal payment against another member via profile-service my-profile", async () => {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts?.headers });
    return new Response(JSON.stringify({ status: "success", data: { profileId: "prof-A", membershipNumber: "M-A" } }), { status: 200 });
  };
  const r4 = patch(Payment, { findOne: () => { throw new Error("STOP_AFTER_GUARD"); } });
  const r5 = patch(MaterializedBalance, {
    find: (f) => q(f.tenantId === A ? [{ memberId: "M-A", accountCode: "1400", bucket: "current", year: 2026, amount: 10000 }] : []),
  });
  try {
    await assert.rejects(
      payments.createIntent(
        { purpose: "subscriptionFee", amount: 5000, currency: "eur", metadata: { memberId: "M-B" } },
        { tenantId: A, userId: "member-1" },
        { userType: "PORTAL", internalRequest: false, req: { headers: { authorization: "Bearer t" }, tenantId: A } },
      ),
      (e) => e.status === 403,
    );
    assert.match(seen[0].url, /\/api\/profile\/my-profile$/);
    assert.equal(seen[0].headers["x-tenant-id"], A);
    await assert.rejects(
      payments.createIntent(
        { purpose: "subscriptionFee", amount: 5000, currency: "eur", metadata: { memberId: "M-A" } },
        { tenantId: A, userId: "member-1" },
        { userType: "PORTAL", internalRequest: false, req: { headers: { authorization: "Bearer t" }, tenantId: A } },
      ),
      /STOP_AFTER_GUARD/,
    );
  } finally {
    globalThis.fetch = origFetch;
    r4(); r5();
  }
});

// ======================= H-12 BatchDetail tenant isolation =======================

function batchReq(tenantId, extra = {}) {
  return {
    tenantId,
    ctx: tenantId ? { tenantId, userId: "u1" } : {},
    user: { userType: "CRM", tenantId, id: "u1" },
    params: { batchDetailId: "batch-A" },
    body: {},
    query: {},
    headers: {},
    ...extra,
  };
}
const BATCH_A = { _id: "batch-A", tenantId: A, isDeleted: false, batchStatus: "pending", batchPayments: [{ _id: "p1" }], createdBy: "u1" };
const ownerOnly = (f) => (f.tenantId === A && String(f._id) === "batch-A" ? { ...BATCH_A } : null);

test("H12-A Tenant B cannot read Tenant A's batch by id (404, lookup carries tenant B)", async () => {
  const filters = [];
  const restore = patch(BatchDetail, { findOne: (f) => (filters.push(f), q(ownerOnly(f))) });
  try {
    const res = mkRes();
    await batchCtl.getBatchDetailById(batchReq(B), res);
    assert.equal(res.statusCode, 404);
    assert.equal(filters[0].tenantId, B);
  } finally {
    restore();
  }
});

test("H12-B Tenant B cannot queue Tenant A's batch for processing; no update issued", async () => {
  const updates = [];
  const restore = patch(BatchDetail, {
    findOne: (f) => q(ownerOnly(f)),
    updateOne: (f, u) => (updates.push(f), Promise.resolve({})),
  });
  try {
    const res = mkRes();
    await batchCtl.processBatchDetail(batchReq(B), res);
    assert.equal(res.statusCode, 404);
    assert.equal(updates.length, 0);
    const resA = mkRes();
    await batchCtl.processBatchDetail(batchReq(A), resA);
    assert.equal(resA.statusCode, 202);
    assert.equal(updates[0].tenantId, A);
  } finally {
    restore();
  }
});

test("H12-C Tenant B cannot delete Tenant A's batch (both delete and existence probe scoped)", async () => {
  const filters = [];
  const restore = patch(BatchDetail, {
    findOneAndDelete: (f) => (filters.push(["del", f]), q(ownerOnly(f))),
    findOne: (f) => (filters.push(["probe", f]), q(ownerOnly(f))),
  });
  try {
    const res = mkRes();
    await batchCtl.deleteBatchDetail(batchReq(B), res);
    assert.equal(res.statusCode, 404);
    for (const [, f] of filters) assert.equal(f.tenantId, B);
  } finally {
    restore();
  }
});

test("H12-D Tenant B cannot mutate Tenant A's batch via exclude/resolve/add-profile", async () => {
  const filters = [];
  const restore = patch(BatchDetail, { findOne: (f) => (filters.push(f), q(ownerOnly(f))) });
  try {
    const r1 = mkRes();
    await batchCtl.excludeBatchPaymentsToExceptions(batchReq(B, { body: { paymentEntryIds: ["p1"] } }), r1);
    assert.equal(r1.statusCode, 404);
    const r2 = mkRes();
    await batchCtl.resolveBatchException(batchReq(B, { body: { membershipNumber: "M1", exceptionMembershipNumber: "X1" } }), r2);
    assert.equal(r2.statusCode, 404);
    const r3 = mkRes();
    await batchCtl.addPaymentToBatch(
      batchReq(B, { body: { membershipNumber: "M1", memberName: "N", badgeReferenceNumber: "R", amount: 1 } }),
      r3,
    );
    assert.equal(r3.statusCode, 404);
    assert.ok(filters.length === 3 && filters.every((f) => f.tenantId === B));
  } finally {
    restore();
  }
});

test("H12-E list and queue-stats always filter by trusted tenant; missing tenant is rejected (no unscoped query)", async () => {
  const seen = [];
  const restore = patch(BatchDetail, {
    find: (f) => (seen.push(f), q([])),
    countDocuments: (f) => (seen.push(f), Promise.resolve(0)),
    aggregate: (p) => (seen.push(p[0].$match), Promise.resolve([])),
    findOne: (f) => (seen.push(f), q(null)),
  });
  const restoreUser = patch(User, { find: () => q([]) });
  try {
    const r = mkRes();
    await batchCtl.getAllBatchDetails(batchReq(B), r);
    const s = mkRes();
    await batchCtl.getBatchQueueStats(batchReq(B), s);
    assert.ok(seen.length > 0 && seen.every((f) => f.tenantId === B));
    const before = seen.length;
    const none = mkRes();
    await batchCtl.getAllBatchDetails(batchReq(null, { user: { userType: "CRM" } }), none);
    assert.equal(none.statusCode, 401);
    assert.equal(seen.length, before, "no query without a trusted tenant");
  } finally {
    restore();
    restoreUser();
  }
});

test("H12-F 500 responses no longer echo raw error messages", async () => {
  const restore = patch(BatchDetail, { findOne: () => { throw new Error("mongo internals: secret-host:27017"); } });
  try {
    const res = mkRes();
    await batchCtl.processBatchDetail(batchReq(A), res);
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /secret-host/);
  } finally {
    restore();
  }
});

// ======================= H-29 envelope tenant =======================

test("H29-A resolveEventTenant: envelope wins, data fallback, mismatch flagged + logged", () => {
  const warns = [];
  const logger = { warn: (o) => warns.push(o) };
  assert.equal(resolveEventTenant({ tenantId: A, data: {} }).tenantId, A);
  assert.equal(resolveEventTenant({ data: { tenantId: B } }).tenantId, B);
  const m = resolveEventTenant({ tenantId: A, data: { tenantId: B } }, { logger });
  assert.equal(m.tenantId, A);
  assert.equal(m.mismatch, true);
  assert.equal(warns.length, 1);
  assert.equal(resolveEventTenant({ data: {} }).tenantId, null);
});

test("H29-B current.updated with tenant only on the envelope prices in that tenant (Tenant A)", async () => {
  const productFilters = [];
  const r1 = patch(Product, { findOne: (f) => (productFilters.push(f), q(null)) });
  const r2 = patch(CoA, { findOne: () => q({ code: "4000" }) });
  const r3 = patch(GLTransaction, { findOne: () => q({ _id: "existing-invoice" }) });
  try {
    await handleMemberCreated({
      eventId: "evt-1",
      tenantId: A,
      data: { subscriptionId: "sub-1", memberId: "M-A", subscriptionAttributes: { startDate: "2026-01-01" } },
    });
    assert.equal(productFilters.length, 1);
    assert.equal(productFilters[0].tenantId, A);
  } finally {
    r1(); r2(); r3();
  }
});

test("H29-B2 current.updated with envelope A but data B is quarantined, nothing priced or posted (Phase 2B-P2 B7)", async () => {
  let touched = 0;
  const r1 = patch(Product, { findOne: () => (touched++, q(null)) });
  const r3 = patch(GLTransaction, { findOne: () => (touched++, q(null)) });
  try {
    await assert.rejects(
      () =>
        handleMemberCreated({
          eventId: "evt-1",
          tenantId: A,
          data: { subscriptionId: "sub-1", memberId: "M-A", tenantId: B, subscriptionAttributes: { startDate: "2026-01-01" } },
        }),
      (e) => e.code === "EVENT_TENANT_MISMATCH",
    );
    assert.equal(touched, 0);
  } finally {
    r1(); r3();
  }
});

test("H29-C current.updated with no tenant anywhere does not bill tenantless", async () => {
  let touched = 0;
  const r1 = patch(Product, { findOne: () => (touched++, q(null)) });
  const r3 = patch(GLTransaction, { findOne: () => (touched++, q(null)) });
  try {
    await handleMemberCreated({ data: { subscriptionId: "sub-1", memberId: "M-A" } });
    assert.equal(touched, 0);
  } finally {
    r1(); r3();
  }
});

test("H29-D invoice() forwards the trusted tenant to postBalancedJournal (source check)", () => {
  const src = fs.readFileSync(new URL("../controllers/journal.controller.js", import.meta.url), "utf8");
  const start = src.indexOf("export async function invoice(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  // Both invoice postings take the trusted tenant via requireTenantId(req) (Phase 2B-P2).
  assert.equal((body.match(/tenantId: requireTenantId\(req\)/g) || []).length, 2);
});

// ======================= H-27 event-cancellation refunds =======================

function refundDeps({ payments: paymentDocs = {}, refundedTotal = 0 } = {}) {
  const calls = { stripe: [], refundCreate: [], paymentFind: [], paymentUpdate: [] };
  return {
    calls,
    deps: {
      Payment: {
        findOne: async (f) => {
          calls.paymentFind.push(f);
          const p = paymentDocs[String(f._id)];
          return p && p.tenantId === f.tenantId ? p : null;
        },
        updateOne: async (f, u) => (calls.paymentUpdate.push({ f, u }), {}),
      },
      Refund: {
        findOne: () => ({ lean: async () => null }),
        create: async (doc) => (calls.refundCreate.push(doc), { _id: "refund-1", ...doc }),
        updateOne: async () => ({}),
        aggregate: async () => (refundedTotal ? [{ total: refundedTotal }] : []),
      },
      getStripe: () => ({
        refunds: { create: async (args) => (calls.stripe.push(args), { id: "re_1", charge: "ch_1" }) },
      }),
      postBalancedJournal: async () => ({ docNo: "RFD-EVT-refund-1" }),
      logger: { info() {}, warn() {}, error() {} },
    },
  };
}
const evPayment = (o = {}) => ({
  _id: "pay-1",
  tenantId: A,
  purpose: "eventRegistration",
  ledgerDomain: "events",
  mode: "stripe",
  status: "succeeded",
  amount: 12000,
  currency: "eur",
  registrationId: "reg-1",
  stripe: { paymentIntentId: "pi_1" },
  ...o,
});
const cancelMsg = (o = {}) => ({
  eventId: "msg-1",
  tenantId: A,
  data: {
    tenantId: A,
    eventId: "event-1",
    refundCandidates: [{ registrationId: "reg-1", paymentId: "pay-1", amount: 12000 }],
    ...(o.data || {}),
  },
  ...(o.envelope || {}),
});

test("H27-A valid Tenant A cancellation refunds the captured amount", async () => {
  const { deps, calls } = refundDeps({ payments: { "pay-1": evPayment() } });
  const out = await processEventCancellationRefunds(cancelMsg(), deps);
  assert.equal(out.processed, 1);
  assert.equal(calls.stripe[0].amount, 12000);
  assert.equal(calls.refundCreate[0].tenantId, A);
});

test("H27-B missing envelope tenant: nothing refunded", async () => {
  const { deps, calls } = refundDeps({ payments: { "pay-1": evPayment() } });
  const msg = cancelMsg();
  delete msg.tenantId;
  const out = await processEventCancellationRefunds(msg, deps);
  assert.equal(out.processed, 0);
  assert.equal(calls.stripe.length, 0);
});

test("H27-C envelope tenant B vs data tenant A mismatch: nothing refunded", async () => {
  const { deps, calls } = refundDeps({ payments: { "pay-1": evPayment() } });
  const out = await processEventCancellationRefunds(cancelMsg({ envelope: { tenantId: B } }), deps);
  assert.equal(out.rejected, "tenant_mismatch");
  assert.equal(calls.stripe.length, 0);
  assert.equal(calls.paymentFind.length, 0);
});

test("H27-D Tenant B message naming Tenant A's paymentId: payment not found, no refund", async () => {
  const { deps, calls } = refundDeps({ payments: { "pay-1": evPayment() } });
  const out = await processEventCancellationRefunds(
    cancelMsg({ envelope: { tenantId: B }, data: { tenantId: B } }),
    deps,
  );
  assert.equal(out.results[0].reason, "payment_not_found");
  assert.equal(calls.paymentFind[0].tenantId, B);
  assert.equal(calls.stripe.length, 0);
});

test("H27-E paymentId of another registration / event / non-event payment is skipped", async () => {
  const cases = [
    [evPayment({ registrationId: "reg-OTHER" }), "registration_mismatch"],
    [evPayment({ metadata: new Map([["eventId", "event-OTHER"]]) }), "event_mismatch"],
    [evPayment({ purpose: "subscriptionFee", ledgerDomain: "membership" }), "payment_not_event_registration"],
  ];
  for (const [p, reason] of cases) {
    const { deps, calls } = refundDeps({ payments: { "pay-1": p } });
    const out = await processEventCancellationRefunds(cancelMsg(), deps);
    assert.equal(out.results[0].reason, reason);
    assert.equal(calls.stripe.length, 0);
  }
});

test("H27-F refund capped at captured minus already-refunded; payload amount ignored", async () => {
  const { deps, calls } = refundDeps({ payments: { "pay-1": evPayment() }, refundedTotal: 2000 });
  await processEventCancellationRefunds(
    cancelMsg({ data: { refundCandidates: [{ registrationId: "reg-1", paymentId: "pay-1", amount: 999999 }] } }),
    deps,
  );
  assert.equal(calls.stripe[0].amount, 10000);
  assert.equal(calls.paymentUpdate[0].f.tenantId, A);
  const full = refundDeps({ payments: { "pay-1": evPayment() }, refundedTotal: 12000 });
  const out = await processEventCancellationRefunds(cancelMsg(), full.deps);
  assert.equal(out.results[0].reason, "nothing_to_refund");
  assert.equal(full.calls.stripe.length, 0);
});
