/**
 * Tenant for a consumed RabbitMQ message. The envelope's top-level `tenantId` (set by
 * rabbitmq-middleware's publisher from the producer's options.tenantId) is canonical;
 * `data.tenantId` is a legacy/body copy. Some producers (e.g. subscription-service's
 * members.subscription.current.updated.v1) only set the envelope, so reading `data` alone
 * loses the tenant. A disagreement between the two is logged and the envelope wins.
 *
 * @returns {{ tenantId: string|null, envelopeTenantId: string|null, dataTenantId: string|null, mismatch: boolean }}
 */
export function resolveEventTenant(payload, { logger, eventType } = {}) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const clean = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());
  const envelopeTenantId = payload?.data && typeof payload.data === "object"
    ? clean(payload?.tenantId)
    : null;
  const dataTenantId = clean(data?.tenantId);
  const tenantId = envelopeTenantId ?? dataTenantId;
  const mismatch = !!(envelopeTenantId && dataTenantId && envelopeTenantId !== dataTenantId);
  if (mismatch && logger) {
    logger.warn(
      {
        eventType: eventType || payload?.eventType,
        eventId: payload?.eventId,
        envelopeTenantId,
        dataTenantId,
      },
      "Event tenant mismatch: envelope tenantId differs from data.tenantId - using envelope",
    );
  }
  return { tenantId, envelopeTenantId, dataTenantId, mismatch };
}

export class EventTenantMismatchError extends Error {
  constructor({ eventType, eventId, envelopeTenantId, dataTenantId }) {
    super(
      `Event tenant mismatch (${eventType || "event"}): envelope tenant and data.tenantId differ`,
    );
    this.name = "EventTenantMismatchError";
    this.code = "EVENT_TENANT_MISMATCH";
    this.eventType = eventType;
    this.eventId = eventId;
    this.envelopeTenantId = envelopeTenantId;
    this.dataTenantId = dataTenantId;
  }
}

/**
 * Tenant for a consumer that posts to the general ledger. Same precedence as
 * resolveEventTenant (envelope canonical, data fallback when the envelope has none), but a
 * disagreement is never resolved by picking one side: it throws, so the consumer's
 * retry -> DLQ path quarantines the message for review instead of posting money under a
 * possibly wrong tenant. Returns null when neither carries a tenant (caller decides).
 */
export function resolveLedgerEventTenant(payload, { logger, eventType } = {}) {
  const r = resolveEventTenant(payload, { eventType });
  if (r.mismatch) {
    logger?.error?.(
      {
        eventType: eventType || payload?.eventType,
        eventId: payload?.eventId,
        envelopeTenantId: r.envelopeTenantId,
        dataTenantId: r.dataTenantId,
      },
      "Ledger event tenant mismatch - quarantining (no posting)",
    );
    throw new EventTenantMismatchError({
      eventType: eventType || payload?.eventType,
      eventId: payload?.eventId,
      envelopeTenantId: r.envelopeTenantId,
      dataTenantId: r.dataTenantId,
    });
  }
  return r.tenantId;
}
