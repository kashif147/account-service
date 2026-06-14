import { publisher } from "../rabbitMQ/index.js";
import logger from "../config/logger.js";

export const FINANCE_AUDIT_EVENT = "finance.audit.v1";

/**
 * Publish a member-centric finance audit event for audit-service.
 * Uses finance.events exchange; resource is keyed by profileId when available.
 */
export async function publishFinanceAudit({
  action,
  tenantId,
  profileId,
  memberId,
  actorId,
  actorEmail,
  before = null,
  after = null,
  metadata = {},
  correlationId,
}) {
  try {
    if (!tenantId || !action) return;

    const resourceId =
      profileId != null && String(profileId).trim()
        ? String(profileId).trim()
        : memberId != null && String(memberId).trim()
          ? String(memberId).trim()
          : null;

    await publisher.publish(
      FINANCE_AUDIT_EVENT,
      {
        action,
        tenantId: String(tenantId),
        profileId: profileId ? String(profileId) : undefined,
        memberId: memberId ? String(memberId) : undefined,
        actorId: actorId ? String(actorId) : undefined,
        actorEmail: actorEmail || undefined,
        resourceId,
        before,
        after,
        metadata,
      },
      {
        tenantId: String(tenantId),
        exchange: "finance.events",
        routingKey: FINANCE_AUDIT_EVENT,
        correlationId,
        metadata: { service: "account-service", version: "1.0", action },
      },
    );
  } catch (err) {
    logger.warn(
      { action, tenantId, err: err.message },
      "[FinanceAudit] publish failed",
    );
  }
}
