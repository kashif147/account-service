import logger from "../config/logger.js";

/**
 * Best-effort HTTP push to notification-service (in addition to journal.created.v1).
 * Set NOTIFICATION_SERVICE_URL + NOTIFICATION_INTERNAL_API_KEY on account-service.
 */
export async function notifyMemberFinanceUpdated({
  tenantId,
  memberId,
  profileId,
  docType,
  docNo,
}) {
  const baseUrl = (process.env.NOTIFICATION_SERVICE_URL || "").trim();
  const apiKey = (process.env.NOTIFICATION_INTERNAL_API_KEY || "").trim();
  const tid = tenantId != null ? String(tenantId).trim() : "";
  const mid = memberId != null ? String(memberId).trim() : "";

  if (!baseUrl || !apiKey || !tid || !mid) {
    return false;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/internal/realtime/member-finance-updated`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": apiKey,
      },
      body: JSON.stringify({
        tenantId: tid,
        memberId: mid,
        ...(profileId ? { profileId } : {}),
        ...(docType ? { docType } : {}),
        ...(docNo ? { docNo } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, tenantId: tid, memberId: mid, body: text.slice(0, 200) },
        "notifyMemberFinanceUpdated: notification-service returned non-OK",
      );
      return false;
    }

    return true;
  } catch (err) {
    logger.warn(
      { err: err.message, tenantId: tid, memberId: mid },
      "notifyMemberFinanceUpdated: request failed",
    );
    return false;
  }
}
