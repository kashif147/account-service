import express from "express";
import { forwardedInternalContext } from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { AppError } from "../errors/AppError.js";
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

router.get("/members/:memberId/reminder-eligibility", reminderEligibility);
router.post("/members/reminder-eligibility-bulk", reminderEligibilityBulk);
router.post("/members/writeoff", internalWriteOff);

export default router;
