// Tenant Chart of Accounts provisioning (Phase 2B-PARALLEL-2, B4).
//
// Clones the platform template into tenant-owned CoA rows. Idempotent: existing rows for
// the tenant are never modified (a tenant may have renamed/flagged its own accounts), only
// missing codes are inserted. No balances or postings are created here.
import CoA from "../models/coa.model.js";
import { CHART_OF_ACCOUNTS_TEMPLATE } from "../config/chartOfAccountsTemplate.js";
import { requireTenantId } from "../helpers/tenantScope.js";

/**
 * @param {string} tenantId trusted tenant
 * @param {{ apply?: boolean, template?: object[] }} [options] apply=false reports only
 * @returns {Promise<{ tenantId: string, existing: number, missing: string[], inserted: number }>}
 */
export async function ensureTenantChartOfAccounts(tenantId, options = {}) {
  const tid = requireTenantId(tenantId);
  const { apply = true, template = CHART_OF_ACCOUNTS_TEMPLATE } = options;

  const existingRows = await CoA.find({ tenantId: tid }).select({ code: 1 }).lean();
  const have = new Set(existingRows.map((r) => r.code));
  const missing = template.filter((r) => !have.has(r.code));

  let inserted = 0;
  if (apply) {
    for (const r of missing) {
      const res = await CoA.updateOne(
        { tenantId: tid, code: r.code },
        { $setOnInsert: { ...r, tenantId: tid } },
        { upsert: true },
      );
      inserted += res.upsertedCount || 0;
    }
  }

  return {
    tenantId: tid,
    existing: existingRows.length,
    missing: missing.map((r) => r.code),
    inserted,
  };
}
