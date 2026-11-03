/**
 * P5 payer binding - explicit recovery entry point for PaymentIntent reservations
 * (payments.service.js sweepPaymentIntentReservations). NOT scheduled: nothing in the cron
 * runner, app start-up or any consumer calls it; wiring it into a scheduler is a separate,
 * reviewed change.
 *
 * Dry run (default) only READS: counts per reservation state, how many a run would touch, and
 * how many are terminal (needs_attention / no_intent_found). Nothing is written and Stripe is
 * not called.
 *
 * Usage (inside the account-service container; MONGO_URI/STRIPE_SECRET_KEY from its
 * environment, never printed):
 *   node scripts/sweep-payment-intent-reservations.js                         dry run
 *   node scripts/sweep-payment-intent-reservations.js --execute [--tenant <id>] [--limit N] [--max-attempts N]
 * Output: counts and masked reservation ids only. Never a PaymentIntent object or client_secret.
 */
const SCRIPT = "sweep-payment-intent-reservations";
const mask = (v) => {
  const s = String(v || "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "****";
};

/** Read-only summary used by the dry run. */
export async function summarize({ PaymentIntentReservation, now = new Date(), olderThanMs = 15 * 60 * 1000, tenantId = null }) {
  const scope = tenantId ? { tenantId: String(tenantId) } : {};
  const byState = {};
  for (const row of await PaymentIntentReservation.aggregate([{ $match: scope }, { $group: { _id: "$state", n: { $sum: 1 } } }])) {
    byState[row._id] = row.n;
  }
  const cutoff = new Date(now.getTime() - olderThanMs);
  const eligible = await PaymentIntentReservation.countDocuments({
    ...scope,
    $or: [
      { state: { $in: ["reserved", "intent_created", "orphaned"] }, updatedAt: { $lte: cutoff } },
      { state: "orphan_cancel_failed" },
    ],
  });
  return { byState, eligible, terminal: (byState.needs_attention || 0) + (byState.no_intent_found || 0) };
}

export async function run(deps, { execute = false, tenantId = null, limit = 100, maxAttempts = 5, log = () => {} } = {}) {
  const s = await summarize({ PaymentIntentReservation: deps.PaymentIntentReservation, tenantId });
  log(`states=${JSON.stringify(s.byState)} eligible=${s.eligible} terminal=${s.terminal}${tenantId ? ` tenant=${mask(tenantId)}` : ""}`);
  if (!execute) {
    log("DRY RUN: nothing written, Stripe not called.");
    return { ok: true, executed: false, ...s };
  }
  const out = await deps.sweep({ tenantId, limit, maxAttempts, log: (l) => log(l.replace(/[0-9a-f]{24}/g, (m) => mask(m))) });
  log(`result ${JSON.stringify(out)}`);
  return { ok: true, executed: true, ...s, result: out };
}

if (process.argv[1] && process.argv[1].endsWith(`${SCRIPT}.js`)) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(process.env.MONGO_URI);
  const { default: PaymentIntentReservation } = await import("../src/models/paymentIntentReservation.model.js");
  const { sweepPaymentIntentReservations } = await import("../src/services/payments.service.js");
  const report = await run(
    { PaymentIntentReservation, sweep: sweepPaymentIntentReservations },
    {
      execute: args.includes("--execute"),
      tenantId: opt("--tenant") || null,
      limit: Number(opt("--limit")) || 100,
      maxAttempts: Number(opt("--max-attempts")) || 5,
      log: (l) => console.log(`[${SCRIPT}] ${l}`),
    },
  );
  console.log(`[${SCRIPT}] ok=${report.ok} executed=${report.executed}`);
  await mongoose.disconnect();
  process.exit(report.ok ? 0 : 1);
}
