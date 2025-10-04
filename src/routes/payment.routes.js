import express from "express";
import context from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import zodValidate from "../middlewares/zodValidate.js";
import {
  createPaymentIntent,
  reconcilePayment,
  getPaymentByStripeId,
  recordExternalPayment,
  createPaymentRefund,
} from "../controllers/payment.controller.js";
import {
  zCreateIntent,
  zReconcile,
  zRecordExternal,
} from "../models/payment.model.js";
import { zCreateRefund } from "../models/refund.model.js";

const router = express.Router();

// Accept either API key context or JWT auth
router.use((req, res, next) => {
  if (req.headers["x-api-key"]) return context(req, res, next);
  return ensureAuthenticated(req, res, next);
});

router.post("/intents", zodValidate(zCreateIntent), createPaymentIntent);

router.post("/reconcile", zodValidate(zReconcile), reconcilePayment);

router.get("/by-stripe/:paymentIntentId", getPaymentByStripeId);

router.post(
  "/record-external",
  zodValidate(zRecordExternal),
  recordExternalPayment
);

router.post("/refunds", zodValidate(zCreateRefund), createPaymentRefund);

export default router;
