import express from "express";
import context from "../middlewares/context.js";
import {
  internalWriteOff,
  reminderEligibility,
  reminderEligibilityBulk,
} from "../controllers/internal.reminderEligibility.controller.js";

const router = express.Router();

router.use(context);

router.get("/members/:memberId/reminder-eligibility", reminderEligibility);
router.post("/members/reminder-eligibility-bulk", reminderEligibilityBulk);
router.post("/members/writeoff", internalWriteOff);

export default router;
