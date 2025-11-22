// src/controllers/payment.controller.js
import {
  createIntent,
  findByStripePaymentIntent,
  reconcileStripeEvent,
  recordExternal,
  createRefund,
} from "../services/payments.service.js";

export async function createPaymentIntent(req, res, next) {
  try {
    const result = await createIntent(req.validated, req.ctx);
    res.success(result);
  } catch (e) {
    next(e);
  }
}

export async function reconcilePayment(req, res, next) {
  try {
    await reconcileStripeEvent(req.validated, req.ctx);
    res.success({ ok: true });
  } catch (e) {
    next(e);
  }
}

export async function getPaymentByStripeId(req, res, next) {
  try {
    const doc = await findByStripePaymentIntent(
      req.params.paymentIntentId,
      req.ctx
    );
    if (!doc) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }
    res.success(doc);
  } catch (e) {
    next(e);
  }
}

export async function recordExternalPayment(req, res, next) {
  try {
    const resp = await recordExternal(req.validated, req.ctx);
    res.success(resp);
  } catch (e) {
    next(e);
  }
}

export async function createPaymentRefund(req, res, next) {
  try {
    const resp = await createRefund(req.validated, req.ctx);
    res.success(resp);
  } catch (e) {
    next(e);
  }
}
