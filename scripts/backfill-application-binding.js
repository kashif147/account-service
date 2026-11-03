/**
 * P5 (b9) - narrowly scoped backfill of Payment.applicationBinding for an OWNER-REVIEWED allow-list of
 * legacy portal application payments (purpose "subscriptionFee" + applicationId, created before
 * applicationBinding existed). Without the binding these rows fail closed on capture/cancel
 * (409 PAYMENT_APPLICATION_BINDING_UNVERIFIED, see src/helpers/applicationBinding.js).
 *
 * This script does NOT decide ownership. The independent evidence (portal-service subscriptiondetails
 * stored the same Stripe PaymentIntent for the same tenant + application, and its owner equals the
 * payment's creator) is reviewed out-of-band (scratchpad b8/b9 reconciliation) and encoded in the
 * allow-list file. account-service cannot re-prove it here: portal-service only serves that record to
 * the owning user (database-per-service; no cross-DB read). The script only re-checks, atomically, that
 * each allow-listed row is still EXACTLY the reviewed row.
 *
 * Allow-list file (JSON array, one entry per payment; never committed - DEV data):
 *   [{ "paymentId", "tenantId", "applicationId", "stripePaymentIntentId", "status",
 *      "createdBy", "evidenceRef" }]
 * Preconditions, per row, all inside ONE conditional update filter (race-safe):
 *   _id + tenantId + applicationId + purpose "subscriptionFee" + stripe.paymentIntentId + status
 *   + audit.createdBy all equal the reviewed values, and applicationBinding is absent/null.
 * Any other state (status moved, binding present, purpose/app/tenant/intent/creator differ) is REFUSED
 * for that row and reported; nothing else about the row is ever written.
 *
 * Safety:
 *   - dry run by default (plan + per-row verdicts, counts and masked ids only);
 *   - --execute requires --backup <new file> (written with flag "wx" BEFORE any update) and
 *     --expect-count N equal to the allow-list length (max 25) - a guard against a wrong file;
 *   - a ledger row per binding in account's own collection `p5_backfill_ledger`
 *     ({script, runId, paymentId, tenantId, field, value, evidenceRef, at}), written before the update;
 *   - idempotent: a row already bound to the same applicationId by an earlier run is reported
 *     ALREADY_BOUND_SAME and left alone; a second run binds nothing new;
 *   - --reverse --run-id <id> [--execute --backup <file>]: $unset applicationBinding ONLY on rows whose
 *     ledger entry belongs to that run AND whose applicationBinding still equals the ledgered value.
 *   Never captures, cancels, supersedes, or changes status/amount/purpose/profileId/memberId; never
 *   calls Stripe.
 *
 * Usage (inside dev-account-service; MONGO_URI from its environment, never printed):
 *   node scripts/backfill-application-binding.js --allow <file.json>
 *   node scripts/backfill-application-binding.js --allow <file.json> --expect-count 6 --execute --backup <new.json>
 *   node scripts/backfill-application-binding.js --reverse --run-id <id> [--execute --backup <new.json>]
 */
import fs from "fs";
import crypto from "crypto";

const SCRIPT = "backfill-application-binding";
export const LEDGER = "p5_backfill_ledger";
const MAX_ENTRIES = 25;
const OID = /^[0-9a-f]{24}$/i;
const FIELDS = ["paymentId", "tenantId", "applicationId", "stripePaymentIntentId", "status", "createdBy"];

const mask = (v) => {
  const s = String(v || "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "****";
};

/** Validates the allow-list shape. Returns { entries } or { error }. */
export function parseAllowList(raw) {
  let list;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { error: "ALLOW_LIST_NOT_JSON" };
  }
  if (!Array.isArray(list) || list.length === 0) return { error: "ALLOW_LIST_EMPTY" };
  if (list.length > MAX_ENTRIES) return { error: "ALLOW_LIST_TOO_LARGE" };
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== "object") return { error: "ALLOW_LIST_ENTRY_INVALID" };
    for (const f of FIELDS) if (typeof e[f] !== "string" || !e[f].trim()) return { error: `ALLOW_LIST_FIELD_MISSING:${f}` };
    if (!OID.test(e.paymentId) || !OID.test(e.tenantId)) return { error: "ALLOW_LIST_ID_INVALID" };
    if (seen.has(e.paymentId)) return { error: "ALLOW_LIST_DUPLICATE" };
    seen.add(e.paymentId);
  }
  return { entries: list.map((e) => ({ ...e, evidenceRef: String(e.evidenceRef || "") })) };
}

/** The exact precondition filter for one reviewed row (applicationBinding absent or null). */
export function preconditionFilter(e, ObjectId) {
  return {
    _id: new ObjectId(e.paymentId),
    tenantId: e.tenantId,
    applicationId: e.applicationId,
    purpose: "subscriptionFee",
    "stripe.paymentIntentId": e.stripePaymentIntentId,
    status: e.status,
    "audit.createdBy": e.createdBy,
    $or: [{ applicationBinding: { $exists: false } }, { applicationBinding: null }],
  };
}

/** Classifies a current row against its reviewed entry (pure; used for the plan and the report). */
export function verdict(row, e) {
  if (!row) return "NOT_FOUND";
  if (String(row.tenantId) !== e.tenantId) return "REFUSED_TENANT_CHANGED";
  if (String(row.applicationId || "") !== e.applicationId) return "REFUSED_APPLICATION_CHANGED";
  if (row.purpose !== "subscriptionFee") return "REFUSED_PURPOSE_CHANGED";
  if (String(row.stripe?.paymentIntentId || "") !== e.stripePaymentIntentId) return "REFUSED_INTENT_CHANGED";
  if (String(row.audit?.createdBy || "") !== e.createdBy) return "REFUSED_CREATOR_CHANGED";
  const b = row.applicationBinding;
  if (b != null && b !== "") return String(b) === e.applicationId ? "ALREADY_BOUND_SAME" : "REFUSED_BOUND_OTHER";
  if (row.status !== e.status) return "REFUSED_STATUS_CHANGED";
  return "BIND";
}

export async function run({ Payment, ledger, ObjectId }, opts = {}) {
  const { allowRaw, expectCount, execute = false, backup, reverse = false, runId: reverseRunId, log = () => {} } = opts;
  if (execute && !backup) return { ok: false, reason: "BACKUP_REQUIRED" };
  if (reverse) return runReverse({ Payment, ledger, ObjectId }, { execute, backup, runId: reverseRunId, log });

  const parsed = parseAllowList(allowRaw);
  if (parsed.error) return { ok: false, reason: parsed.error };
  const entries = parsed.entries;
  if (execute && Number(expectCount) !== entries.length) return { ok: false, reason: "EXPECT_COUNT_MISMATCH" };

  const rows = await Payment.find({ _id: { $in: entries.map((e) => new ObjectId(e.paymentId)) } })
    .select({ _id: 1, tenantId: 1, applicationId: 1, applicationBinding: 1, purpose: 1, status: 1, stripe: 1, audit: 1 })
    .lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const plan = entries.map((e) => ({ e, row: byId.get(e.paymentId), v: verdict(byId.get(e.paymentId), e) }));
  const counts = {};
  for (const p of plan) counts[p.v] = (counts[p.v] || 0) + 1;
  const report = { ok: true, executed: execute, entries: entries.length, counts, bound: 0, skippedConcurrent: 0, runId: null };
  for (const p of plan) log(`payment=${mask(p.e.paymentId)} application=${mask(p.e.applicationId)} -> ${p.v}`);
  log(`plan ${JSON.stringify(counts)}`);
  if (!execute) {
    log("DRY RUN: nothing written.");
    return report;
  }

  const toBind = plan.filter((p) => p.v === "BIND");
  const runId = `${SCRIPT}:${new Date().toISOString()}:${crypto.randomBytes(4).toString("hex")}`;
  report.runId = runId;
  fs.writeFileSync(
    backup,
    JSON.stringify(
      {
        script: SCRIPT,
        runId,
        takenAt: new Date().toISOString(),
        rows: toBind.map((p) => ({ _id: String(p.row._id), tenantId: p.row.tenantId, applicationId: p.row.applicationId, applicationBinding: p.row.applicationBinding ?? null, status: p.row.status })),
      },
      null,
      1,
    ),
    { flag: "wx" },
  );
  for (const p of toBind) {
    await ledger.insertOne({ script: SCRIPT, runId, op: "bind", paymentId: p.e.paymentId, tenantId: p.e.tenantId, field: "applicationBinding", value: p.e.applicationId, evidenceRef: p.e.evidenceRef, at: new Date() });
    const u = await Payment.collection.updateOne(preconditionFilter(p.e, ObjectId), { $set: { applicationBinding: p.e.applicationId } });
    if (u.modifiedCount === 1) report.bound += 1;
    else {
      report.skippedConcurrent += 1; // row changed between plan and update: refused, ledger marks it
      await ledger.updateOne({ runId, paymentId: p.e.paymentId, op: "bind" }, { $set: { outcome: "REFUSED_CHANGED_DURING_RUN" } });
    }
  }
  log(`runId=${runId} bound=${report.bound} skippedConcurrent=${report.skippedConcurrent}`);
  return report;
}

async function runReverse({ Payment, ledger, ObjectId }, { execute, backup, runId, log }) {
  if (!runId) return { ok: false, reason: "RUN_ID_REQUIRED" };
  const entries = await ledger.find({ runId, op: "bind", outcome: { $exists: false } }).toArray();
  const report = { ok: true, executed: execute, reverse: true, runId, ledgerEntries: entries.length, toUnset: 0, unset: 0, skippedChanged: 0 };
  const candidates = [];
  for (const l of entries) {
    const row = await Payment.findOne({ _id: new ObjectId(l.paymentId), tenantId: l.tenantId }).select({ applicationBinding: 1 }).lean();
    if (row && String(row.applicationBinding ?? "") === l.value) candidates.push(l);
    else report.skippedChanged += 1;
  }
  report.toUnset = candidates.length;
  log(`reverse runId=${runId} ledger=${entries.length} toUnset=${candidates.length} changedSince=${report.skippedChanged}`);
  if (!execute) {
    log("DRY RUN: nothing written.");
    return report;
  }
  fs.writeFileSync(backup, JSON.stringify({ script: SCRIPT, reverseOf: runId, takenAt: new Date().toISOString(), rows: candidates.map((l) => ({ _id: l.paymentId, tenantId: l.tenantId, applicationBinding: l.value })) }, null, 1), { flag: "wx" });
  for (const l of candidates) {
    const u = await Payment.collection.updateOne({ _id: new ObjectId(l.paymentId), tenantId: l.tenantId, applicationBinding: l.value }, { $unset: { applicationBinding: "" } });
    if (u.modifiedCount === 1) {
      report.unset += 1;
      await ledger.insertOne({ script: SCRIPT, runId: `${runId}:reverse`, op: "unbind", paymentId: l.paymentId, tenantId: l.tenantId, field: "applicationBinding", value: l.value, at: new Date() });
    } else report.skippedChanged += 1;
  }
  log(`reverse unset=${report.unset} skippedChanged=${report.skippedChanged}`);
  return report;
}

if (process.argv[1] && process.argv[1].endsWith(`${SCRIPT}.js`)) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(process.env.MONGO_URI);
  const { default: Payment } = await import("../src/models/payment.model.js");
  const allowFile = opt("--allow");
  const report = await run(
    { Payment, ledger: mongoose.connection.collection(LEDGER), ObjectId: mongoose.Types.ObjectId },
    {
      allowRaw: allowFile ? fs.readFileSync(allowFile, "utf8") : undefined,
      expectCount: opt("--expect-count"),
      execute: args.includes("--execute"),
      backup: opt("--backup"),
      reverse: args.includes("--reverse"),
      runId: opt("--run-id"),
      log: (l) => console.log(`[${SCRIPT}] ${l}`),
    },
  );
  console.log(`[${SCRIPT}] result ok=${report.ok}${report.reason ? ` reason=${report.reason}` : ""}`);
  await mongoose.disconnect();
  process.exit(report.ok ? 0 : 1);
}
