import express from "express";
import { forwardedInternalContext } from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { AppError } from "../errors/AppError.js";
import {
  requireInternalOrFinanceRead,
  requireInternalOrFinanceWrite,
} from "../middlewares/financePermission.middleware.js";
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

// Callers: subscription-service (reminder batch build/clear, year-end renewal and
// reinstatement write-offs) via x-internal-request worker requests, or with a forwarded CRM
// user identity. A user JWT never inherits the internal grant: user calls need finance
// read (eligibility snapshots) or finance write (write-off journal posting).
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
router.post("/members/writeoff", requireInternalOrFinanceWrite, internalWriteOff);

export default router;
