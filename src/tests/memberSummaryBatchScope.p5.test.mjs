// PDP rollout P5: POST /reports/members/summary-batch stays MEMBER-scoped (accounts.member:read), never
// tenant-wide. The controller runs against recording stubs of its models (no database):
//   - the member list is explicit and bounded: empty / all-blank / > 5000 ids -> 400 before ANY query;
//   - no trusted tenant -> 401 before any query; a tenant in the body is ignored;
//   - every query is bound to the verified tenant AND to exactly the requested (normalised) member ids.
// node --test src/tests/memberSummaryBatchScope.p5.test.mjs
import test, { beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-p5-batch-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { default: CoA } = await import("../models/coa.model.js");
const { default: MatBal } = await import("../models/materializedBalance.model.js");
const { default: GL } = await import("../models/glTransaction.model.js");
const { memberSummaryBatch } = await import("../controllers/reports.controller.js");

const TENANT = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "cccccccccccccccccccccccc";
let calls;
const chain = (v) => { const o = { select: () => o, lean: async () => v, sort: () => o }; return o; };
beforeEach(() => {
  calls = [];
  CoA.find = (f) => { calls.push(["CoA.find", f]); return chain([{ code: "1400" }]); };
  MatBal.find = (f) => { calls.push(["MatBal.find", f]); return chain([]); };
  GL.aggregate = async (p) => { calls.push(["GL.aggregate", p[0].$match]); return []; };
});

const run = async (body, ctx = { tenantId: TENANT }) => {
  const req = { ctx, body, user: { userType: "CRM", tenantId: ctx.tenantId } };
  let err = null, payload = null;
  const res = { status() { return this; }, json(b) { payload = b; return this; }, success(b) { payload = b; return this; } };
  await memberSummaryBatch(req, res, (e) => { err = e; });
  return { err, payload };
};
const status = (e) => e && (e.status || e.statusCode);

test("empty, missing, all-blank or non-array memberIds -> 400 and NO query (never a tenant-wide read)", async () => {
  for (const body of [{}, { memberIds: [] }, { memberIds: ["", "  ", null] }, { memberIds: "M-1" }, { memberIds: { $ne: null } }]) {
    const { err } = await run(body);
    assert.equal(status(err), 400, JSON.stringify(body));
    assert.equal(calls.length, 0, `no query for ${JSON.stringify(body)}`);
  }
});

test("more than 5000 distinct ids -> 400 and NO query (bounded)", async () => {
  const ids = Array.from({ length: 5001 }, (_, i) => `M-${i}`);
  const { err } = await run({ memberIds: ids });
  assert.equal(status(err), 400);
  assert.equal(calls.length, 0);
});

test("no verified tenant -> 401 and NO query; a tenant in the body is never used", async () => {
  const { err } = await run({ memberIds: ["M-1"], tenantId: TENANT }, {});
  assert.equal(status(err), 401);
  assert.equal(calls.length, 0);
});

test("every query is bound to the verified tenant and exactly the requested ids (deduplicated, trimmed)", async () => {
  await run({ memberIds: [" M-1", "M-2", "M-1", ""], tenantId: OTHER, scope: "all" });
  assert.ok(calls.length >= 4, `expected CoA + MatBal + 2 GL queries, got ${calls.length}`);
  for (const [name, f] of calls) {
    assert.equal(f.tenantId, TENANT, `${name} tenant`);
  }
  const mat = calls.find(([n]) => n === "MatBal.find")[1];
  assert.deepEqual(mat.memberId, { $in: ["M-1", "M-2"] });
  for (const [, m] of calls.filter(([n]) => n === "GL.aggregate")) {
    assert.deepEqual(m["entries.memberId"], { $in: ["M-1", "M-2"] });
  }
});
