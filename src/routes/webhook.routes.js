import express from "express";
import { handleStripeWebhook } from "../controllers/webhook.controller.js";

const router = express.Router({ strict: true });

// Stripe webhook endpoint
// Raw body is already captured at app level before this route
router.post("/stripe", handleStripeWebhook);

export default router;
