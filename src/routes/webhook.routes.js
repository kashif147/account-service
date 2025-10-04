import express from "express";
import { handleStripeWebhook } from "../controllers/webhook.controller.js";

const router = express.Router({ strict: true });

// Stripe webhook endpoint - MUST use express.raw() for verification
router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

export default router;
