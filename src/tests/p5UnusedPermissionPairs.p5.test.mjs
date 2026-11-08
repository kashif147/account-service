// PDP rollout P5 regression check (blocker 1): these 12 resource:action pairs are held by MO / REO outside their
// P8 targets and, today, NO route evaluates them through the PDP - so enabling the P5 audience rule cannot make
// them usable. This source guard fails if any account-service route or middleware starts asking the PDP for one
// of them; that would reopen P5 blocker 1 (decide the guard first - see the P5 blocker plan).
// node --test src/tests/p5UnusedPermissionPairs.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const P5_UNUSED_PAIRS = Object.freeze([
  "application:delete",
  "changeofcategory:create", "changeofcategory:delete", "changeofcategory:write",
  "subscriptions:create", "subscriptions:delete", "subscriptions:write",
  "transferrequests:create", "transferrequests:delete", "transferrequests:write",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "tests" && e.name !== "node_modules") walk(p, out); }
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Any PDP-style check: requirePermission / requireCrm / requirePortalOrCrm / evaluate*(resource, action).
const CALL_RE = /\b(requirePermission|requireCrm\w*|requirePortal\w*|evaluate\w*|hasPermission)\s*\(\s*["'`]([\w.-]+)["'`]\s*,\s*["'`]([\w-]+)["'`]/g;
const LITERAL_RE = /["'`]([a-zA-Z.-]+):(create|read|write|delete)["'`]/g;

test("the pinned list is the 12 unused out-of-target pairs (10 distinct; changeOfCategory:create and transferRequests:create/write are both MO and REO)", () => {
  assert.equal(P5_UNUSED_PAIRS.length, 10);
});

test("no account-service route or middleware evaluates one of the P5-unused pairs", () => {
  const hits = [];
  for (const dir of ["src/routes", "src/middlewares", "src/helpers", "src/controllers", "src/services"]) {
    const abs = path.join(ROOT, path.relative("src", dir));
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(CALL_RE)) {
        const pair = `${m[2]}:${m[3]}`.toLowerCase();
        if (P5_UNUSED_PAIRS.includes(pair)) hits.push(`${path.relative(ROOT, f)} ${m[1]}(${m[2]}, ${m[3]})`);
      }
      for (const m of src.matchAll(LITERAL_RE)) {
        const pair = `${m[1]}:${m[2]}`.toLowerCase();
        if (P5_UNUSED_PAIRS.includes(pair)) hits.push(`${path.relative(ROOT, f)} literal ${m[0]}`);
      }
    }
  }
  assert.deepEqual(hits, [], `P5 blocker 1 reopened - add the guard before wiring: ${hits.join("; ")}`);
});
