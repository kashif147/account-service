// src/services/journal.service.js
import Journal from "../models/journal.model.js";
import Balance from "../models/balance.model.js";
import CoA from "../models/coa.model.js";

export async function postJournal({ date, memberId, entries, ref, tags }) {
  // Validate each CoA code exists
  for (const e of entries) {
    const coa = await CoA.findOne({ code: e.coaCode });
    if (!coa) throw new Error(`Invalid CoA code ${e.coaCode}`);
  }

  const journal = await Journal.create({ date, memberId, entries, ref, tags });

  // Update balances
  for (const e of entries) {
    const multiplier = e.drCr === "Dr" ? 1 : -1;

    await Balance.updateOne(
      { memberId, coaCode: e.coaCode, bucket: "Current" },
      {
        $inc: {
          debit: e.drCr === "Dr" ? e.amount : 0,
          credit: e.drCr === "Cr" ? e.amount : 0,
          balance: multiplier * e.amount
        }
      },
      { upsert: true }
    );
  }

  return journal;
}
