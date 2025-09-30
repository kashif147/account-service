import express from "express";
import context from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import zodValidate from "../middlewares/zodValidate.js";
import {
  createIntent,
  findByStripePaymentIntent,
  reconcileStripeEvent,
  recordExternal,
  createRefund,
} from "../services/payments.service.js";
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

router.post("/intents", zodValidate(zCreateIntent), async (req, res, next) => {
  try {
    const result = await createIntent(req.validated, req.ctx);
    res.success(result);
  } catch (e) {
    next(e);
  }
});

router.post("/reconcile", zodValidate(zReconcile), async (req, res, next) => {
  try {
    await reconcileStripeEvent(req.validated, req.ctx);
    res.success({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get("/by-stripe/:paymentIntentId", async (req, res, next) => {
  try {
    const doc = await findByStripePaymentIntent(
      req.params.paymentIntentId,
      req.ctx
    );
    if (!doc) return res.notFound("Payment not found");
    res.success(doc);
  } catch (e) {
    next(e);
  }
});

router.post(
  "/record-external",
  zodValidate(zRecordExternal),
  async (req, res, next) => {
    try {
      const resp = await recordExternal(req.validated, req.ctx);
      res.success(resp);
    } catch (e) {
      next(e);
    }
  }
);

router.post("/refunds", zodValidate(zCreateRefund), async (req, res, next) => {
  try {
    const resp = await createRefund(req.validated, req.ctx);
    res.success(resp);
  } catch (e) {
    next(e);
  }
});

export default router;
