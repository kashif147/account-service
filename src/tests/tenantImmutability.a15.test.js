// Phase A / A15 - the 9 tenantScoped ledger models: tenantId is immutable on documents too (the query
// guards in tenantScoped.plugin.js already refuse tenant changes in updates/bulkWrite). No database:
// `hydrate` gives an existing document and the save guard fails before any connection is needed.
//
//   node --test src/tests/tenantImmutability.a15.test.js
import test from "node:test";
import assert from "node:assert";
import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const MODELS = [
  "balance",
  "coa",
  "creditNote",
  "glTransaction",
  "journal",
  "journalAdjustment",
  "materializedBalance",
  "reconciliationRecord",
  "reportSnapshot",
];

for (const name of MODELS) {
  test(`${name}: tenantId immutable; save keeps the original; a forced change cannot be saved`, async () => {
    const mod = await import(`../models/${name}.model.js`);
    const Model = mod.default || Object.values(mod).find((v) => v && v.modelName);
    assert.ok(Model && Model.schema, `${name} model export`);
    assert.strictEqual(Model.schema.path("tenantId").options.immutable, true);

    const doc = Model.hydrate({ _id: new mongoose.Types.ObjectId(), tenantId: A });
    doc.tenantId = B;
    assert.strictEqual(doc.tenantId, A);
    doc.tenantId = undefined;
    assert.strictEqual(doc.tenantId, A);
    assert.strictEqual(doc.isModified("tenantId"), false);

    doc.set("tenantId", B, { overwriteImmutable: true });
    await assert.rejects(doc.save({ validateBeforeSave: false }), (e) => e && e.code === "TENANT_SCOPE_REQUIRED" && /must not change tenantId/.test(e.message));
  });
}
