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

const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;

/**
 * Strict tenant for the payment-link events (applications.payment-link.*, payments.payment-link.*,
 * payments.application-payment.*). Unlike resolveEventTenant there is no body fallback: the
 * envelope tenantId (set by the producer's publisher from its own trusted context) is required
 * and must be an internal ProjectShell tenant id; a data.tenantId, when present, must equal it.
 * A refused event is never written anywhere (the caller logs and acknowledges it).
 *
 * @returns {{ ok: true, tenantId: string } | { ok: false, reason: "missing_envelope_tenant"|"invalid_envelope_tenant"|"tenant_mismatch" }}
 */
export function requireEnvelopeTenant(payload) {
  const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : null);
  const envelope = clean(payload?.tenantId);
  const body = payload?.data && typeof payload.data === "object" ? clean(payload.data.tenantId) : "";
  if (envelope === null || (envelope && !INTERNAL_TENANT_ID.test(envelope))) return { ok: false, reason: "invalid_envelope_tenant" };
  if (!envelope) return { ok: false, reason: "missing_envelope_tenant" };
  if (body === null || (body && body !== envelope)) return { ok: false, reason: "tenant_mismatch" };
  return { ok: true, tenantId: envelope };
}
