/**
 * Provision a tenant's Chart of Accounts from the platform template
 * (src/config/chartOfAccountsTemplate.js). Inserts missing codes only; never edits or
 * removes existing tenant rows. DRY-RUN by default.
 *
 * Usage:
 *   MONGO_URI=... node scripts/provision-tenant-coa.js --tenant=<tenantId>           # report
 *   MONGO_URI=... node scripts/provision-tenant-coa.js --tenant=<tenantId> --apply   # insert
 *
 * Run once per new tenant before it posts any ledger entry (postings to a code the tenant
 * does not have are rejected as "Unknown account").
 */
import mongoose from "mongoose";
import { ensureTenantChartOfAccounts } from "../src/services/coaProvisioning.service.js";
import { assertMigrationTarget } from "./lib/migrationTargetGuard.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const tenantArg = args.find((a) => a.startsWith("--tenant="));
const tenantId = tenantArg ? tenantArg.slice("--tenant=".length).trim() : "";

async function main() {
  if (!tenantId) throw new Error("--tenant=<tenantId> is required");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI (or MONGODB_URI) is required");
  // autoIndex off: a report run must not build indexes as a side effect.
  await mongoose.connect(uri, { autoIndex: false });
  try {
    assertMigrationTarget(mongoose.connection.name, args, { apply: APPLY });
    const out = await ensureTenantChartOfAccounts(tenantId, { apply: APPLY });
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", ...out }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("provision-tenant-coa failed:", err.message);
  process.exit(1);
});
