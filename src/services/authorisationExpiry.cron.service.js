// Authorisation-expiry warnings (D5). Card holds on manual-capture PaymentIntents lapse at
// capture_before (about 7 days); Stripe then cancels the PI and approval can no longer capture.
// Every interval this finds application payments still at requires_capture whose hold ends
// within PAYMENT_AUTH_EXPIRY_WARN_HOURS (default 48) and announces it once through the outbox.
// Single-instance assumption, like the other in-process jobs (.claude/rules/background-jobs.md):
// a second instance is harmless because expiryWarnedAt is claimed atomically per payment.
import Payment from "../models/payment.model.js";
import { enqueueOutboxEvent } from "./outbox.service.js";
import logger from "../config/logger.js";

export async function warnExpiringAuthorisations({ now = new Date(), warnHours, limit = 200 } = {}) {
  const hours = Number(warnHours ?? process.env.PAYMENT_AUTH_EXPIRY_WARN_HOURS ?? 48);
  const horizon = new Date(now.getTime() + hours * 3600 * 1000);
  const candidates = await Payment.find({
    status: "requires_capture",
    applicationId: { $type: "string" },
    capturableUntil: { $type: "date", $lte: horizon },
    expiryWarnedAt: { $exists: false },
  })
    .select({ _id: 1, tenantId: 1, applicationId: 1, capturableUntil: 1, paymentLinkId: 1, linkVersion: 1, "stripe.paymentIntentId": 1 })
    .limit(limit)
    .lean();
  let warned = 0;
  for (const p of candidates) {
    const claim = await Payment.updateOne(
      { _id: p._id, status: "requires_capture", expiryWarnedAt: { $exists: false } },
      { $set: { expiryWarnedAt: now } },
    );
    if (!claim.modifiedCount) continue;
    const hoursLeft = Math.max(0, Math.round((new Date(p.capturableUntil) - now) / 3600000));
    await enqueueOutboxEvent({
      eventKey: `pay:${p._id}:expiring`,
      tenantId: String(p.tenantId),
      routingKey: "payments.application-payment.authorisation-expiring.v1",
      data: {
        applicationId: p.applicationId,
        paymentId: String(p._id),
        paymentIntentId: p.stripe?.paymentIntentId || null,
        paymentLinkId: p.paymentLinkId ? String(p.paymentLinkId) : null,
        linkVersion: p.linkVersion ?? null,
        capturableUntil: p.capturableUntil,
        hoursLeft,
      },
    });
    warned += 1;
  }
  return { scanned: candidates.length, warned };
}

let timer = null;
let stopped = true;
export function startAuthorisationExpiryCron({
  intervalMs = Number(process.env.PAYMENT_AUTH_EXPIRY_INTERVAL_MS || 60 * 60 * 1000),
} = {}) {
  if (!stopped) return;
  stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await warnExpiringAuthorisations();
      if (r.warned) logger.info(r, "Authorisation expiry warnings enqueued");
    } catch (err) {
      logger.warn({ error: err.message }, "Authorisation expiry scan failed");
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 60 * 1000);
}
export function stopAuthorisationExpiryCron() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
