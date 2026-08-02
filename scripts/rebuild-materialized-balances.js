import dotenvFlow from "dotenv-flow";
import { connectDB, disconnectDB } from "../src/config/db.js";
import GLTransaction from "../src/models/glTransaction.model.js";
import MaterializedBalance from "../src/models/materializedBalance.model.js";

dotenvFlow.config();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function normalizeYear(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDateYear(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear();
}

function buildRollupKey(memberId, accountCode, bucket, year, ledgerDomain) {
  return `${memberId}|${accountCode}|${bucket}|${year}|${ledgerDomain}`;
}

// Mirrors rollupMemberBalances in src/controllers/journal.controller.js - keep both in sync.
function shouldIncludeEntry(entry) {
  return (
    !!entry?.periodBucket &&
    (!!entry?.memberId || !!entry?.applicationId || !!entry?.profileId)
  );
}

function entryMemberIdentifier(entry) {
  if (entry.memberId) return String(entry.memberId).trim();
  if (entry.applicationId) return `app:${String(entry.applicationId).trim()}`;
  if (entry.profileId) return `profile:${String(entry.profileId).trim()}`;
  return null;
}

function entryLedgerDomain(entry) {
  return entry?.ledgerDomain || "membership";
}

async function main() {
  const args = parseArgs(process.argv);
  const memberIdFilter = args.memberId ? String(args.memberId).trim() : null;
  const yearFilter = normalizeYear(args.year);
  const dryRun = Boolean(args.dryRun);

  await connectDB();
  try {
    const txns = await GLTransaction.find({})
      .select("date entries")
      .sort({ date: 1, createdAt: 1 })
      .lean();

    const totals = new Map();
    for (const txn of txns) {
      const year = normalizeDateYear(txn.date);
      if (year == null) continue;
      if (yearFilter != null && year !== yearFilter) continue;

      for (const entry of txn.entries || []) {
        if (!shouldIncludeEntry(entry)) continue;
        const identifier = entryMemberIdentifier(entry);
        if (!identifier) continue;
        if (memberIdFilter && identifier !== memberIdFilter) continue;

        const signed = entry.dc === "D" ? Number(entry.amount) || 0 : -(Number(entry.amount) || 0);
        if (!signed) continue;

        const key = buildRollupKey(
          identifier,
          entry.accountCode,
          entry.periodBucket,
          year,
          entryLedgerDomain(entry),
        );
        totals.set(key, (totals.get(key) || 0) + signed);
      }
    }

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            mode: "dryRun",
            docsToWrite: totals.size,
            memberIdFilter,
            yearFilter,
          },
          null,
          2
        )
      );
      return;
    }

    // Replaces the old {memberId, accountCode, bucket, year} unique index with one that also
    // includes ledgerDomain (see materializedBalance.model.js) - drops the stale index and
    // creates the new one. Must run before the rebuild below, otherwise the old index would
    // reject two docs that differ only by ledgerDomain.
    await MaterializedBalance.syncIndexes();

    const deleteQuery = {};
    if (yearFilter != null) deleteQuery.year = yearFilter;
    if (memberIdFilter) deleteQuery.memberId = memberIdFilter;
    await MaterializedBalance.deleteMany(deleteQuery);

    const ops = [];
    for (const [key, amount] of totals.entries()) {
      const [memberId, accountCode, bucket, yearRaw, ledgerDomain] = key.split("|");
      ops.push({
        updateOne: {
          filter: {
            memberId,
            accountCode,
            bucket,
            year: Number.parseInt(yearRaw, 10),
            ledgerDomain,
          },
          update: {
            $set: {
              amount,
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) {
      await MaterializedBalance.bulkWrite(ops, { ordered: false });
    }

    console.log(
      JSON.stringify(
        {
          mode: "rebuild",
          rebuiltDocuments: ops.length,
          memberIdFilter,
          yearFilter,
        },
        null,
        2
      )
    );
  } finally {
    await disconnectDB();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error.message,
        stack: error.stack,
      },
      null,
      2
    )
  );
  process.exit(1);
});
