// PDP rollout P3 (Q2): bank-sensitive data on the direct-debit run routes, over the REAL app router.
// No database (mongoose buffering off; the DirectDebitRun / DirectDebitRunItem statics the routes touch are
// faked) and no live services (the DD-run routes never call the PDP: finance gates and the bank-data check
// are local token checks).
//
// Decision O5 = mask: finance read keeps list / get / items with masked bank fields; plaintext and the
// PAIN.008 download need payments.bank:read (or ASU's computed "*").
//
// node:test (jest here cannot load mongoose / the app): npm run test:node -- src/tests/directDebitBankData.p3.test.mjs
import test, { after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-p3-bank-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "p3-bank-data-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy_p3";
delete process.env.AUTH_BYPASS_ENABLED;
mongoose.set("bufferCommands", false);

// A PDP that would deny everything: proves the DD-run routes and the bank-data check never depend on it.
const pdpCalls = [];
const pdp = http.createServer((req, res) => {
  pdpCalls.push(req.url);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ success: false, decision: "DENY", reason: "TEST_PDP_DENY" }));
});
await new Promise((r) => pdp.listen(0, "127.0.0.1", r));
process.env.POLICY_SERVICE_URL = `http://127.0.0.1:${pdp.address().port}`;

const { default: app } = await import("../app.js");
const { default: DirectDebitRun } = await import("../models/directDebitRun.model.js");
const { default: DirectDebitRunItem } = await import("../models/directDebitRunItem.model.js");
const { maskIban, runForCaller, runItemForCaller, canReadBankData } = await import(
  "../helpers/bankDataAccess.js"
);

after(() => pdp.close());

const SECRET = process.env.JWT_SECRET;
const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_ID = "65f000000000000000000001";
// Synthetic example-format test IBANs / BICs (not real accounts).
const CREDITOR_IBAN = "IE29AIBK93115212345678";
const DEBTOR_IBAN = "IE64IRCE92050112345678";
const CREDITOR_BIC = "AIBKIE2DXXX";
const DEBTOR_BIC = "IRCEIE2DXXX";

function bearer({ userType = "CRM", roles = [], permissions = [], id = "staff" }) {
  return `Bearer ${jwt.sign({ id, sub: id, tenantId: TENANT_A, userType, roles, permissions }, SECRET, { expiresIn: "1h" })}`;
}

const FIN_READ = bearer({ id: "fin-read", roles: ["AA"], permissions: ["payments:read"] });
const FIN_READ_BANK = bearer({ id: "fin-bank", roles: ["AA"], permissions: ["payments:read", "payments.bank:read"] });
const FIN_READ_WILDCARD_PAYMENTS = bearer({ id: "fin-star", roles: ["AA"], permissions: ["payments:*", "accounts.admin:*", "admin"] });
const ASU = bearer({ id: "asu", roles: ["ASU"], permissions: ["*"] });
const AM_WRITE = bearer({ id: "am", roles: ["AM"], permissions: ["payments:read", "payments:write"] });
const AM_WRITE_BANK = bearer({ id: "am-bank", roles: ["AM"], permissions: ["payments:read", "payments:write", "payments.bank:read"] });
const PORTAL_BANK = bearer({ userType: "PORTAL", id: "member", roles: ["MEMBER"], permissions: ["payments:read", "payments.bank:read"] });

function runDoc(extra = {}) {
  return {
    _id: RUN_ID,
    tenantId: TENANT_A,
    runNo: "DD-0001",
    status: "DRAFT",
    collectionDate: new Date("2026-12-01"),
    creditorSnapshot: { name: "Org", oin: "IE00ZZZ000000", iban: CREDITOR_IBAN, bic: CREDITOR_BIC },
    pain008: { fileName: "DD-0001-pain008.xml", blobPath: null, downloadUrl: "https://blob.example/x.xml" },
    totals: { itemCount: 1 },
    ...extra,
  };
}
const ITEM = {
  _id: "65f000000000000000000002",
  tenantId: TENANT_A,
  runId: RUN_ID,
  memberId: "M-1",
  amountEur: 10,
  mandateSnapshot: { umr: "UMR-1", debtorName: "Test Debtor", debtorIban: DEBTOR_IBAN, debtorBic: DEBTOR_BIC },
};

function q(result) {
  const p = Promise.resolve(result);
  const o = {
    lean: () => o, select: () => o, sort: () => o, skip: () => o, limit: () => o,
    then: (a, b) => p.then(a, b), catch: (b) => p.catch(b),
  };
  return o;
}

async function withStubs(fn) {
  const saved = {
    rf: DirectDebitRun.findOne, rl: DirectDebitRun.find, rc: DirectDebitRun.countDocuments,
    il: DirectDebitRunItem.find, ic: DirectDebitRunItem.countDocuments,
  };
  DirectDebitRun.findOne = () => q({ ...runDoc(), save: async () => {} });
  DirectDebitRun.find = () => q([runDoc()]);
  DirectDebitRun.countDocuments = () => Promise.resolve(1);
  DirectDebitRunItem.find = () => q([JSON.parse(JSON.stringify(ITEM))]);
  DirectDebitRunItem.countDocuments = () => Promise.resolve(1);
  try {
    return await fn();
  } finally {
    DirectDebitRun.findOne = saved.rf;
    DirectDebitRun.find = saved.rl;
    DirectDebitRun.countDocuments = saved.rc;
    DirectDebitRunItem.find = saved.il;
    DirectDebitRunItem.countDocuments = saved.ic;
  }
}

async function call(method, url, { auth, body } = {}) {
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  try {
    const h = { "content-type": "application/json" };
    if (auth) h.authorization = auth;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: h,
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, code: json?.code ?? json?.error?.code ?? null, json, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const MASKED_CREDITOR = maskIban(CREDITOR_IBAN);
const MASKED_DEBTOR = maskIban(DEBTOR_IBAN);

function assertNoPlaintext(r, label) {
  assert.ok(!r.text.includes(CREDITOR_IBAN), `${label}: creditor IBAN leaked`);
  assert.ok(!r.text.includes(DEBTOR_IBAN), `${label}: debtor IBAN leaked`);
  assert.ok(!r.text.includes(CREDITOR_BIC), `${label}: creditor BIC leaked`);
  assert.ok(!r.text.includes(DEBTOR_BIC), `${label}: debtor BIC leaked`);
  assert.ok(!r.text.includes("blob.example"), `${label}: PAIN.008 blob URL leaked`);
}

// ---------------- helpers ----------------

test("maskIban uses the profile-service display format (first 4 + **** + last 4)", () => {
  assert.equal(maskIban(CREDITOR_IBAN), "IE29****5678");
  assert.equal(maskIban(" ie29 aibk 9311 5212 3456 78 "), "IE29****5678");
  assert.equal(maskIban("SHORT"), "****");
  assert.equal(maskIban(""), "");
});

test("canReadBankData: literal payments.bank:read or * on a CRM token only; payments:* / admin / accounts.admin:* do not unlock it", () => {
  const req = (userType, permissions) => ({ user: { userType, permissions } });
  assert.equal(canReadBankData(req("CRM", ["payments.bank:read"])), true);
  assert.equal(canReadBankData(req("CRM", ["*"])), true);
  assert.equal(canReadBankData(req("CRM", ["payments:read", "payments:*", "admin", "accounts.admin:*", "payments.bank:write"])), false);
  assert.equal(canReadBankData(req("CRM", ["PAYMENTS.BANK_READ"])), false); // tokens carry resource:action, not the CODE
  assert.equal(canReadBankData(req("PORTAL", ["payments.bank:read", "*"])), false);
  assert.equal(canReadBankData(req(undefined, ["payments.bank:read"])), false);
  assert.equal(canReadBankData({}), false);
  // never from the query string / body
  assert.equal(canReadBankData({ user: { userType: "CRM", permissions: [] }, query: { permissions: ["*"] }, body: { permissions: ["*"] } }), false);
});

test("runForCaller / runItemForCaller do not mutate the source document", () => {
  const run = runDoc();
  const item = JSON.parse(JSON.stringify(ITEM));
  const r = runForCaller(run, false);
  const i = runItemForCaller(item, false);
  assert.equal(r.creditorSnapshot.iban, MASKED_CREDITOR);
  assert.equal(i.mandateSnapshot.debtorIban, MASKED_DEBTOR);
  assert.equal(run.creditorSnapshot.iban, CREDITOR_IBAN);
  assert.equal(item.mandateSnapshot.debtorIban, DEBTOR_IBAN);
  assert.equal(runForCaller(run, true), run);
});

// ---------------- read routes ----------------

test("GET list / get / items with finance read only: masked IBANs, no BIC, no blob URL; OIN and names kept", async () => {
  await withStubs(async () => {
    const list = await call("GET", "/api/direct-debit-runs", { auth: FIN_READ });
    assert.equal(list.status, 200);
    assertNoPlaintext(list, "list");
    assert.equal(list.json.data.items[0].creditorSnapshot.iban, MASKED_CREDITOR);
    assert.equal(list.json.data.items[0].creditorSnapshot.oin, "IE00ZZZ000000");
    assert.equal(list.json.data.items[0].creditorSnapshot.bic, undefined);

    const one = await call("GET", `/api/direct-debit-runs/${RUN_ID}`, { auth: FIN_READ });
    assert.equal(one.status, 200);
    assertNoPlaintext(one, "get");
    assert.equal(one.json.data.run.creditorSnapshot.iban, MASKED_CREDITOR);
    assert.equal(one.json.data.run.pain008.fileName, "DD-0001-pain008.xml");

    const items = await call("GET", `/api/direct-debit-runs/${RUN_ID}/items`, { auth: FIN_READ });
    assert.equal(items.status, 200);
    assertNoPlaintext(items, "items");
    assert.equal(items.json.data.items[0].mandateSnapshot.debtorIban, MASKED_DEBTOR);
    assert.equal(items.json.data.items[0].mandateSnapshot.debtorName, "Test Debtor");
    assert.equal(items.json.data.items[0].mandateSnapshot.debtorBic, undefined);
  });
});

test("GET list / get / items: payments:* + admin + accounts.admin:* (no bank code) still masked", async () => {
  await withStubs(async () => {
    for (const url of ["/api/direct-debit-runs", `/api/direct-debit-runs/${RUN_ID}`, `/api/direct-debit-runs/${RUN_ID}/items`]) {
      const r = await call("GET", url, { auth: FIN_READ_WILDCARD_PAYMENTS });
      assert.equal(r.status, 200, url);
      assertNoPlaintext(r, url);
    }
  });
});

test("GET list / get / items with payments.bank:read (and ASU *): plaintext", async () => {
  await withStubs(async () => {
    for (const auth of [FIN_READ_BANK, ASU]) {
      const one = await call("GET", `/api/direct-debit-runs/${RUN_ID}`, { auth });
      assert.equal(one.status, 200);
      assert.equal(one.json.data.run.creditorSnapshot.iban, CREDITOR_IBAN);
      assert.equal(one.json.data.run.creditorSnapshot.bic, CREDITOR_BIC);
      const list = await call("GET", "/api/direct-debit-runs", { auth });
      assert.equal(list.json.data.items[0].creditorSnapshot.iban, CREDITOR_IBAN);
      const items = await call("GET", `/api/direct-debit-runs/${RUN_ID}/items`, { auth });
      assert.equal(items.json.data.items[0].mandateSnapshot.debtorIban, DEBTOR_IBAN);
      assert.equal(items.json.data.items[0].mandateSnapshot.debtorBic, DEBTOR_BIC);
    }
  });
});

test("GET download-pain008: finance read without the bank code -> 403 BANK_DATA_PERMISSION_REQUIRED", async () => {
  await withStubs(async () => {
    for (const auth of [FIN_READ, FIN_READ_WILDCARD_PAYMENTS, AM_WRITE]) {
      const r = await call("GET", `/api/direct-debit-runs/${RUN_ID}/download-pain008`, { auth });
      assert.equal(r.status, 403);
      assert.equal(r.code, "BANK_DATA_PERMISSION_REQUIRED");
    }
  });
});

test("GET download-pain008: with payments.bank:read / ASU passes both gates (stub run has no file -> 404)", async () => {
  await withStubs(async () => {
    for (const auth of [FIN_READ_BANK, ASU]) {
      const r = await call("GET", `/api/direct-debit-runs/${RUN_ID}/download-pain008`, { auth });
      assert.equal(r.status, 404);
    }
  });
});

test("portal caller holding payments.bank:read is still refused by the finance gate (CRM_ONLY), before the bank check", async () => {
  await withStubs(async () => {
    for (const url of [`/api/direct-debit-runs/${RUN_ID}`, `/api/direct-debit-runs/${RUN_ID}/download-pain008`]) {
      const r = await call("GET", url, { auth: PORTAL_BANK });
      assert.equal(r.status, 403, url);
      assert.equal(r.code, "CRM_ONLY", url);
    }
  });
});

// ---------------- write routes ----------------

test("write route response (cancel): creditor snapshot masked without the bank code, plaintext with it", async () => {
  await withStubs(async () => {
    const masked = await call("POST", `/api/direct-debit-runs/${RUN_ID}/cancel`, { auth: AM_WRITE, body: { reason: "test" } });
    assert.equal(masked.status, 200);
    assertNoPlaintext(masked, "cancel");
    assert.equal(masked.json.data.run.creditorSnapshot.iban, MASKED_CREDITOR);
    assert.equal(masked.json.data.run.status, "CANCELLED");

    const plain = await call("POST", `/api/direct-debit-runs/${RUN_ID}/cancel`, { auth: AM_WRITE_BANK, body: { reason: "test" } });
    assert.equal(plain.status, 200);
    assert.equal(plain.json.data.run.creditorSnapshot.iban, CREDITOR_IBAN);
  });
});

test("generate-pain008 / prepare: finance writer without the bank code -> 403 BANK_DATA_PERMISSION_REQUIRED; with it the gate passes", async () => {
  await withStubs(async () => {
    for (const action of ["generate-pain008", "prepare"]) {
      const r = await call("POST", `/api/direct-debit-runs/${RUN_ID}/${action}`, { auth: AM_WRITE });
      assert.equal(r.status, 403, action);
      assert.equal(r.code, "BANK_DATA_PERMISSION_REQUIRED", action);
    }
    // generate with the code: past both gates; the stub run is DRAFT so the service refuses with 400 (not 401/403)
    const g = await call("POST", `/api/direct-debit-runs/${RUN_ID}/generate-pain008`, { auth: AM_WRITE_BANK });
    assert.ok(g.status !== 401 && g.status !== 403, `generate with code: ${g.status} ${g.code}`);
    // a bank reader without finance write is still refused by the finance-write gate
    const nw = await call("POST", `/api/direct-debit-runs/${RUN_ID}/generate-pain008`, { auth: FIN_READ_BANK });
    assert.equal(nw.status, 403);
    assert.notEqual(nw.code, "BANK_DATA_PERMISSION_REQUIRED");
  });
});

test("prepare upstream: no direct-debit profiles -> no mandates-for-prepare call (profile now refuses an empty list)", async () => {
  const { fetchDirectDebitMandates } = await import("../services/directDebitUpstream.client.js");
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not be called"); };
  try {
    assert.deepEqual(await fetchDirectDebitMandates({ headers: {} }, []), []);
    assert.deepEqual(await fetchDirectDebitMandates({ headers: {} }, ["", null]), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("the DD-run routes made no PDP call (local gates only)", () => {
  assert.equal(pdpCalls.length, 0);
});
