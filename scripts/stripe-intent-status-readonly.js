/**
 * P5 (b9) - READ-ONLY Stripe status lookup for named Payment rows (e.g. the unprovable card holds).
 * Proposed only; run only with owner approval, inside dev-account-service (its configured Stripe key,
 * never printed).
 *
 * For each { tenantId, paymentId } in --list <file.json> it reads the stored Payment's
 * stripe.paymentIntentId and calls ONLY stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] }).
 * Output per row: masked payment id, PaymentIntent status, amount, currency, amount_capturable and the
 * card capture deadline (latest_charge.payment_method_details.card.capture_before) if Stripe returns it.
 * Never prints or stores client_secret, payment method details, customer or billing data. Writes
 * nothing (no DB write, no Stripe write; retrieve is a GET).
 *
 *   node scripts/stripe-intent-status-readonly.js --list <file.json>
 */
import fs from "fs";

const SCRIPT = "stripe-intent-status-readonly";
const OID = /^[0-9a-f]{24}$/i;
const mask = (v) => {
  const s = String(v || "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "****";
};

/** Allow-listed projection of a retrieved PaymentIntent; client_secret and PII can never appear. */
export function projectIntent(pi) {
  const ts = pi?.latest_charge?.payment_method_details?.card?.capture_before;
  return {
    status: pi?.status ?? null,
    amount: pi?.amount ?? null,
    currency: pi?.currency ?? null,
    amountCapturable: pi?.amount_capturable ?? null,
    captureBefore: typeof ts === "number" ? new Date(ts * 1000).toISOString() : null,
  };
}

export async function run({ Payment, stripe }, { listRaw, log = () => {} } = {}) {
  let list;
  try {
    list = JSON.parse(listRaw);
  } catch {
    return { ok: false, reason: "LIST_NOT_JSON" };
  }
  if (!Array.isArray(list) || !list.length || list.length > 25) return { ok: false, reason: "LIST_SIZE" };
  const out = [];
  for (const e of list) {
    if (!OID.test(String(e?.paymentId || "")) || !OID.test(String(e?.tenantId || ""))) return { ok: false, reason: "LIST_ID_INVALID" };
    const row = await Payment.findOne({ _id: e.paymentId, tenantId: e.tenantId }).select({ stripe: 1 }).lean();
    const pi = row?.stripe?.paymentIntentId;
    if (!pi) {
      out.push({ payment: mask(e.paymentId), error: "NO_STORED_INTENT" });
      continue;
    }
    try {
      const got = await stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge"] });
      out.push({ payment: mask(e.paymentId), ...projectIntent(got) });
    } catch (err) {
      out.push({ payment: mask(e.paymentId), error: err?.statusCode ? `STRIPE_${err.statusCode}` : "STRIPE_ERROR" });
    }
  }
  for (const r of out) log(JSON.stringify(r));
  return { ok: true, rows: out };
}

if (process.argv[1] && process.argv[1].endsWith(`${SCRIPT}.js`)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--list");
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(process.env.MONGO_URI);
  const { default: Payment } = await import("../src/models/payment.model.js");
  const { default: stripe } = await import("../src/lib/stripe.js");
  const report = await run({ Payment, stripe }, { listRaw: i >= 0 ? fs.readFileSync(args[i + 1], "utf8") : "", log: (l) => console.log(`[${SCRIPT}] ${l}`) });
  console.log(`[${SCRIPT}] result ok=${report.ok}${report.reason ? ` reason=${report.reason}` : ""}`);
  await mongoose.disconnect();
  process.exit(report.ok ? 0 : 1);
}
