import { AppError } from "../errors/AppError.js";

/**
 * Phase A / A14 - temporary write freeze on shared (null-tenant) grid default templates.
 *
 * A system default template without a tenantId is shared by every tenant until the Phase E tenant
 * cutover. Until then no API caller - SU/ASU of any tenant included - may change it: any request that
 * would change one of its stored fields (content or the shared `pinned` flag), or delete it, answers
 * 423 GLOBAL_DATA_FROZEN. A user's own preference (`isDefault`: "use the system default as my default")
 * is stored on the user's templates, never on the shared row, and keeps working. Tenant-scoped system
 * defaults and user templates are not affected.
 * Ops rollback only: GLOBAL_DATA_WRITES=open (exact) in the service environment; nothing on a request
 * can reopen writes.
 */
export const GLOBAL_DATA_FROZEN = "GLOBAL_DATA_FROZEN";
const GLOBAL_DATA_FROZEN_MESSAGE = "Shared metadata is temporarily read-only during tenant migration";
const SHARED_ROW_FIELDS = ["name", "templateType", "filters", "columns", "columnLabels", "visibleFilters", "pinned"];

export const isGlobalDataFrozen = () => process.env.GLOBAL_DATA_WRITES !== "open";

const globalDataFrozenError = (resource = "gridTemplate") =>
  new AppError(GLOBAL_DATA_FROZEN_MESSAGE, 423, GLOBAL_DATA_FROZEN, { resource });

/** A system default with no owning tenant (shared by every tenant). */
export const isSharedDefaultTemplate = (template) =>
  !!template && template.systemDefault === true && (template.tenantId == null || template.tenantId === "");

/** True when the shared row is frozen (the caller must not save it). */
export const isFrozenSharedTemplate = (template) => isGlobalDataFrozen() && isSharedDefaultTemplate(template);

const plain = (v) => {
  if (v == null) return v;
  const o = typeof v.toObject === "function" ? v.toObject() : v;
  return JSON.parse(JSON.stringify(o));
};
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
};
const sameValue = (field, stored, proposed) => {
  if (field === "templateType") return String(stored || "").toLowerCase() === String(proposed || "").toLowerCase();
  if (field === "name") return (stored || null) === (proposed === "" ? null : proposed);
  if (field === "pinned") return !!stored === !!proposed;
  return stable(plain(stored) ?? null) === stable(plain(proposed) ?? null);
};

/** 423 when an update would change a frozen shared row. `isDefault` (per-user) is not a shared change. */
export const assertSharedTemplateUpdateAllowed = (template, updateData = {}) => {
  if (!isFrozenSharedTemplate(template)) return;
  for (const field of SHARED_ROW_FIELDS) {
    if (updateData[field] !== undefined && !sameValue(field, template[field], updateData[field])) {
      throw globalDataFrozenError();
    }
  }
};

/** 423 when deleting a frozen shared row. */
export const assertSharedTemplateDeleteAllowed = (template) => {
  if (isFrozenSharedTemplate(template)) throw globalDataFrozenError();
};
