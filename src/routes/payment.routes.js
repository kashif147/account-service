import express from "express";
import { forwardedInternalContext } from "../middlewares/context.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { requireFinanceWrite } from "../middlewares/financePermission.middleware.js";
import { AppError } from "../errors/AppError.js";
import zodValidate from "../middlewares/zodValidate.js";
import { idempotency } from "../middlewares/idempotency.js";
import {
  createPaymentIntent,
  captureExistingPaymentIntent,
  cancelExistingPaymentIntent,
  attachRegistrationToExistingIntent,
  getLatestApplicationPayment,
  reconcilePayment,
  getPaymentByStripeId,
  recordExternalPayment,
  createPaymentRefund,
  listPaymentRefunds,
  listPaymentsBatch,
  associateMemberLinksForTransactions,
} from "../controllers/payment.controller.js";
import {
  zCreateIntent,
  zReconcile,
  zRecordExternal,
  zAssociateMemberLink,
} from "../models/payment.model.js";
import { zCreateRefund, zListRefundsQuery } from "../models/refund.model.js";

const router = express.Router();

// Same internalAuth pattern as internal.routes.js: gateway/JWT identity for user-originated
// calls, or forwarded internal-request headers for genuine service-to-service calls.
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

router.post(
  "/intents",
  idempotency(),
  zodValidate(zCreateIntent),
  createPaymentIntent
);

router.post(
  "/reconcile",
  idempotency(),
  zodValidate(zReconcile),
  reconcilePayment
);

router.get("/by-stripe/:paymentIntentId", getPaymentByStripeId);
router.get("/applications/:applicationId/latest", getLatestApplicationPayment);

router.post(
  "/intents/:paymentIntentId/capture",
  idempotency(),
  captureExistingPaymentIntent
);

router.post(
  "/intents/:paymentIntentId/cancel",
  idempotency(),
  cancelExistingPaymentIntent
);

// Attaches registrationId/productCode/eventCategoryCode to a Payment whose
// PaymentIntent was created directly against POST /intents by portal/mobile
// BEFORE the events-service Registration existed - see the comment on
// attachRegistrationToPaymentIntent in payments.service.js.
router.post(
  "/intents/:paymentIntentId/attach-registration",
  idempotency(),
  attachRegistrationToExistingIntent
);

// Gateway aggregation: list payments by member IDs (subscription service)
router.post("/batch", listPaymentsBatch);

router.post(
  "/associate-member",
  zodValidate(zAssociateMemberLink),
  associateMemberLinksForTransactions
);

router.post(
  "/record-external",
  idempotency(),
  zodValidate(zRecordExternal),
  recordExternalPayment
);

router.get(
  "/refunds",
  zodValidate(zListRefundsQuery),
  listPaymentRefunds
);

router.post(
  "/refunds",
  requireFinanceWrite,
  idempotency(),
  zodValidate(zCreateRefund),
  createPaymentRefund
);

export default router;
