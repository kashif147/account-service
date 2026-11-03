import express from "express";
import { forwardedInternalContext } from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { AppError } from "../errors/AppError.js";
import { requireInternalOrFinanceRead } from "../middlewares/financePermission.middleware.js";
import { requireTrustedInternalOnly } from "../middlewares/callerScope.middleware.js";
import {
  internalWriteOff,
  reminderEligibility,
  reminderEligibilityBulk,
} from "../controllers/internal.reminderEligibility.controller.js";

const router = express.Router();

function internalAuth(req, res, next) {
  if (req.headers.authorization || req.headers["x-jwt-verified"]) {
    return ensureAuthenticated(req, res, next);
  }
  if (req.header("x-internal-request") === "true") {
    return forwardedInternalContext(req, res, next);
  }
  return res.appError(AppError.unauthorized("Authorization header required"));
}

router.use(internalAuth);

// Callers: subscription-service (reminder batch build/clear) via x-internal-request worker
// requests, or with a forwarded CRM user identity. A user JWT never inherits the internal
// grant: user calls need finance read (eligibility snapshots).
router.get(
  "/members/:memberId/reminder-eligibility",
  requireInternalOrFinanceRead,
  reminderEligibility
);
router.post(
  "/members/reminder-eligibility-bulk",
  requireInternalOrFinanceRead,
  reminderEligibilityBulk
);
// Write-off journal (5200 D / 1400 C): INTERNAL ONLY. The only callers are subscription-service
// postMemberOutstandingWriteOff from the year-end archive (renewalBatch.service
// writeOffArchivedMemberBalances, tenant = the claimed YearEndBatch's tenant) and the
// suspended-reinstatement listener (subscription.upsert.listener, tenant = resolveEventTenant),
// both with createInternalWorkerReq(tenantId) -> x-internal-request + x-tenant-id only. No CRM or
// portal caller exists; CRM manual write-offs use the /journal routes under finance write.
// Any user identity (Bearer, gateway headers, forwarded x-user-*) -> 403 INTERNAL_ONLY.
router.post("/members/writeoff", requireTrustedInternalOnly, internalWriteOff);

// Payment-link diagnostics: the trusted tenant (req.ctx) only, never a query/body tenant.
router.get("/payment-links", requireInternalOrFinanceRead, async (req, res, next) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) return res.appError(AppError.unauthorized("Tenant context required"));
    const applicationId = String(req.query.applicationId || "").trim();
    if (!applicationId) return res.appError(AppError.badRequest("applicationId is required"));
    const { listPaymentLinks } = await import("../services/paymentLink.service.js");
    const links = await listPaymentLinks(String(tenantId), applicationId);
    return res.success(links);
  } catch (err) {
    return next(err);
  }
});

export default router;
