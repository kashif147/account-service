/**
 * Ledger tenancy migration (Phase 2B-PARALLEL-2, B3/B8) — NOT run automatically.
 *
 * Steps (each is a separate invocation; every step except --report needs --apply to write):
 *
 *   1. --report (default, read-only)
 *        Per ledger collection: total rows, rows without tenantId, tenant value
 *        distribution (classified), current indexes, legacy global unique indexes still
 *        present, and duplicate groups that WOULD violate each new tenant-leading unique
 *        index after a single-tenant backfill. Also cross-checks GL documents linked to a
 *        Payment/Refund (RCP-/RFD-/RCP-EVT-<id>) against that row's tenant. Aggregate
 *        counts only: no member ids, amounts or document content are printed.
 *
 *   2. --backfill --tenant=<id> --confirm-single-tenant [--apply]
 *        For a deployment that has only ever had one tenant: sets tenantId=<id> on every
 *        ledger row where it is missing/null/"". Refuses when any ledger row already
 *        carries a different tenant, when a linked Payment/Refund belongs to another
 *        tenant, or when the report finds unique-key conflicts. Idempotent (the filter
 *        only matches untagged rows).
 *
 *   3. --create-indexes [--apply]
 *        Builds the tenant-leading unique indexes declared by the models (no-op where
 *        present). Safe before the backfill: untagged rows index as tenantId=null and the
 *        old global unique indexes already guarantee no duplicates.
 *
 *   4. --drop-legacy-indexes [--apply]
 *        Drops the old global unique indexes (docNo_1, code_1, ...). Refuses unless the
 *        replacement index exists and is unique AND no untagged rows remain. Until this
 *        runs, two tenants cannot reuse the same docNo/code (safe, just restrictive).
 *
 * Rollback: steps 1-3 are additive (an added tenantId field and extra indexes are
 * ignored by the previous code). After step 4, recreating a global unique index only
 * works while no two tenants share a key. Keep the step-2 --apply output.
 *
 * Connects only to account-service's own database (MONGO_URI / MONGODB_URI). Uses the
 * raw driver, so the models' tenant guard does not apply here by design.
 *
 *   MONGO_URI=... node scripts/migrations/ledger-tenancy.js --report
 *   MONGO_URI=... node scripts/migrations/ledger-tenancy.js --backfill --tenant=<id> --confirm-single-tenant
 *   MONGO_URI=... node scripts/migrations/ledger-tenancy.js --backfill --tenant=<id> --confirm-single-tenant --apply
 */
import mongoose from "mongoose";
import { assertMigrationTarget } from "../lib/migrationTargetGuard.js";

const LEGACY_TENANT_VALUES = ["default", "unknown"];
const MISSING = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: "" }] };

// collection -> legacy global unique indexes it may still have, and the new
// tenant-leading unique index that replaces them (null when the model has none).
export const LEDGER_COLLECTIONS = {
  gltransactions: {
    legacy: ["docNo_1"],
    unique: { key: { tenantId: 1, docNo: 1 }, name: "tenantId_1_docNo_1" },
  },
  coas: {
    legacy: ["code_1"],
    unique: { key: { tenantId: 1, code: 1 }, name: "tenantId_1_code_1" },
  },
  creditnotes: {
    legacy: ["docNo_1"],
    unique: { key: { tenantId: 1, docNo: 1 }, name: "tenantId_1_docNo_1" },
  },
  journaladjustments: {
    legacy: ["docNo_1"],
    unique: { key: { tenantId: 1, docNo: 1 }, name: "tenantId_1_docNo_1" },
  },
  balances: {
    legacy: ["memberId_1_coaCode_1_bucket_1"],
    unique: {
      key: { tenantId: 1, memberId: 1, coaCode: 1, bucket: 1 },
      name: "tenantId_1_memberId_1_coaCode_1_bucket_1",
    },
  },
  materializedbalances: {
    legacy: [
      "memberId_1_accountCode_1_bucket_1_year_1_ledgerDomain_1",
      "memberId_1_accountCode_1_bucket_1_year_1",
    ],
    unique: {
      key: { tenantId: 1, memberId: 1, accountCode: 1, bucket: 1, year: 1, ledgerDomain: 1 },
      name: "tenantId_1_memberId_1_accountCode_1_bucket_1_year_1_ledgerDomain_1",
    },
  },
  reportsnapshots: {
    legacy: ["type_1_label_1"],
    unique: { key: { tenantId: 1, type: 1, label: 1 }, name: "tenantId_1_type_1_label_1" },
  },
  journals: { legacy: [], unique: null },
  reconciliationrecords: { legacy: [], unique: null },
};

export function parseArgs(argv) {
  const out = { mode: "report", apply: false, tenant: "", confirmSingleTenant: false, knownTenants: [] };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a === "--report") out.mode = "report";
    else if (a === "--backfill") out.mode = "backfill";
    else if (a === "--create-indexes") out.mode = "create-indexes";
    else if (a === "--drop-legacy-indexes") out.mode = "drop-legacy-indexes";
    else if (a === "--confirm-single-tenant") out.confirmSingleTenant = true;
    else if (a.startsWith("--tenant=")) out.tenant = a.slice(9).trim();
    else if (a.startsWith("--known-tenants=")) {
      out.knownTenants = a.slice(16).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

/** Classify a tenantId value without printing anything but the class and count. */
export function classifyTenant(value, knownTenants = []) {
  if (value == null || value === "") return "missing";
  const v = String(value);
  if (knownTenants.includes(v)) return `tenant:${v}`;
  if (LEGACY_TENANT_VALUES.includes(v.toLowerCase())) return `legacy:${v.toLowerCase()}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return `entra-guid:${v}`;
  if (/^[0-9a-f]{24}$/i.test(v)) return `unknown-objectid:${v}`;
  return "unknown-other";
}

async function collectionExists(db, name) {
  return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
}

/**
 * Duplicate groups the new unique index would reject once untagged rows get `target`.
 * $ifNull maps missing tenant to the target, mirroring the single-tenant backfill.
 */
async function conflictGroups(coll, uniqueKey, target) {
  const groupId = {};
  for (const field of Object.keys(uniqueKey)) {
    groupId[field] =
      field === "tenantId"
        ? { $ifNull: [{ $cond: [{ $eq: ["$tenantId", ""] }, null, "$tenantId"] }, target ?? "__untagged__"] }
        : `$${field}`;
  }
  const rows = await coll
    .aggregate(
      [
        { $group: { _id: groupId, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: "groups" },
      ],
      { allowDiskUse: true },
    )
    .toArray();
  return rows[0]?.groups || 0;
}

/** GL docs whose linked Payment/Refund row has a tenant other than `target`. */
async function linkedRowTenantCheck(db, target, knownTenants) {
  const out = { linkedDocs: 0, linkedWithTenant: 0, byClass: {}, conflictingWithTarget: 0, linkedRowMissing: 0 };
  if (!(await collectionExists(db, "gltransactions"))) return out;
  const cursor = db
    .collection("gltransactions")
    .find({ docNo: { $regex: /^(RCP|RFD|RCP-EVT)-[0-9a-fA-F]{24}$/ } }, { projection: { docNo: 1 } });
  const pay = db.collection("payments");
  const ref = db.collection("refunds");
  for await (const doc of cursor) {
    out.linkedDocs += 1;
    const m = String(doc.docNo).match(/^(RCP-EVT|RCP|RFD)-([0-9a-fA-F]{24})$/);
    if (!m) continue;
    const id = new mongoose.Types.ObjectId(m[2]);
    const row = await (m[1] === "RFD" ? ref : pay).findOne({ _id: id }, { projection: { tenantId: 1 } });
    if (!row) {
      out.linkedRowMissing += 1;
      continue;
    }
    if (row.tenantId) out.linkedWithTenant += 1;
    const cls = classifyTenant(row.tenantId, knownTenants);
    out.byClass[cls] = (out.byClass[cls] || 0) + 1;
    if (target && row.tenantId && String(row.tenantId) !== target) out.conflictingWithTarget += 1;
  }
  return out;
}

export async function buildReport(db, { tenant, knownTenants = [] }) {
  const known = [...new Set([...(knownTenants || []), ...(tenant ? [tenant] : [])])];
  const collections = {};
  for (const [name, spec] of Object.entries(LEDGER_COLLECTIONS)) {
    if (!(await collectionExists(db, name))) {
      collections[name] = { exists: false };
      continue;
    }
    const coll = db.collection(name);
    const dist = await coll.aggregate([{ $group: { _id: "$tenantId", n: { $sum: 1 } } }]).toArray();
    const byClass = {};
    for (const d of dist) {
      const cls = classifyTenant(d._id, known);
      byClass[cls] = (byClass[cls] || 0) + d.n;
    }
    const indexes = await coll.indexes();
    const names = indexes.map((i) => i.name);
    collections[name] = {
      exists: true,
      total: await coll.countDocuments({}),
      missingTenant: await coll.countDocuments(MISSING),
      tenantClasses: byClass,
      legacyUniqueIndexesPresent: spec.legacy.filter((n) => names.includes(n)),
      newUniqueIndexPresent: spec.unique ? names.includes(spec.unique.name) : null,
      uniqueConflictGroupsAfterBackfill: spec.unique ? await conflictGroups(coll, spec.unique.key, tenant || null) : 0,
    };
  }
  const linked = await linkedRowTenantCheck(db, tenant || null, known);
  return { collections, linkedPaymentRefundCheck: linked };
}

function otherTenantRows(report, tenant) {
  let n = 0;
  for (const c of Object.values(report.collections)) {
    if (!c.exists) continue;
    for (const [cls, count] of Object.entries(c.tenantClasses)) {
      if (cls !== "missing" && cls !== `tenant:${tenant}`) n += count;
    }
  }
  return n;
}

export async function runBackfill(db, { tenant, confirmSingleTenant, apply, report }) {
  if (!tenant) throw new Error("--tenant=<tenantId> is required for --backfill");
  if (!confirmSingleTenant) throw new Error("--backfill requires --confirm-single-tenant");
  const others = otherTenantRows(report, tenant);
  if (others > 0) {
    throw new Error(`refusing: ${others} ledger row(s) already carry a different/legacy tenant`);
  }
  if (report.linkedPaymentRefundCheck.conflictingWithTarget > 0) {
    throw new Error(
      `refusing: ${report.linkedPaymentRefundCheck.conflictingWithTarget} GL doc(s) link to a Payment/Refund of another tenant`,
    );
  }
  const conflicts = Object.entries(report.collections)
    .filter(([, c]) => c.exists && c.uniqueConflictGroupsAfterBackfill > 0)
    .map(([n]) => n);
  if (conflicts.length) {
    throw new Error(`refusing: unique-key conflicts after backfill in ${conflicts.join(", ")}`);
  }
  const result = {};
  for (const name of Object.keys(LEDGER_COLLECTIONS)) {
    if (!report.collections[name]?.exists) continue;
    const coll = db.collection(name);
    const n = await coll.countDocuments(MISSING);
    result[name] = { wouldSet: n };
    if (apply && n > 0) {
      const r = await coll.updateMany(MISSING, { $set: { tenantId: tenant } });
      result[name].modified = r.modifiedCount;
    }
  }
  return result;
}

export async function runCreateIndexes(db, { apply }) {
  const result = {};
  for (const [name, spec] of Object.entries(LEDGER_COLLECTIONS)) {
    if (!spec.unique || !(await collectionExists(db, name))) continue;
    const coll = db.collection(name);
    const present = (await coll.indexes()).some((i) => i.name === spec.unique.name);
    result[name] = present ? "present" : apply ? "created" : "would-create";
    if (!present && apply) {
      await coll.createIndex(spec.unique.key, { unique: true, name: spec.unique.name });
    }
  }
  return result;
}

export async function runDropLegacyIndexes(db, { apply }) {
  const result = {};
  for (const [name, spec] of Object.entries(LEDGER_COLLECTIONS)) {
    if (!spec.legacy.length || !(await collectionExists(db, name))) continue;
    const coll = db.collection(name);
    const idx = await coll.indexes();
    const replacement = spec.unique ? idx.find((i) => i.name === spec.unique.name) : null;
    const untagged = await coll.countDocuments(MISSING);
    const legacyPresent = spec.legacy.filter((n) => idx.some((i) => i.name === n));
    if (!legacyPresent.length) {
      result[name] = "no-legacy-index";
      continue;
    }
    if (!replacement || !replacement.unique || untagged > 0) {
      result[name] = `refused (replacement=${replacement ? "present" : "missing"}, untagged=${untagged})`;
      continue;
    }
    result[name] = apply ? `dropped ${legacyPresent.join(",")}` : `would-drop ${legacyPresent.join(",")}`;
    if (apply) {
      for (const n of legacyPresent) await coll.dropIndex(n);
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI (account-service's own DB) is required");
  await mongoose.connect(uri, { autoIndex: false });
  const db = mongoose.connection.db;
  try {
    assertMigrationTarget(mongoose.connection.name, process.argv.slice(2), { apply: args.apply });
    const report = await buildReport(db, args);
    const out = { mode: args.mode, apply: args.apply, report };
    if (args.mode === "backfill") out.backfill = await runBackfill(db, { ...args, report });
    if (args.mode === "create-indexes") out.indexes = await runCreateIndexes(db, args);
    if (args.mode === "drop-legacy-indexes") out.indexes = await runDropLegacyIndexes(db, args);
    if (args.mode !== "report" && !args.apply) out.note = "DRY-RUN: nothing was written. Re-run with --apply.";
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[ledger-tenancy] failed:", err.message);
    process.exit(1);
  });
}
