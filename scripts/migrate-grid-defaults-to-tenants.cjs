/**
 * Grid "Save View" system defaults -> tenant-owned rows (ownership migration, insert-only).
 *
 * Gives each EXPLICITLY LISTED tenant its own active system default for every template type in this
 * service's versioned canonical manifest (see src/services/tenantGridDefaults.cjs). Rules:
 *  - DRY RUN by default; --apply also requires --expect-db=<connected database name>.
 *  - DEV databases only (name ending in -dev/_dev); anything else is refused.
 *  - Tenants only from --tenants=<internal tenant id,...>; never inferred from data.
 *  - Insert-only: an existing active tenant default is SKIPPED, never updated or merged into.
 *  - Never touches user views, shared tenantless rows or legacy non-string-tenant rows (proved by
 *    before/after snapshots).
 *  - --apply writes a full backup and a ledger (planned _ids before inserting) to --out=<dir>, and creates
 *    the partial unique index; --rollback=<ledger> deletes only ledger inserts that are still unmodified.
 *
 * Usage (inside the service container, MONGO_URI set):
 *   node scripts/migrate-grid-defaults-to-tenants.cjs --tenants=<id>[,<id>...]
 *   node scripts/migrate-grid-defaults-to-tenants.cjs --tenants=<id> --apply --expect-db=<db> --out=<dir>
 *   node scripts/migrate-grid-defaults-to-tenants.cjs --rollback=<ledger.json> [--apply --expect-db=<db>]
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const g = require("../src/services/tenantGridDefaults.cjs");

const { EJSON } = mongoose.mongo.BSON;
const { ObjectId } = mongoose.mongo;
const DEV_DB_PATTERN = /(^|[-_])dev$/i;

function assertDevTarget(dbName, { apply, expectDb }) {
  if (!DEV_DB_PATTERN.test(dbName)) throw new Error(`refusing: "${dbName}" is not a DEV database (expected a name ending in -dev/_dev)`);
  if (apply && !expectDb) throw new Error("refusing: --apply requires --expect-db=<database name>");
  if (expectDb && expectDb !== dbName) throw new Error(`refusing: connected to "${dbName}" but --expect-db="${expectDb}"`);
}

function writeNew(file, data) {
  fs.writeFileSync(file, data, { flag: "wx" }); // never overwrite an existing backup/ledger
}

/** Backup -> index -> ledger (planned ids) -> inserts -> verification. */
async function applyMigration(coll, plan, { outDir, runId, dbName }) {
  if (plan.anomalies.length) throw new Error(`refusing to apply: ${plan.anomalies.join("; ")}`);
  const index = await g.inspectIndex(coll);
  if (index.anomalies.length) throw new Error(`refusing to apply: ${index.anomalies.join("; ")}`);
  const before = await g.snapshot(coll);

  const allDocs = await coll.find({}).sort({ _id: 1 }).toArray();
  const backupText = EJSON.stringify(allDocs, { relaxed: false });
  const backupFile = path.join(outDir, `${g.COLLECTION}-ownership-backup-${runId}.json`);
  writeNew(backupFile, backupText);

  const { created: indexCreated } = await g.ensureIndex(coll);

  const ledgerFile = path.join(outDir, `${g.COLLECTION}-tenant-defaults-ledger-${runId}.json`);
  const ledger = {
    runId,
    dbName,
    collection: g.COLLECTION,
    createdAt: new Date().toISOString(),
    status: "pending",
    canonical: plan.canonicalSource,
    tenants: plan.tenants,
    backup: { file: path.basename(backupFile), sha256: g.sha256(backupText), docs: allDocs.length },
    index: { name: g.INDEX_NAME, created: indexCreated },
    planned: plan.items.filter((i) => i.action === "insert").map((i) => ({ id: i.id, tenantId: i.tenantId, templateType: i.templateType })),
    skipped: plan.items.filter((i) => i.action === "skip").map((i) => ({ existingId: i.existingId, tenantId: i.tenantId, templateType: i.templateType })),
    legacyUntouched: plan.legacy,
    inserted: [],
    raced: [],
  };
  writeNew(ledgerFile, JSON.stringify(ledger, null, 2));
  const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));

  for (const item of plan.items.filter((i) => i.action === "insert")) {
    try {
      await coll.insertOne(item.doc);
      const stored = await coll.findOne({ _id: item.doc._id });
      ledger.inserted.push({ id: item.id, tenantId: item.tenantId, templateType: item.templateType, hash: g.docHash(stored) });
    } catch (err) {
      if (err && err.code === 11000) ledger.raced.push({ id: item.id, tenantId: item.tenantId, templateType: item.templateType });
      else {
        ledger.status = "failed";
        ledger.error = err.message;
        saveLedger();
        throw err;
      }
    }
    saveLedger();
  }

  const after = await g.snapshot(coll);
  const diffs = g.protectedDiff(before, after, { allowTenantOwned: ledger.inserted.map((r) => r.id) });
  const coverage = [];
  for (const tenantId of plan.tenants) {
    for (const type of plan.types) {
      const n = await coll.countDocuments({ tenantId, templateType: type, systemDefault: true, "meta.deleted": false });
      if (n !== 1) coverage.push(`${g.mask(tenantId)}/${type}: ${n} active tenant defaults`);
    }
  }
  ledger.status = diffs.length || coverage.length ? "applied-with-verification-errors" : "applied";
  ledger.verification = { protectedDiffs: diffs, coverage };
  saveLedger();
  return { ledgerFile, backupFile, ledger, before, after };
}

/** Deletes only ledger inserts that are still exactly as inserted (a customised row is kept). */
async function rollbackMigration(coll, ledgerFile, { apply = false } = {}) {
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  if (ledger.collection && ledger.collection !== g.COLLECTION) throw new Error(`ledger is for ${ledger.collection}, not ${g.COLLECTION}`);
  const results = [];
  for (const rec of ledger.inserted || []) {
    const _id = new ObjectId(rec.id);
    const doc = await coll.findOne({ _id });
    if (!doc) results.push({ ...rec, action: "already-absent" });
    else if (String(doc.tenantId) !== rec.tenantId || doc.templateType !== rec.templateType || doc.systemDefault !== true) {
      results.push({ ...rec, action: "refused-identity-mismatch" });
    } else if (g.docHash(doc) !== rec.hash) {
      results.push({ ...rec, action: "kept-modified-since-insert" });
    } else if (apply) {
      const r = await coll.deleteOne({ _id, tenantId: rec.tenantId, templateType: rec.templateType, systemDefault: true });
      results.push({ ...rec, action: r.deletedCount === 1 ? "deleted" : "delete-missed" });
    } else {
      results.push({ ...rec, action: "would-delete" });
    }
  }
  return { runId: ledger.runId, results };
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : "";
  };
  return { tenants: get("tenants"), apply: argv.includes("--apply"), expectDb: get("expect-db"), out: get("out") || process.cwd(), rollback: get("rollback") };
}

function printSnapshot(label, snap) {
  console.log(`${label}: total=${snap.total} userViews=${snap.userViews.length} tenantless=${snap.tenantless.length} legacyNonStringTenant=${snap.legacyNonStringTenant.length} tenantOwned=${snap.tenantOwned.length}`);
  for (const r of snap.userViews) console.log(`  user ${g.mask(r.id)} ${r.templateType} hash=${r.hash.slice(0, 12)} updatedAt=${r.updatedAt} cols=${r.columnsHash.slice(0, 8)} filters=${r.filtersHash.slice(0, 8)}`);
  for (const r of snap.tenantless) console.log(`  tenantless ${g.mask(r.id)} ${r.templateType} hash=${r.hash.slice(0, 12)} updatedAt=${r.updatedAt}`);
  for (const r of snap.legacyNonStringTenant) console.log(`  legacy-non-string-tenant ${g.mask(r.id)} ${r.templateType} hash=${r.hash.slice(0, 12)} updatedAt=${r.updatedAt}`);
  for (const r of snap.tenantOwned) console.log(`  tenant ${g.mask(r.tenantId)} ${g.mask(r.id)} ${r.templateType} hash=${r.hash.slice(0, 12)} deleted=${r.deleted}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.REPORTING_MONGO_URI || "";
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  const coll = db.collection(g.COLLECTION);
  console.log(`database: ${dbName} | collection: ${g.COLLECTION} | mode: ${args.rollback ? "rollback" : "migrate"} ${args.apply ? "APPLY" : "DRY RUN"}`);
  try {
    assertDevTarget(dbName, args);
    if (args.rollback) {
      const r = await rollbackMigration(coll, args.rollback, { apply: args.apply });
      for (const x of r.results) console.log(`  ${x.action} ${g.mask(x.tenantId)}/${x.templateType} ${g.mask(x.id)}`);
      return r;
    }
    const tenantIds = g.parseTenantIds(args.tenants);
    const canonical = g.loadCanonical();
    const before = await g.snapshot(coll);
    printSnapshot("before", before);
    const index = await g.inspectIndex(coll);
    console.log(`index ${g.INDEX_NAME}: ${index.state}; rows under partial filter=${index.covered}; duplicate groups=${index.duplicateGroups}; existing=[${index.existing.join(", ")}]`);
    const plan = await g.planTenantDefaults(coll, tenantIds, canonical);
    plan.canonicalSource = { version: canonical.version, ...canonical.source };
    console.log(`canonical: v${canonical.version} ${JSON.stringify(canonical.source)}`);
    for (const i of plan.items) {
      const what = i.action === "insert" ? `${i.doc.columns.length} cols` : i.action === "skip" ? `existing ${g.mask(i.existingId)}` : i.existingIds.map(g.mask).join(",");
      console.log(`  ${i.action.toUpperCase()} ${g.mask(i.tenantId)} ${i.templateType} ${what}`);
    }
    for (const l of plan.legacy) console.log(`  LEGACY (untouched, ObjectId tenantId) ${g.mask(l.tenantId)} ${l.templateType} ${g.mask(l.id)}`);
    console.log(`plan: inserts=${plan.inserts} skips=${plan.skips} anomalies=${plan.anomalies.length + index.anomalies.length}`);
    for (const a of [...plan.anomalies, ...index.anomalies]) console.log(`  ANOMALY ${a}`);
    if (!args.apply) {
      console.log("DRY RUN: nothing written");
      return { plan, index, before };
    }
    const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const res = await applyMigration(coll, plan, { outDir: args.out, runId, dbName });
    printSnapshot("after", res.after);
    console.log(`inserted=${res.ledger.inserted.length} raced=${res.ledger.raced.length} status=${res.ledger.status}`);
    for (const d of res.ledger.verification.protectedDiffs) console.log(`  PROTECTED DIFF ${d}`);
    for (const c of res.ledger.verification.coverage) console.log(`  COVERAGE ${c}`);
    console.log(`ledger: ${res.ledgerFile}\nbackup: ${res.backupFile} sha256=${res.ledger.backup.sha256.slice(0, 12)}`);
    return res;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { assertDevTarget, applyMigration, rollbackMigration, main };
