// Shared test suite for tenant-owned grid system defaults (insert-only migration + ensureTenantDefaults).
// Runs against a REAL throwaway mongod (MONGOD_BIN or `mongod` on PATH); the caller skips it when no
// binary is available. Framework-neutral: the caller passes its test/hook functions (jest or node:test).
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");

const { ObjectId } = mongoose.mongo;

const mongodBin = () =>
  process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();

const A = "68cbf7806080b4621d469d34";
const B = "68ebf0806080b4621d461ae0";
const C = "68f3f0806080b4621d46fd57";
const USER = "700000000000000000000001";

/**
 * @param {object} hooks { test, beforeAll, afterAll, beforeEach }
 * @param {object} opts  { g: module, cli: migration module, types: expected canonical types }
 */
function registerTenantGridDefaultsSuite({ test, beforeAll, afterAll, beforeEach }, { g, cli, types }) {
  let mongod;
  let dbPath;
  const outDirs = [];
  const coll = () => mongoose.connection.db.collection(g.COLLECTION);
  const canonical = () => g.loadCanonical();
  const T0 = types[0];
  const outDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tgd-out-"));
    outDirs.push(d);
    return d;
  };
  const plan = async (tenants) => {
    const p = await g.planTenantDefaults(coll(), tenants, canonical());
    p.canonicalSource = { version: canonical().version };
    return p;
  };
  const apply = async (tenants, runId) => cli.applyMigration(coll(), await plan(tenants), { outDir: outDir(), runId, dbName: "x-dev" });
  const allHashes = async () => (await coll().find({}).sort({ _id: 1 }).toArray()).map((d) => g.docHash(d));
  const sharedRow = (type, extra = {}) => ({
    name: "System default", templateType: type, tenantId: null, systemDefault: true, isDefault: false, pinned: false,
    columns: ["legacyCol"], columnLabels: { legacyCol: "Legacy" }, filters: {}, visibleFilters: [],
    meta: { deleted: false, deletedAt: null }, createdAt: new Date("2026-05-30T00:00:00Z"), updatedAt: new Date("2026-05-30T00:00:00Z"), ...extra,
  });
  const userView = (extra = {}) => ({
    name: "My view", templateType: T0, tenantId: A, userId: USER, systemDefault: false, isDefault: true, pinned: false,
    columns: ["b", "a"], columnLabels: { a: "A" }, filters: { s: { operator: "equal_to", values: ["x"] } }, visibleFilters: ["S"],
    meta: { deleted: false, deletedAt: null }, createdAt: new Date("2026-08-06T00:00:00Z"), updatedAt: new Date("2026-08-06T00:00:00Z"), ...extra,
  });

  beforeAll(async () => {
    const bin = mongodBin();
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
      srv.on("error", reject);
    });
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "tgd-mongod-"));
    mongod = spawn(bin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/tgd-test`, { serverSelectionTimeoutMS: 500 });
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (mongoose.connection.readyState !== 1) throw new Error("throwaway mongod did not start");
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) mongod.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const d of [dbPath, ...outDirs]) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await coll().deleteMany({});
    await coll().dropIndexes().catch(() => {});
    await coll().insertMany([
      ...types.map((t) => sharedRow(t)),
      userView(),
      userView({ name: null, columns: [], columnLabels: undefined, filters: undefined, visibleFilters: [] }),
      userView({ meta: { deleted: true, deletedAt: new Date() } }),
    ]);
  });

  test("canonical manifest: versioned, exactly the expected types", () => {
    const c = canonical();
    assert.ok(Number.isInteger(c.version) && c.version >= 1);
    assert.deepStrictEqual(Object.keys(c.templates).sort(), [...types].sort());
    assert.ok(c.source && typeof c.source === "object");
  });

  test("tenant ids are explicit and validated", () => {
    assert.throws(() => g.parseTenantIds(""), /required/);
    assert.throws(() => g.parseTenantIds("MULTIAUTH"), /invalid internal tenant id/);
    assert.throws(() => g.parseTenantIds(`${A},${A}`), /duplicate/);
    assert.deepStrictEqual(g.parseTenantIds(` ${A},${B} `), [A, B]);
  });

  test("DEV-only target guard", () => {
    assert.throws(() => cli.assertDevTarget("issue-service", { apply: false }), /not a DEV database/);
    assert.throws(() => cli.assertDevTarget("x-dev", { apply: true }), /requires --expect-db/);
    assert.throws(() => cli.assertDevTarget("x-dev", { apply: true, expectDb: "y-dev" }), /--expect-db/);
    assert.doesNotThrow(() => cli.assertDevTarget("x-dev", { apply: true, expectDb: "x-dev" }));
  });

  test("dry run writes nothing; every tenant x canonical type is planned", async () => {
    const hashes = await allHashes();
    const p = await plan([A, B, C]);
    assert.strictEqual(p.inserts, 3 * types.length);
    assert.deepStrictEqual(p.anomalies, []);
    for (const t of [A, B, C]) assert.deepStrictEqual(p.items.filter((i) => i.tenantId === t).map((i) => i.templateType), [...types]);
    const idx = await g.inspectIndex(coll());
    assert.strictEqual(idx.state, "absent");
    assert.deepStrictEqual(await allHashes(), hashes);
  });

  test("apply inserts each missing default once with the canonical shape; a re-run is a no-op", async () => {
    const r = await apply([A], "r1");
    assert.strictEqual(r.ledger.status, "applied");
    assert.strictEqual(r.ledger.inserted.length, types.length);
    for (const type of types) {
      const rows = await coll().find({ tenantId: A, templateType: type, systemDefault: true, "meta.deleted": false }).toArray();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].userId, undefined);
      assert.deepStrictEqual(rows[0].columns, canonical().templates[type].columns);
      assert.deepStrictEqual(rows[0].columnLabels, canonical().templates[type].columnLabels || {});
      assert.deepStrictEqual(rows[0].filters, canonical().templates[type].filters || {});
    }
    const again = await plan([A]);
    assert.strictEqual(again.inserts, 0);
    assert.strictEqual(again.skips, types.length);
    const r2 = await apply([A], "r2");
    assert.strictEqual(r2.ledger.inserted.length, 0);
  });

  test("an existing tenant default (customised) is skipped and never changed", async () => {
    const { insertedId } = await coll().insertOne({ ...sharedRow(T0), tenantId: B, name: "B custom", columns: ["x"] });
    const before = g.docHash(await coll().findOne({ _id: insertedId }));
    const p = await plan([B]);
    const it = p.items.find((i) => i.templateType === T0);
    assert.strictEqual(it.action, "skip");
    assert.strictEqual(it.existingId, String(insertedId));
    const r = await cli.applyMigration(coll(), p, { outDir: outDir(), runId: "skip", dbName: "x-dev" });
    assert.strictEqual(r.ledger.inserted.length, types.length - 1);
    assert.deepStrictEqual(r.ledger.verification.protectedDiffs, []);
    assert.strictEqual(g.docHash(await coll().findOne({ _id: insertedId })), before);
  });

  test("user views, tenantless rows and existing tenant rows are never matched or mutated", async () => {
    await coll().insertOne({ ...sharedRow(T0), tenantId: C, name: "C own" });
    const before = await g.snapshot(coll());
    const r = await apply([A, B], "protect");
    assert.deepStrictEqual(r.ledger.verification.protectedDiffs, []);
    const after = await g.snapshot(coll());
    assert.deepStrictEqual(after.userViews, before.userViews);
    assert.deepStrictEqual(after.tenantless, before.tenantless);
    assert.strictEqual(after.tenantOwned.length, before.tenantOwned.length + 2 * types.length);
  });

  test("another tenant's default is never reused", async () => {
    await coll().insertOne({ ...sharedRow(T0), tenantId: C });
    const p = await plan([A]);
    assert.strictEqual(p.items.find((i) => i.templateType === T0).action, "insert");
  });

  test("the partial unique index blocks a second active tenant default only (string tenant ids)", async () => {
    await apply([A], "idx");
    const idx = (await coll().indexes()).find((i) => i.name === g.INDEX_NAME);
    assert.ok(idx && idx.unique === true);
    await assert.rejects(coll().insertOne({ ...sharedRow(T0), tenantId: A }), (e) => e.code === 11000);
    const base = sharedRow(T0);
    delete base.tenantId;
    const oid = new ObjectId(B);
    await coll().insertMany([
      { ...base, tenantId: null }, { ...base, tenantId: null },
      { ...base }, { ...base },
      { ...base, tenantId: "" }, { ...base, tenantId: "" },
      { ...base, tenantId: oid }, { ...base, tenantId: oid },
      { ...base, tenantId: A, meta: { deleted: true, deletedAt: new Date() } },
      userView({ templateType: T0 }),
    ]);
    const indexed = await coll().find(g.INDEX_PARTIAL).toArray();
    assert.strictEqual(indexed.length, types.length);
    assert.ok(indexed.every((d) => d.tenantId === A));
  });

  test(`ObjectId-typed tenantId rows for a requested tenant: ${g.OBJECT_ID_TENANT_ROWS}`, async () => {
    const { insertedId } = await coll().insertOne({ ...sharedRow(T0), tenantId: new ObjectId(B) });
    const p = await plan([B]);
    if (g.OBJECT_ID_TENANT_ROWS === "legacy") {
      assert.deepStrictEqual(p.anomalies, []);
      assert.deepStrictEqual(p.legacy.map((l) => l.id), [String(insertedId)]);
      const before = g.docHash(await coll().findOne({ _id: insertedId }));
      const r = await cli.applyMigration(coll(), p, { outDir: outDir(), runId: "oid", dbName: "x-dev" });
      assert.strictEqual(r.ledger.inserted.length, types.length); // string-owned equivalents inserted
      assert.strictEqual(g.docHash(await coll().findOne({ _id: insertedId })), before); // legacy row untouched
      assert.deepStrictEqual(r.ledger.verification.protectedDiffs, []);
    } else {
      assert.match(p.anomalies.join(), /store tenantId as ObjectId/);
      const hashes = await allHashes();
      await assert.rejects(cli.applyMigration(coll(), p, { outDir: outDir(), runId: "oid", dbName: "x-dev" }), /refusing to apply/);
      assert.deepStrictEqual(await allHashes(), hashes);
    }
  });

  test("pre-existing duplicate active tenant defaults block apply (nothing written)", async () => {
    await coll().insertMany([{ ...sharedRow(T0), tenantId: B }, { ...sharedRow(T0), tenantId: B }]);
    const p = await plan([B]);
    assert.match(p.anomalies.join(), /2 active tenant defaults/);
    const hashes = await allHashes();
    await assert.rejects(cli.applyMigration(coll(), p, { outDir: outDir(), runId: "dupe", dbName: "x-dev" }), /refusing to apply/);
    assert.deepStrictEqual(await allHashes(), hashes);
  });

  test("apply writes a full backup and a ledger, never overwriting an existing one", async () => {
    const dir = outDir();
    const r = await cli.applyMigration(coll(), await plan([A]), { outDir: dir, runId: "same", dbName: "x-dev" });
    const backup = mongoose.mongo.BSON.EJSON.parse(fs.readFileSync(r.backupFile, "utf8"));
    assert.strictEqual(backup.length, types.length + 3);
    assert.strictEqual(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).planned.length, types.length);
    await assert.rejects(cli.applyMigration(coll(), await plan([B]), { outDir: dir, runId: "same", dbName: "x-dev" }), /EEXIST/);
  });

  test("rollback deletes only unmodified ledger inserts; dry rollback deletes nothing", async () => {
    const r = await apply([A, B], "rb");
    const custom = r.ledger.inserted.find((x) => x.tenantId === A && x.templateType === T0);
    await coll().updateOne({ _id: new ObjectId(custom.id) }, { $set: { columns: ["changed"], updatedAt: new Date() } });
    const protectedBefore = await g.snapshot(coll());
    const dry = await cli.rollbackMigration(coll(), r.ledgerFile);
    assert.strictEqual(dry.results.filter((x) => x.action === "would-delete").length, 2 * types.length - 1);
    assert.strictEqual(await coll().countDocuments({ systemDefault: true, tenantId: { $gt: "" } }), 2 * types.length);
    const done = await cli.rollbackMigration(coll(), r.ledgerFile, { apply: true });
    assert.strictEqual(done.results.filter((x) => x.action === "deleted").length, 2 * types.length - 1);
    assert.strictEqual(done.results.find((x) => x.id === custom.id).action, "kept-modified-since-insert");
    const after = await g.snapshot(coll());
    assert.deepStrictEqual(after.userViews, protectedBefore.userViews);
    assert.deepStrictEqual(after.tenantless, protectedBefore.tenantless);
  });

  test("ensureTenantDefaults: validates, inserts missing only, idempotent, touches nothing else", async () => {
    const c = canonical();
    await assert.rejects(g.ensureTenantDefaults("not-a-tenant", c.version, { collection: coll() }), /invalid internal tenant id/);
    await assert.rejects(g.ensureTenantDefaults(A, c.version + 1, { collection: coll() }), /manifest version/);
    const { insertedId } = await coll().insertOne({ ...sharedRow(T0), tenantId: C, name: "C custom", columns: ["mine"] });
    const customHash = g.docHash(await coll().findOne({ _id: insertedId }));
    const before = await g.snapshot(coll());
    const first = await g.ensureTenantDefaults(C, c.version, { collection: coll() });
    assert.strictEqual(first.insertedCount, types.length - 1);
    assert.strictEqual(first.skippedCount, 1);
    assert.strictEqual(first.skipped[0].id, String(insertedId));
    const second = await g.ensureTenantDefaults(C, c.version, { collection: coll() });
    assert.strictEqual(second.insertedCount, 0);
    assert.strictEqual(second.skippedCount, types.length);
    assert.strictEqual(g.docHash(await coll().findOne({ _id: insertedId })), customHash);
    const after = await g.snapshot(coll());
    assert.deepStrictEqual(after.userViews, before.userViews);
    assert.deepStrictEqual(after.tenantless, before.tenantless);
    assert.strictEqual(await coll().countDocuments({ systemDefault: true, $or: [{ tenantId: null }, { tenantId: { $exists: false } }] }), types.length);
    assert.ok((await coll().indexes()).some((i) => i.name === g.INDEX_NAME));
  });
}

module.exports = { registerTenantGridDefaultsSuite, mongodBin };
