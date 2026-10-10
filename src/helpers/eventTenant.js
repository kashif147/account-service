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
