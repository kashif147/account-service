// Owner decision (2026-11-01): the account ownership migration changes OWNERSHIP ONLY. Each tenant-owned
// default must reproduce the currently effective live shared row exactly - columns (keys and order),
// labels, filters, visible filters, name and flags. Only tenant ownership / system metadata may differ.
// Fixture: stored configuration of the live DEV shared rows (field presence preserved).
// Run: node --test src/tests/tenantGridDefaults.parity.node.test.cjs
const { test } = require("node:test");
const assert = require("node:assert");
const g = require("../services/tenantGridDefaults.cjs");
const live = require("./fixtures/liveSharedGridDefaults.dev-20261101.json");

const TYPES = ["creditnotes", "journaladjustments", "onlinepayment", "reconciliation"];
const OWNERSHIP_AND_SYSTEM_KEYS = ["_id", "tenantId", "userId", "createdAt", "updatedAt", "__v", "meta", "systemDefault"];
const TENANT = "68cbf7806080b4621d469d34";
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !OWNERSHIP_AND_SYSTEM_KEYS.includes(k)));
const built = (type) => g.buildTenantDefault(g.loadCanonical(), TENANT, type, new Date(0), undefined);

test("manifest covers exactly the four live shared types, no code-only types", () => {
  assert.deepStrictEqual(Object.keys(g.loadCanonical().templates).sort(), [...TYPES].sort());
  assert.deepStrictEqual(Object.keys(live.rows).sort(), [...TYPES].sort());
});

for (const type of TYPES) {
  test(`${type}: tenant-owned copy is semantically identical to the live shared row`, () => {
    const stored = live.rows[type].stored;
    const doc = built(type);
    assert.deepStrictEqual(doc.columns, stored.columns, "column keys and order");
    assert.deepStrictEqual(doc.columnLabels, stored.columnLabels || {}, "labels");
    assert.deepStrictEqual(doc.filters, stored.filters || {}, "filters (absent = none)");
    assert.deepStrictEqual(doc.visibleFilters, stored.visibleFilters || [], "visible filters (absent = none)");
    assert.strictEqual(doc.name, stored.name);
    assert.strictEqual(doc.isDefault, stored.isDefault === true);
    assert.strictEqual(doc.pinned, stored.pinned === true);
    assert.strictEqual(doc.templateType, stored.templateType);
  });

  test(`${type}: through the real Template model the copy hydrates exactly like the live row (only ownership/system metadata differs)`, async () => {
    const Template = (await import("../models/template.model.js")).default;
    const asServed = (raw) => strip(Template.hydrate({ _id: "600000000000000000000001", ...raw }).toObject());
    const liveServed = asServed(live.rows[type].stored);
    const copyServed = asServed(strip(built(type)));
    assert.deepStrictEqual(copyServed, liveServed);
  });
}

test("no CRM-manifest-only changes leak in (no Actions/Created By/Doc No/Created At additions, no relabels)", () => {
  const c = g.loadCanonical().templates;
  assert.ok(!c.creditnotes.columns.includes("_actions") && !c.creditnotes.columns.includes("createdBy"));
  assert.ok(!c.journaladjustments.columns.includes("_actions") && !c.journaladjustments.columns.includes("createdAt"));
  assert.ok(!c.onlinepayment.columns.includes("_actions"));
  assert.notStrictEqual(c.journaladjustments.columnLabels.docNo, "Adjustment reference");
  assert.notStrictEqual(c.onlinepayment.columnLabels.category, "Membership Category");
  for (const type of TYPES) assert.deepStrictEqual(c[type].filters, {});
});
