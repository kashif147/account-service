// Phase 1A PILOT adoption — account-service journal router (WARN MODE).
//
// (A) behaviour of the warn-mode guard account-service now consumes from
//     @membership/policy-middleware@1d4a3b9 (identical to the exported
//     `tenantContextWarn` in src/middlewares/auth.js), and
// (B) that the JOURNAL-router pilot is wired correctly and scoped: journal
//     authenticated routes run ensureAuthenticated -> tenantContextWarn ->
//     authorization/controller; the manual-payment S2S routes stay excluded;
//     and no other router was touched.
//
// account-service is ESM; jest@25 here is unreliable (node:-scheme resolution),
// so this runs under node:test:  node --test src/tests/tenantContext.adoption.test.js
//
// EASYAUTH SAFETY: WARN mode does NOT make the EasyAuth (x-ms-client-principal)
// tenant cryptographically trusted — the guard only observes/re-pins whatever
// ensureAuthenticated established. EasyAuth remains an ENFORCE-mode blocker.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-tenantctx-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const policyMw = await import("@membership/policy-middleware");
const { tenantContextMiddleware, resolveTenantContext } = policyMw;

const TRUSTED = "68cbf7806080b4621d469d34"; // INMO Tenant._id
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantContextWarn = tenantContextMiddleware({ mode: "warn" });

function gatewayReq(overrides = {}) {
  return {
    method: "GET",
    url: "/api/journal",
    originalUrl: "/api/journal",
    headers: {
      "x-jwt-verified": "true",
      "x-auth-source": "gateway",
      "x-user-id": "U1",
      "x-tenant-id": TRUSTED,
      ...(overrides.headers || {}),
    },
    ctx: overrides.ctx !== undefined ? overrides.ctx : { tenantId: TRUSTED, userId: "U1" },
    tenantId: overrides.tenantId,
    body: overrides.body,
    query: overrides.query,
    params: overrides.params,
  };
}
function mkRes() {
  const r = { statusCode: null, _statusCalls: [] };
  r.status = (c) => (r.statusCode = c, r._statusCalls.push(c), r);
  r.json = () => r;
  return r;
}
function run(req) {
  const res = mkRes();
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (s) => (chunks.push(typeof s === "string" ? s : s.toString()), true);
  let nextCount = 0;
  try {
    tenantContextWarn(req, res, () => (nextCount += 1));
  } finally {
    process.stdout.write = orig;
  }
  const rows = chunks
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { req, res, nextCount, rows };
}
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// ---- (A) behaviour ----
test("1 policy package exports tenantContextMiddleware", () => {
  assert.equal(typeof policyMw.tenantContextMiddleware, "function");
});
test("2 policy package exports resolveTenantContext", () => {
  assert.equal(typeof resolveTenantContext, "function");
});
test("3 WARN keeps trusted tenant authoritative (pins req.tenantId), next() called", () => {
  const { req, nextCount, res } = run(gatewayReq());
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
  assert.equal(res.statusCode, null);
});
test("4 query mismatch cannot override trusted tenant", () => {
  const { req, nextCount } = run(gatewayReq({ query: { tenantId: OTHER } }));
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
});
test("5 body mismatch cannot override trusted tenant", () => {
  const { req, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } }));
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
});
test("6 mismatch does not 403", () => {
  const { res, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } }));
  assert.ok(!res._statusCalls.includes(403));
  assert.equal(res.statusCode, null);
  assert.equal(nextCount, 1);
});
test("7 mismatch log carries eventType/mode/outcome/trustedTenantId/suppliedSources", () => {
  const { rows } = run(gatewayReq({ query: { tenantId: OTHER } }));
  const row = rows.find((r) => r.eventType === "TenantContextMismatch");
  assert.ok(row, "TenantContextMismatch emitted");
  assert.equal(row.mode, "warn");
  assert.equal(row.outcome, "ignored");
  assert.equal(row.trustedTenantId, TRUSTED);
  assert.ok(row.suppliedSources.includes("query"));
});
test("8 matching supplied tenant produces no mismatch log", () => {
  const { rows, nextCount } = run(gatewayReq({ body: { tenantId: TRUSTED } }));
  assert.equal(rows.find((r) => r.eventType === "TenantContextMismatch"), undefined);
  assert.equal(nextCount, 1);
});

// ---- (B) wiring ----
test("9 journal authenticated routes run ensureAuthenticated -> tenantContextWarn -> authz/controller", () => {
  const auth = read(path.join("middlewares", "auth.js"));
  // composed chain defined in the documented order
  assert.match(
    auth,
    /ensureAuthenticatedWithTenantContext\s*=\s*\[\s*ensureAuthenticated\s*,\s*tenantContextWarn\s*,?\s*\]/s
  );
  const jr = read(path.join("routes", "journal.routes.js"));
  // each authenticated route spreads the composed chain BEFORE requirePermission
  const idxChain = jr.indexOf("...ensureAuthenticatedWithTenantContext,");
  const idxPerm = jr.indexOf('requirePermission("accounts.journals"');
  assert.ok(idxChain > -1 && idxPerm > idxChain);
  // 19 authenticated routes adopted
  const spreads = (jr.match(/\.\.\.ensureAuthenticatedWithTenantContext,/g) || []).length;
  assert.equal(spreads, 19);
});
test("10 manual-payment S2S routes remain excluded (internalOrAuthenticated, no guard)", () => {
  const jr = read(path.join("routes", "journal.routes.js"));
  for (const p of ["/events/manual-payment", "/events/manual-payment/post", "/events/manual-payment/void"]) {
    const i = jr.indexOf(`"${p}"`);
    assert.ok(i > -1, `route ${p} present`);
    // the middleware line right after the path must be internalOrAuthenticated, not the guard
    const after = jr.slice(i, i + 120);
    assert.match(after, /internalOrAuthenticated/);
    assert.ok(!after.includes("ensureAuthenticatedWithTenantContext"), `${p} must not carry the guard`);
  }
  assert.equal((jr.match(/\n\s*internalOrAuthenticated,/g) || []).length, 3);
});
test("11 no non-journal router was modified (none reference the guard)", () => {
  const dir = path.join(__dirname, "..", "routes");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".routes.js") || f === "journal.routes.js") continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(
      !src.includes("tenantContextWarn") && !src.includes("ensureAuthenticatedWithTenantContext"),
      `${f} must not reference the tenant guard`
    );
  }
});
test("12 mode remains warn", () => {
  const auth = read(path.join("middlewares", "auth.js"));
  assert.match(auth, /tenantContextMiddleware\(\{\s*mode:\s*"warn"\s*\}\)/);
  assert.ok(!/mode:\s*"enforce"/.test(auth), "no enforce mode");
});
