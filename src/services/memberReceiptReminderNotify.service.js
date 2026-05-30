import { publisher } from "@projectShell/rabbitmq-middleware";
import logger from "../config/logger.js";

export const MEMBERSHIP_PAYMENT_RECEIPT_POSTED =
  "members.payment.receipt.posted.v1";

/**
 * Notify subscription-service that a member receipt was posted (may clear reminder pipeline).
 */
export async function notifyMemberPaymentReceiptPosted({
  tenantId,
  memberId,
  docNo,
  date,
}) {
  const mid = String(memberId || "").trim();
  const tid = tenantId != null ? String(tenantId).trim() : "";
  if (!mid || !tid) return;

  try {
    await publisher.publish(
      MEMBERSHIP_PAYMENT_RECEIPT_POSTED,
      {
        tenantId: tid,
        memberId: mid,
        docNo: docNo || null,
        asOf: date || new Date().toISOString(),
      },
      {
        tenantId: tid,
        exchange: "membership.events",
        routingKey: MEMBERSHIP_PAYMENT_RECEIPT_POSTED,
        metadata: { service: "account-service", version: "1.0" },
      }
    );
  } catch (err) {
    logger.warn(
      { err: err.message, memberId: mid, docNo },
      "notifyMemberPaymentReceiptPosted failed"
    );
  }
}
