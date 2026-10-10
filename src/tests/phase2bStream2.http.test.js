// Phase 2B Stream 2 — HTTP-level Tenant A/B and authorization regression tests (C-06, C-07,
// H-15) driving the REAL app router over HTTP. No database: mongoose model statics touched by
// the exercised paths are replaced with in-memory fakes before each request.
//
// account-service is ESM and jest@25 here is unreliable, so this runs under node:test:
//   node --test --test-force-exit src/tests/phase2bStream2.http.test.js
// (--test-force-exit: importing src/app.js starts the batch/direct-debit cron timers.)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-p2b-http-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "phase2b-stream2-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_phase2b";

const { default: app } = await import("../app.js");
const { default: Payment } = await import("../models/payment.model.js");

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";

function bearer({ tenantId, userType = "CRM", roles = [], permissions = [], sub = "user-1" }) {
  return `Bearer ${jwt.sign({ sub, tenantId, userType, roles, permissions }, process.env.JWT_SECRET)}`;
}
const FINANCE_A = bearer({ tenantId: TENANT_A, roles: ["AM"], permissions: ["payments:write", "payments:read"] });
const FINANCE_B = bearer({ tenantId: TENANT_B, roles: ["AM"], permissions: ["payments:write", "payments:read"], sub: "user-b" });
const PORTAL_A = bearer({ tenantId: TENANT_A, userType: "PORTAL", sub: "member-1" });
const CRM_NO_FINANCE_A = bearer({ tenantId: TENANT_A, roles: ["MO"], permissions: ["profiles:read"] });

function q(result) {
  const p = Promise.resolve(result);
  const o = {
    lean: () => o,
    select: () => o,
    sort: () => o,
    then: (a, b) => p.then(a, b),
    catch: (b) => p.catch(b),
  };
  return o;
}

async function withServer(fn) {
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function post(base, url, { headers = {}, body = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---------------- C-06 POST /api/payments/reconcile ----------------

test("C06-1 portal (member) JWT cannot reconcile: 403, Payment never read", async () => {
  const orig = Payment.findOne;
  let called = 0;
  Payment.findOne = () => (called++, q(null));
  try {
    await withServer(async (base) => {
      const r = await post(base, "/api/payments/reconcile", {
        headers: { authorization: PORTAL_A },
        body: { paymentIntentId: "pi_A" },
      });
      assert.equal(r.status, 403);
    });
    assert.equal(called, 0);
  } finally {
    Payment.findOne = orig;
  }
});

test("C06-2 CRM user without finance role/permission cannot reconcile: 403", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/payments/reconcile", {
      headers: { authorization: CRM_NO_FINANCE_A },
      body: { paymentIntentId: "pi_A" },
    });
    assert.equal(r.status, 403);
  });
});

test("C06-3 Tenant B finance user cannot reconcile Tenant A's PaymentIntent: lookup pinned to B -> 404", async () => {
  const orig = Payment.findOne;
  const filters = [];
  // Only tenant A owns pi_A.
  Payment.findOne = (f) => {
    filters.push(f);
    return q(f.tenantId === TENANT_A && f["stripe.paymentIntentId"] === "pi_A" ? { _id: "pay-A", tenantId: TENANT_A } : null);
  };
  try {
    await withServer(async (base) => {
      const r = await post(base, "/api/payments/reconcile", {
        headers: { authorization: FINANCE_B },
        // legacy webhook-shaped body with forged amount/status: must be ignored
        body: {
          eventId: "evt_forged",
          type: "payment_intent.succeeded",
          payment: { paymentIntentId: "pi_A", amount: 1, currency: "eur", status: "succeeded" },
          tenantId: TENANT_A,
        },
      });
      assert.equal(r.status, 404);
    });
    assert.ok(filters.length >= 1);
    for (const f of filters) assert.equal(f.tenantId, TENANT_B, "lookup must use the trusted tenant, never body tenant");
  } finally {
    Payment.findOne = orig;
  }
});

test("C06-4 genuine internal S2S call (x-internal-request, no JWT) passes the guard; tenant from x-tenant-id", async () => {
  const orig = Payment.findOne;
  const filters = [];
  Payment.findOne = (f) => (filters.push(f), q(null));
  try {
    await withServer(async (base) => {
      const r = await post(base, "/api/payments/reconcile", {
        headers: { "x-internal-request": "true", "x-tenant-id": TENANT_B },
        body: { paymentIntentId: "pi_A", tenantId: TENANT_A },
      });
      assert.equal(r.status, 404); // reached the service; not 401/403
    });
    assert.equal(filters[0].tenantId, TENANT_B);
  } finally {
    Payment.findOne = orig;
  }
});

test("C06-5 user JWT + spoofed x-internal-request does NOT get the internal grant", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/payments/reconcile", {
      headers: { authorization: PORTAL_A, "x-internal-request": "true", "x-tenant-id": TENANT_A },
      body: { paymentIntentId: "pi_A" },
    });
    assert.equal(r.status, 403);
  });
});

test("C06-6 request without paymentIntentId is rejected by validation (finance user)", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/payments/reconcile", {
      headers: { authorization: FINANCE_A },
      body: { payment: { amount: 1, status: "succeeded" } },
    });
    assert.equal(r.status, 400);
  });
});

// ---------------- C-07 /api/internal/members/* ----------------

test("C07-1 portal JWT cannot post an internal write-off: 403", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/internal/members/writeoff", {
      headers: { authorization: PORTAL_A },
      body: { date: "2026-01-01", docNo: "WO-X", memberId: "M-B", amount: 100 },
    });
    assert.equal(r.status, 403);
  });
});

test("C07-2 CRM user without finance write cannot post an internal write-off: 403", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/internal/members/writeoff", {
      headers: { authorization: CRM_NO_FINANCE_A },
      body: {},
    });
    assert.equal(r.status, 403);
  });
});

test("C07-3 finance user passes the write-off guard (reaches controller validation -> 400)", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/internal/members/writeoff", {
      headers: { authorization: FINANCE_A },
      body: {},
    });
    assert.equal(r.status, 400);
  });
});

test("C07-4 subscription-service worker call (x-internal-request, no JWT) passes the write-off guard", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/internal/members/writeoff", {
      headers: { "x-internal-request": "true", "x-tenant-id": TENANT_A },
      body: {},
    });
    assert.equal(r.status, 400);
  });
});

test("C07-5 portal JWT cannot read reminder eligibility (bulk + single): 403", async () => {
  await withServer(async (base) => {
    const bulk = await post(base, "/api/internal/members/reminder-eligibility-bulk", {
      headers: { authorization: PORTAL_A },
      body: { memberIds: ["M-B"] },
    });
    assert.equal(bulk.status, 403);
    const single = await fetch(`${base}/api/internal/members/M-B/reminder-eligibility`, {
      headers: { authorization: PORTAL_A },
    });
    assert.equal(single.status, 403);
  });
});

test("C07-6 CRM user with accounts.reports:read and internal worker both pass the eligibility guard", async () => {
  const reportsReader = bearer({ tenantId: TENANT_A, roles: ["MO"], permissions: ["accounts.reports:read"] });
  await withServer(async (base) => {
    const user = await post(base, "/api/internal/members/reminder-eligibility-bulk", {
      headers: { authorization: reportsReader },
      body: { memberIds: [] },
    });
    assert.equal(user.status, 400); // controller validation, guard passed
    const worker = await post(base, "/api/internal/members/reminder-eligibility-bulk", {
      headers: { "x-internal-request": "true", "x-tenant-id": TENANT_A },
      body: { memberIds: [] },
    });
    assert.equal(worker.status, 400);
  });
});

test("C07-7 no credentials at all: 401", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/api/internal/members/writeoff", { body: {} });
    assert.equal(r.status, 401);
  });
});

// ---------------- H-15 unauthenticated idempotency cache clear ----------------

test("H15-1 POST /health/idempotency (unauthenticated cache clear) is gone; GET stats remains", async () => {
  await withServer(async (base) => {
    const r = await post(base, "/health/idempotency", { body: { action: "clear_cache" } });
    assert.equal(r.status, 404);
    const g = await fetch(`${base}/health/idempotency`);
    assert.equal(g.status, 200);
  });
});
