import { AppError } from "../errors/AppError.js";
import {
  postManualEventPayment,
  postManualEventPaymentPost,
  voidManualEventPayment,
} from "../handlers/eventRegistration.approval.listener.js";

const ALLOWED_METHODS = ["manual", "comp", "invoice"];

// Records a manual/comp/invoice event payment. profileId is optional now -
// registrations are approval-gated (see events-service's registration-flow.md),
// so this defaults to deferPosting:true (no GL entry yet, profileId may still
// be unresolved). Pass deferPosting:false explicitly for the old
// immediate-post behavior.
export async function postManualEventPaymentHandler(req, res, next) {
  try {
    const tenantId = req.ctx?.tenantId || req.tenantId;
    const {
      registrationId,
      profileId,
      memberId,
      productCode,
      eventCategoryCode,
      amount,
      currency,
      method,
      deferPosting,
    } = req.body || {};

    if (!tenantId) return next(AppError.badRequest("tenantId is required"));
    if (!registrationId) return next(AppError.badRequest("registrationId is required"));
    if (deferPosting === false && !profileId) {
      return next(AppError.badRequest("profileId is required when deferPosting is false"));
    }
    if (amount == null || amount < 0) return next(AppError.badRequest("amount must be >= 0"));
    if (!ALLOWED_METHODS.includes(method)) {
      return next(AppError.badRequest(`method must be one of ${ALLOWED_METHODS.join(", ")}`));
    }

    const result = await postManualEventPayment({
      tenantId,
      registrationId,
      profileId,
      memberId,
      productCode,
      eventCategoryCode,
      amount,
      currency,
      method,
      userId: req.ctx?.userId || req.userId,
      ...(deferPosting === false ? { deferPosting: false } : {}),
    });

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to post manual event payment"));
  }
}

// Posts a previously-recorded (deferPosting:true) manual event payment to the
// GL, at CRM approval time once profileId is resolved. Called by
// events-service's /registrations/:id/approve.
export async function postManualEventPaymentPostHandler(req, res, next) {
  try {
    const tenantId = req.ctx?.tenantId || req.tenantId;
    const { paymentId, method, profileId, memberId } = req.body || {};

    if (!tenantId) return next(AppError.badRequest("tenantId is required"));
    if (!paymentId) return next(AppError.badRequest("paymentId is required"));
    if (!profileId) return next(AppError.badRequest("profileId is required"));
    if (!ALLOWED_METHODS.includes(method)) {
      return next(AppError.badRequest(`method must be one of ${ALLOWED_METHODS.join(", ")}`));
    }

    const result = await postManualEventPaymentPost({
      tenantId,
      paymentId,
      method,
      profileId,
      memberId,
      userId: req.ctx?.userId || req.userId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to post manual event payment to the GL"));
  }
}

// Voids a recorded-but-unposted manual/comp/invoice event payment on CRM
// rejection. Called by events-service's /registrations/:id/reject.
export async function voidManualEventPaymentHandler(req, res, next) {
  try {
    const tenantId = req.ctx?.tenantId || req.tenantId;
    const { paymentId } = req.body || {};

    if (!tenantId) return next(AppError.badRequest("tenantId is required"));
    if (!paymentId) return next(AppError.badRequest("paymentId is required"));

    const result = await voidManualEventPayment({
      tenantId,
      paymentId,
      userId: req.ctx?.userId || req.userId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to void manual event payment"));
  }
}
