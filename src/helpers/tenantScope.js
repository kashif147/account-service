import { AppError } from "../errors/AppError.js";

function clean(v) {
  return v == null || String(v).trim() === "" ? null : String(v).trim();
}

/** Trusted tenant of an authenticated request (set by the auth middleware only). */
export function tenantOf(reqOrCtx) {
  if (!reqOrCtx) return null;
  if (typeof reqOrCtx === "string") return clean(reqOrCtx);
  return (
    clean(reqOrCtx.ctx?.tenantId) ||
    clean(reqOrCtx.tenantId) ||
    clean(reqOrCtx.user?.tenantId)
  );
}

/**
 * Trusted tenant or a 401. Ledger code paths call this instead of reading a tenant from
 * the body/query/params, and never run a ledger query without it.
 */
export function requireTenantId(reqOrCtxOrTenant) {
  const t = tenantOf(reqOrCtxOrTenant);
  if (!t) throw AppError.unauthorized("Tenant context required");
  return t;
}
