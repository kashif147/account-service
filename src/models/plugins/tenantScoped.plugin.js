// Ledger tenancy guard (Phase 2B-PARALLEL-2, B1/B2).
//
// Every general-ledger model carries a required `tenantId` and every Mongoose query,
// update, delete, aggregate and bulkWrite against it must be scoped to exactly one
// tenant. A call site that forgets the tenant throws (fails closed) instead of reading
// or writing across tenants. `findById(id)` is therefore rejected too: use
// `findOne({ _id: id, tenantId })`.
//
// There is deliberately no opt-out through the Mongoose API. Operator scripts that must
// span tenants (backfill, rebuild) use the raw driver (`Model.collection`), which skips
// middleware and is easy to audit.

export const TENANT_SCOPE_ERROR = "TENANT_SCOPE_REQUIRED";

function tenantScopeError(where) {
  const err = new Error(`Tenant scope required (${where})`);
  err.code = TENANT_SCOPE_ERROR;
  err.status = 500;
  err.statusCode = 500;
  return err;
}

function isTenantValue(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** True when the filter pins `tenantId` to a single tenant (top level, $eq, or an $and branch). */
export function filterHasTenant(filter) {
  if (!filter || typeof filter !== "object") return false;
  const t = filter.tenantId;
  if (isTenantValue(t)) return true;
  if (t && typeof t === "object" && !Array.isArray(t) && isTenantValue(t.$eq)) return true;
  if (Array.isArray(filter.$and)) return filter.$and.some(filterHasTenant);
  return false;
}

function updateTouchesTenant(update) {
  if (!update || typeof update !== "object") return false;
  if (Array.isArray(update)) return true; // pipeline updates are not allowed on ledger rows
  if (Object.prototype.hasOwnProperty.call(update, "tenantId")) return true;
  return Object.keys(update).some(
    (op) =>
      op.startsWith("$") &&
      op !== "$setOnInsert" &&
      update[op] &&
      typeof update[op] === "object" &&
      Object.prototype.hasOwnProperty.call(update[op], "tenantId"),
  );
}

const FILTER_OPS = [
  "find",
  "findOne",
  "countDocuments",
  "distinct",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
];
const UPDATE_OPS = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
];

export function tenantScopedPlugin(schema, { modelName = "ledger model" } = {}) {
  schema.add({
    tenantId: { type: String, required: true, trim: true, index: true },
  });

  schema.pre(FILTER_OPS, function guardFilter() {
    if (!filterHasTenant(this.getFilter())) {
      throw tenantScopeError(`${modelName}.${this.op}`);
    }
  });

  schema.pre(UPDATE_OPS, function guardUpdate() {
    if (!filterHasTenant(this.getFilter())) {
      throw tenantScopeError(`${modelName}.${this.op}`);
    }
    if (this.op === "findOneAndReplace" || this.op === "replaceOne") {
      const replacement = this.getUpdate() || {};
      if (replacement.tenantId !== this.getFilter().tenantId) {
        throw tenantScopeError(`${modelName}.${this.op} replacement tenant`);
      }
      return;
    }
    if (updateTouchesTenant(this.getUpdate())) {
      throw tenantScopeError(`${modelName}.${this.op} must not change tenantId`);
    }
  });

  schema.pre("aggregate", function guardAggregate() {
    const first = this.pipeline()[0];
    if (!first || !first.$match || !filterHasTenant(first.$match)) {
      throw tenantScopeError(`${modelName}.aggregate (first stage must $match tenantId)`);
    }
  });

  schema.pre("bulkWrite", function guardBulkWrite(next, ops) {
    for (const op of ops || []) {
      const [kind] = Object.keys(op || {});
      const body = op?.[kind] || {};
      if (kind === "insertOne") {
        if (!isTenantValue(body.document?.tenantId)) {
          return next(tenantScopeError(`${modelName}.bulkWrite insertOne`));
        }
        continue;
      }
      if (!filterHasTenant(body.filter)) {
        return next(tenantScopeError(`${modelName}.bulkWrite ${kind}`));
      }
      if (kind === "replaceOne" && body.replacement?.tenantId !== body.filter.tenantId) {
        return next(tenantScopeError(`${modelName}.bulkWrite replaceOne tenant`));
      }
      if ((kind === "updateOne" || kind === "updateMany") && updateTouchesTenant(body.update)) {
        return next(tenantScopeError(`${modelName}.bulkWrite ${kind} must not change tenantId`));
      }
    }
    return next();
  });

  schema.pre("insertMany", function guardInsertMany(next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    if (list.some((d) => !isTenantValue(d?.tenantId))) {
      return next(tenantScopeError(`${modelName}.insertMany`));
    }
    return next();
  });
}

export default tenantScopedPlugin;
