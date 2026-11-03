/**
 * P5 payer binding - backfill Payment.registrationBinding for rows written before the binding
 * existed (legacy Stripe rows and manual/comp/invoice records), so they sit in the same
 * {tenantId, registrationBinding} unique index as every new row.
 *
 * The runtime does the same thing lazily (payments.service.js adoptLegacyRegistrationHolder,
 * before any claim on a registration), so this script is NOT required for correctness; it
 * closes the window eagerly and reports what needs a human.
 *
 * Rules (identical to adoptLegacyRegistrationHolder):
 * - a registration whose binding is already held: nothing to do;
 * - exactly one LIVE unbound row (not releasable - see isReleasableBindingRow): that row gets
 *   the binding, by a conditional update (only if still unbound) - never overwrites;
 * - no live row: nothing to bind (dead rows stay unbound);
 * - more than one live row: AMBIGUOUS - reported, NOTHING written (no guessed ownership). The
 *   runtime then refuses new attach/create for that registration (409
 *   REGISTRATION_BINDING_AMBIGUOUS) until CRM cancels/voids the wrong row.
 * Never deletes, cancels, supersedes or changes a status/amount.
 *
 * Usage (inside the account-service container; MONGO_URI from its environment, never printed):
 *   node scripts/backfill-registration-binding.js                     dry run (default): counts only
 *   node scripts/backfill-registration-binding.js --execute --backup <file.json>
 *       apply; the affected rows' {_id, tenantId, registrationId, status, mode} are written to
 *       --backup BEFORE any update (rollback = $unset registrationBinding on exactly those ids)
 * Output: counts and masked ids only.
 */
import fs from "fs";

const SCRIPT = "backfill-registration-binding";
const mask = (v) => {
  const s = String(v || "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "****";
};

/** Pure plan over Payment rows ({_id, tenantId, registrationId, registrationBinding, status, isActiveAttempt, mode}). */
export function planBackfill(rows, isReleasable) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.registrationId) continue;
    const k = `${r.tenantId}|${r.registrationId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const plan = { registrations: groups.size, alreadyBound: 0, toBind: [], noLiveRow: 0, ambiguous: [] };
  for (const [, g] of groups) {
    if (g.some((r) => typeof r.registrationBinding === "string" && r.registrationBinding)) {
      plan.alreadyBound += 1;
      continue;
    }
    const live = g.filter((r) => !isReleasable(r));
    if (live.length === 0) plan.noLiveRow += 1;
    else if (live.length === 1) plan.toBind.push(live[0]);
    else plan.ambiguous.push({ tenantId: g[0].tenantId, registrationId: g[0].registrationId, live: live.length });
  }
  return plan;
}

export async function run({ Payment, isReleasable }, { execute = false, backup, log = () => {} } = {}) {
  if (execute && !backup) return { ok: false, reason: "BACKUP_REQUIRED" };
  const rows = await Payment.find({ registrationId: { $type: "string", $ne: "" } })
    .select({ _id: 1, tenantId: 1, registrationId: 1, registrationBinding: 1, status: 1, isActiveAttempt: 1, mode: 1 })
    .lean();
  const plan = planBackfill(rows, isReleasable);
  const report = {
    ok: true,
    executed: execute,
    rowsWithRegistration: rows.length,
    manualRows: rows.filter((r) => r.mode === "external").length,
    registrations: plan.registrations,
    alreadyBound: plan.alreadyBound,
    toBind: plan.toBind.length,
    noLiveRow: plan.noLiveRow,
    ambiguous: plan.ambiguous.length,
    bound: 0,
    skippedConcurrent: 0,
  };
  log(`rows with registrationId=${report.rowsWithRegistration} (manual=${report.manualRows}) registrations=${report.registrations}`);
  log(`alreadyBound=${report.alreadyBound} toBind=${report.toBind} noLiveRow=${report.noLiveRow} ambiguous=${report.ambiguous}`);
  for (const a of plan.ambiguous) log(`AMBIGUOUS tenant=${mask(a.tenantId)} registration=${mask(a.registrationId)} liveRows=${a.live} (not written)`);
  if (!execute) {
    log("DRY RUN: nothing written.");
    return report;
  }
  fs.writeFileSync(
    backup,
    JSON.stringify({ script: SCRIPT, takenAt: new Date().toISOString(), rows: plan.toBind.map((r) => ({ _id: String(r._id), tenantId: r.tenantId, registrationId: r.registrationId, status: r.status, mode: r.mode || "stripe" })) }, null, 1),
    { flag: "wx" },
  );
  for (const r of plan.toBind) {
    try {
      const u = await Payment.updateOne(
        { _id: r._id, $or: [{ registrationBinding: { $exists: false } }, { registrationBinding: null }] },
        { $set: { registrationBinding: String(r.registrationId), bindingAdoptedAt: new Date() } },
      );
      if (u.modifiedCount === 1) report.bound += 1;
      else report.skippedConcurrent += 1;
    } catch (e) {
      if (e && e.code === 11000) report.skippedConcurrent += 1; // a live claim won meanwhile
      else throw e;
    }
  }
  log(`bound=${report.bound} skippedConcurrent=${report.skippedConcurrent}`);
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
  const Payment = (await import("../src/models/payment.model.js")).default;
  const { isReleasableBindingRow } = await import("../src/services/payments.service.js");
  const report = await run(
    { Payment, isReleasable: isReleasableBindingRow },
    { execute: args.includes("--execute"), backup: opt("--backup"), log: (l) => console.log(`[${SCRIPT}] ${l}`) },
  );
  console.log(`[${SCRIPT}] result ok=${report.ok}${report.reason ? ` reason=${report.reason}` : ""}`);
  await mongoose.disconnect();
  process.exit(report.ok ? 0 : 1);
}
