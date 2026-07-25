// src/controllers/payment.controller.js
import {
  createIntent,
  findByStripePaymentIntent,
  findLatestApplicationPayment,
  reconcileStripeEvent,
  capturePaymentIntent,
  cancelPaymentIntent,
  recordExternal,
  createRefund,
  listRefunds,
  listByMemberIds,
  associateMemberLinks,
} from "../services/payments.service.js";
import { AppError } from "../errors/AppError.js";

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
      return res.notFoundRecord("Payment not found");
    }
    res.success(doc);
  } catch (e) {
    next(e);
  }
}

export async function getLatestApplicationPayment(req, res, next) {
  try {
    const doc = await findLatestApplicationPayment(
      req.params.applicationId,
      req.ctx,
    );
    if (!doc) {
      return res.notFoundRecord("Payment not found");
    }
    res.success({
      id: doc._id.toString(),
      paymentIntentId: doc.stripe?.paymentIntentId || null,
      clientSecret: doc.stripe?.clientSecret || null,
      status: doc.status,
      stripeStatus: doc.stripe?.status || null,
      amount: doc.amount,
      currency: doc.currency,
      attemptNumber: doc.attemptNumber || 1,
      isActiveAttempt: doc.isActiveAttempt !== false,
      applicationId: doc.applicationId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    });
  } catch (e) {
    next(e);
  }
}

export async function captureExistingPaymentIntent(req, res, next) {
  try {
    const { profileId, memberId } = req.body || {};
    const result = await capturePaymentIntent(
      req.params.paymentIntentId,
      req.ctx,
      { profileId, memberId },
    );
    res.success(result);
  } catch (e) {
    next(e);
  }
}

export async function cancelExistingPaymentIntent(req, res, next) {
  try {
    const result = await cancelPaymentIntent(
      req.params.paymentIntentId,
      req.ctx,
    );
    res.success(result);
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

export async function listPaymentRefunds(req, res, next) {
  try {
    const result = await listRefunds(req.ctx, req.validated);
    res.success(result);
  } catch (e) {
    next(e);
  }
}

export async function associateMemberLinksForTransactions(req, res, next) {
  try {
    const result = await associateMemberLinks(req.validated, req.ctx);
    res.success(result);
  } catch (e) {
    next(e);
  }
}

/**
 * Batch list payments by member IDs (for gateway aggregation / subscription service).
 * POST /api/payments/batch
 * Body: { memberIds: string[], status?: string, purpose?: string }
 */
export async function listPaymentsBatch(req, res, next) {
  try {
    const { memberIds, status, purpose } = req.body || {};
    if (!memberIds || !Array.isArray(memberIds)) {
      return res.appError(AppError.badRequest("memberIds array is required"));
    }
    const payments = await listByMemberIds(memberIds, req.ctx, {
      status: status || undefined,
      purpose: purpose || undefined,
    });
    res.success(payments);
  } catch (e) {
    next(e);
  }
}
