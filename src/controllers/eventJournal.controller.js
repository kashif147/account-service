import { AppError } from "../errors/AppError.js";
import { postManualEventPayment } from "../handlers/eventRegistration.approval.listener.js";

const ALLOWED_METHODS = ["manual", "comp", "invoice"];

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
    } = req.body || {};

    if (!tenantId) return next(AppError.badRequest("tenantId is required"));
    if (!registrationId) return next(AppError.badRequest("registrationId is required"));
    if (!profileId) return next(AppError.badRequest("profileId is required"));
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
    });

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to post manual event payment"));
  }
}
