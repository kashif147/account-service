// src/services/journal.service.js
import Journal from "../models/journal.model.js";
import Balance from "../models/balance.model.js";
import CoA from "../models/coa.model.js";
import { AppError } from "../errors/AppError.js";
import { requireTenantId } from "../helpers/tenantScope.js";

// Legacy Journal/Balance path (no current importer); tenant-scoped like the GL path.
export async function postJournal({ tenantId, date, memberId, entries, ref, tags }) {
  tenantId = requireTenantId(tenantId);
  // Validate each CoA code exists
  for (const e of entries) {
    const coa = await CoA.findOne({ tenantId, code: e.coaCode });
    if (!coa)
      throw AppError.badRequest(`Invalid CoA code ${e.coaCode}`, {
        coaCode: e.coaCode,
      });
  }

  const journal = await Journal.create({ tenantId, date, memberId, entries, ref, tags });

  // Update balances
  for (const e of entries) {
    const multiplier = e.drCr === "Dr" ? 1 : -1;

    await Balance.updateOne(
      { tenantId, memberId, coaCode: e.coaCode, bucket: "Current" },
      {
        $inc: {
          debit: e.drCr === "Dr" ? e.amount : 0,
          credit: e.drCr === "Cr" ? e.amount : 0,
          balance: multiplier * e.amount,
        },
      },
      { upsert: true },
    );
  }

  return journal;
}
