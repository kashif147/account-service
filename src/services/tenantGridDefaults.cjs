/**
 * Tenant-owned grid "Save View" system defaults (insert-only).
 *
 * Every active system default is owned by exactly one tenant: { tenantId: <internal tenant id string>,
 * systemDefault: true, no userId, meta.deleted: false }, at most one per tenant and template type
 * (partial unique index below). Content comes only from the versioned canonical manifest committed with
 * this service (CANONICAL_PATH) - never from the live CRM working tree or another tenant's row.
 *
 * ensureTenantDefaults(tenantId, manifestVersion) is the provisioning entry point: it inserts the
 * missing defaults for one tenant and never updates, merges into or deletes anything (an existing active
 * tenant default - possibly customised by the tenant - is skipped). Internal module: not exposed by any
 * route. CommonJS (.cjs) inside this ESM package: ESM callers `import g from "./tenantGridDefaults.cjs"`.
 * The migration CLI (scripts/migrate-grid-defaults-to-tenants.cjs) adds the backup, ledger and
 * rollback around the same plan.
 *
 * Transitional: shared tenantless rows (tenantId null/absent) are never touched here; the runtime keeps
 * resolving them as a fallback until the separate fallback-retirement cutover.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

const { EJSON } = mongoose.mongo.BSON;
const { ObjectId } = mongoose.mongo;

// ---- service-specific ---------------------------------------------------------------------------
const COLLECTION = "templates";
const CANONICAL_PATH = path.join(__dirname, "../config/gridSystemDefaults.v1.json");
// ObjectId-typed tenantId rows for a requested tenant: "refuse" (anomaly, nothing written) or "legacy"
// (reported and left untouched - they are invisible to the runtime's string tenant query).
const OBJECT_ID_TENANT_ROWS = "refuse";
// -------------------------------------------------------------------------------------------------

const INDEX_NAME = "uniq_active_tenant_system_default_per_type";
const INDEX_KEY = Object.freeze({ tenantId: 1, templateType: 1 });
const INDEX_PARTIAL = Object.freeze({ systemDefault: true, "meta.deleted": false, tenantId: { $gt: "" } });
const TENANT_ID_RE = /^[0-9a-f]{24}$/;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const docHash = (doc) => sha256(EJSON.stringify(doc, { relaxed: false }));
const mask = (id) => `…${String(id).slice(-6)}`;
const isTenantless = (doc) => doc.tenantId == null || doc.tenantId === "";
const isStringTenant = (doc) => typeof doc.tenantId === "string" && doc.tenantId !== "";

function assertTenantId(tenantId) {
  if (!TENANT_ID_RE.test(String(tenantId || ""))) {
    throw new Error(`invalid internal tenant id ${mask(tenantId)} (expected 24 lowercase hex)`);
  }
  return String(tenantId);
}

function parseTenantIds(raw) {
  const ids = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error("--tenants=<internal tenant id,...> is required (tenants are never inferred)");
  ids.forEach(assertTenantId);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate tenant id in --tenants");
  return ids;
}

/** The versioned canonical manifest, validated. */
function loadCanonical(file = CANONICAL_PATH) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error(`unsupported canonical version ${data.version}`);
  const types = Object.keys(data.templates || {});
  if (!types.length) throw new Error("canonical manifest has no templates");
  for (const type of types) {
    const t = data.templates[type];
    if (t.templateType !== type) throw new Error(`${type}: templateType mismatch`);
    if (!Array.isArray(t.columns) || !t.columns.length) throw new Error(`${type}: no columns`);
    if (new Set(t.columns).size !== t.columns.length) throw new Error(`${type}: duplicate columns`);
    if (t.columnLabels != null && typeof t.columnLabels !== "object") throw new Error(`${type}: columnLabels must be an object`);
    if (t.filters != null && typeof t.filters !== "object") throw new Error(`${type}: filters must be an object`);
    if (t.aliases != null && !Array.isArray(t.aliases)) throw new Error(`${type}: aliases must be an array`);
    for (const flag of ["isDefault", "pinned"]) {
      if (t[flag] != null && typeof t[flag] !== "boolean") throw new Error(`${type}: ${flag} must be a boolean`);
    }
  }
  return data;
}

const typeMatch = (canonical, type) => {
  const aliases = canonical.templates[type].aliases || [];
  return aliases.length ? { $in: [type, ...aliases] } : type;
};

function buildTenantDefault(canonical, tenantId, type, now, _id) {
  const t = canonical.templates[type];
  const doc = {
    _id,
    name: t.name || "System default",
    templateType: type,
    tenantId,
    filters: JSON.parse(JSON.stringify(t.filters || {})),
    columns: [...t.columns],
    columnLabels: { ...(t.columnLabels || {}) },
    visibleFilters: [...(t.visibleFilters || [])],
    // flags copied from the manifest so a migrated row behaves exactly like the row it replaces
    isDefault: t.isDefault === true,
    pinned: t.pinned === true,
    systemDefault: true,
    meta: { deleted: false, deletedAt: null },
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };
  return doc;
}

/** Every row of the collection, classified, with content hashes. */
async function snapshot(coll) {
  const docs = await coll.find({}).sort({ _id: 1 }).toArray();
  const row = (d) => ({
    id: String(d._id),
    templateType: d.templateType,
    hash: docHash(d),
    updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
    columnsHash: sha256(JSON.stringify(d.columns || [])),
    filtersHash: sha256(EJSON.stringify(d.filters ?? null)),
  });
  return {
    total: docs.length,
    userViews: docs.filter((d) => d.systemDefault !== true).map(row),
    tenantless: docs.filter((d) => d.systemDefault === true && isTenantless(d)).map(row),
    legacyNonStringTenant: docs.filter((d) => d.systemDefault === true && !isTenantless(d) && !isStringTenant(d)).map(row),
    tenantOwned: docs
      .filter((d) => d.systemDefault === true && isStringTenant(d))
      .map((d) => ({ ...row(d), tenantId: d.tenantId, deleted: !!(d.meta && d.meta.deleted) })),
  };
}

/** Changes to rows this tooling must never touch (user views, tenantless, legacy non-string-tenant). */
function protectedDiff(before, after, { allowTenantOwned = [] } = {}) {
  const diffs = [];
  for (const set of ["userViews", "tenantless", "legacyNonStringTenant"]) {
    const a = new Map(before[set].map((r) => [r.id, r]));
    const b = new Map(after[set].map((r) => [r.id, r]));
    if (a.size !== b.size) diffs.push(`${set}: count ${a.size} -> ${b.size}`);
    for (const [id, r] of a) {
      const s = b.get(id);
      if (!s) diffs.push(`${set}: ${mask(id)} missing`);
      else if (s.hash !== r.hash || s.updatedAt !== r.updatedAt) diffs.push(`${set}: ${mask(id)} changed`);
    }
    for (const id of b.keys()) if (!a.has(id)) diffs.push(`${set}: ${mask(id)} added`);
  }
  // pre-existing tenant-owned rows must be unchanged too (customisation is never overwritten)
  const allowed = new Set(allowTenantOwned.map(String));
  const ta = new Map(before.tenantOwned.map((r) => [r.id, r]));
  const tb = new Map(after.tenantOwned.map((r) => [r.id, r]));
  for (const [id, r] of ta) {
    const s = tb.get(id);
    if (!s) diffs.push(`tenantOwned: ${mask(id)} missing`);
    else if (s.hash !== r.hash || s.updatedAt !== r.updatedAt) diffs.push(`tenantOwned: ${mask(id)} changed`);
  }
  for (const id of tb.keys()) if (!ta.has(id) && !allowed.has(id)) diffs.push(`tenantOwned: ${mask(id)} unexpected insert`);
  return diffs;
}

/** State of the partial unique index and whether current data satisfies it. */
async function inspectIndex(coll) {
  const indexes = await coll.indexes().catch((err) => (err && err.codeName === "NamespaceNotFound" ? [] : Promise.reject(err)));
  const anomalies = [];
  const same = (a, b) => EJSON.stringify(a) === EJSON.stringify(b);
  const named = indexes.find((i) => i.name === INDEX_NAME);
  const sameKey = indexes.filter((i) => i.name !== INDEX_NAME && same(i.key, INDEX_KEY));
  if (sameKey.length) anomalies.push(`index key ${JSON.stringify(INDEX_KEY)} already used by ${sameKey.map((i) => i.name).join(",")}`);
  let state = "absent";
  if (named) {
    if (!same(named.key, INDEX_KEY) || named.unique !== true || !same(named.partialFilterExpression, INDEX_PARTIAL)) {
      anomalies.push(`index ${INDEX_NAME} exists with a different definition`);
    }
    state = "present";
  }
  const covered = await coll.countDocuments(INDEX_PARTIAL);
  const dupGroups = await coll
    .aggregate([
      { $match: INDEX_PARTIAL },
      { $group: { _id: { tenantId: "$tenantId", templateType: "$templateType" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  for (const g of dupGroups) anomalies.push(`duplicate active tenant default ${mask(g._id.tenantId)}/${g._id.templateType} x${g.n}`);
  return { state, covered, duplicateGroups: dupGroups.length, existing: indexes.map((i) => i.name), anomalies };
}

async function ensureIndex(coll) {
  const index = await inspectIndex(coll);
  if (index.anomalies.length) throw new Error(`refusing: ${index.anomalies.join("; ")}`);
  if (index.state === "present") return { created: false };
  await coll.createIndex(INDEX_KEY, { name: INDEX_NAME, unique: true, partialFilterExpression: INDEX_PARTIAL });
  return { created: true };
}

/** Insert/skip decision for every tenant x canonical type. Never writes. */
async function planTenantDefaults(coll, tenantIds, canonical, { now = new Date() } = {}) {
  const items = [];
  const anomalies = [];
  const legacy = [];
  for (const tenantId of tenantIds.map(assertTenantId)) {
    const oidRows = await coll.find({ tenantId: new ObjectId(tenantId) }).project({ _id: 1, templateType: 1, systemDefault: 1 }).toArray();
    if (oidRows.length) {
      if (OBJECT_ID_TENANT_ROWS === "legacy") {
        for (const r of oidRows) legacy.push({ tenantId, id: String(r._id), templateType: r.templateType, systemDefault: r.systemDefault === true });
      } else {
        anomalies.push(`${mask(tenantId)}: ${oidRows.length} row(s) store tenantId as ObjectId`);
      }
    }
    for (const type of Object.keys(canonical.templates)) {
      const existing = await coll
        .find({ tenantId, templateType: typeMatch(canonical, type), systemDefault: true, "meta.deleted": false })
        .toArray();
      if (existing.length > 1) {
        anomalies.push(`${mask(tenantId)}/${type}: ${existing.length} active tenant defaults`);
        items.push({ tenantId, templateType: type, action: "anomaly", existingIds: existing.map((d) => String(d._id)) });
      } else if (existing.length === 1) {
        if (existing[0].userId) anomalies.push(`${mask(tenantId)}/${type}: active system default carries a userId`);
        items.push({ tenantId, templateType: type, action: "skip", existingId: String(existing[0]._id) });
      } else {
        const doc = buildTenantDefault(canonical, tenantId, type, now, new ObjectId());
        items.push({ tenantId, templateType: type, action: "insert", id: String(doc._id), doc });
      }
    }
  }
  return {
    tenants: tenantIds,
    types: Object.keys(canonical.templates),
    items,
    inserts: items.filter((i) => i.action === "insert").length,
    skips: items.filter((i) => i.action === "skip").length,
    anomalies,
    legacy,
  };
}

const defaultCollection = () => {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) throw new Error("MongoDB is not connected");
  return mongoose.connection.db.collection(COLLECTION);
};

/**
 * Provisioning entry point: insert this tenant's missing system defaults from the canonical manifest.
 * Idempotent, insert-only; never updates an existing row, never creates a tenantless row, never touches
 * user views. Returns inserted/skipped per template type.
 */
async function ensureTenantDefaults(tenantId, manifestVersion, { collection, canonical = loadCanonical() } = {}) {
  const tid = assertTenantId(tenantId);
  if (manifestVersion !== canonical.version) {
    throw new Error(`manifest version ${manifestVersion} requested, this service ships v${canonical.version}`);
  }
  const coll = collection || defaultCollection();
  await ensureIndex(coll);
  const plan = await planTenantDefaults(coll, [tid], canonical);
  if (plan.anomalies.length) throw new Error(`refusing: ${plan.anomalies.join("; ")}`);
  const inserted = [];
  const skipped = plan.items.filter((i) => i.action === "skip").map((i) => ({ templateType: i.templateType, id: i.existingId }));
  for (const item of plan.items.filter((i) => i.action === "insert")) {
    try {
      await coll.insertOne(item.doc);
      inserted.push({ templateType: item.templateType, id: item.id });
    } catch (err) {
      if (err && err.code === 11000) {
        const winner = await coll.findOne({ tenantId: tid, templateType: item.templateType, systemDefault: true, "meta.deleted": false });
        skipped.push({ templateType: item.templateType, id: winner ? String(winner._id) : null, raced: true });
      } else {
        throw err;
      }
    }
  }
  return { tenantId: tid, manifestVersion: canonical.version, insertedCount: inserted.length, skippedCount: skipped.length, inserted, skipped };
}

module.exports = {
  COLLECTION,
  CANONICAL_PATH,
  OBJECT_ID_TENANT_ROWS,
  INDEX_NAME,
  INDEX_KEY,
  INDEX_PARTIAL,
  assertTenantId,
  parseTenantIds,
  loadCanonical,
  buildTenantDefault,
  snapshot,
  protectedDiff,
  inspectIndex,
  ensureIndex,
  planTenantDefaults,
  ensureTenantDefaults,
  docHash,
  sha256,
  mask,
};
