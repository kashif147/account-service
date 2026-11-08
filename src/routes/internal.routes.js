import express from "express";
import { forwardedInternalContext } from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { AppError } from "../errors/AppError.js";
import { requireInternalOrFinanceWrite } from "../middlewares/financePermission.middleware.js";
import { requireInternalOnly } from "../middlewares/callerScope.middleware.js";
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

// P6: the eligibility snapshots and payment-link diagnostics are INTERNAL-ONLY. Their only working caller
// is subscription-service (helpers/serviceClient.js fetchReminderEligibilityBulk, buildInternalServiceHeaders:
// x-internal-request + trusted tenant, never a user identity). No UI or user-token caller exists; the former
// user path admitted accounts.reports:read (IRO, no finance role). A user JWT - with or without a spoofed
// x-internal-request - is judged as that user (internalAuth) and refused here.
router.get(
  "/members/:memberId/reminder-eligibility",
  requireInternalOnly,
  reminderEligibility
);
router.post(
  "/members/reminder-eligibility-bulk",
  requireInternalOnly,
  reminderEligibilityBulk
);
// Write-off journal posting (subscription-service workers; unchanged): internal, or a user with finance write.
router.post("/members/writeoff", requireInternalOrFinanceWrite, internalWriteOff);

// Payment-link diagnostics (internal-only, P6): the trusted tenant (req.ctx) only, never a query/body tenant.
router.get("/payment-links", requireInternalOnly, async (req, res, next) => {
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
