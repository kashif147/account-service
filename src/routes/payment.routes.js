import express from "express";
import { forwardedInternalContext } from "../middlewares/context.js";
import {
  ensureAuthenticated,
  ensureAuthenticatedWithTenantContext,
} from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import validate from "../middlewares/validate.js";
import { listPaymentAttemptsRules } from "../validators/paymentAttempts.validators.js";
import {
  requireFinanceRead,
  requireFinanceWrite,
  requireInternalOrFinanceDataRead,
  requireInternalOrFinanceWrite,
} from "../middlewares/financePermission.middleware.js";
import {
  requireCrmUser,
  requireInternalOrCrm,
  requireInternalOrCrmOrIntentOwner,
} from "../middlewares/callerScope.middleware.js";
import { AppError } from "../errors/AppError.js";
import zodValidate from "../middlewares/zodValidate.js";
import { idempotency } from "../middlewares/idempotency.js";
import { createRequirePaymentMutationAuthority, rejectMixedInternalIdentity } from "../middlewares/paymentMutationAuthority.middleware.js";
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
  listPaymentAttemptsHandler,
  listRefundOperationsHandler,
  reconcileRefundOperationsHandler,
} from "../controllers/payment.controller.js";
import {
  zCreateIntent,
  zReconcileRequest,
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
// P5: mixed identity on a payment mutation is refused before authentication (contract negative case).
router.post(["/intents/:paymentIntentId/capture", "/intents/:paymentIntentId/cancel"], rejectMixedInternalIdentity);

// CRM Online Payments grid: read-only list of every persisted Payment attempt (authorised /
// cancelled holds included, before any GL Receipt exists). Registered BEFORE
// router.use(internalAuth) so its chain is exactly the one on GET /journal/stripe-payments
// (user identity only - no x-internal-request path; PORTAL -> 403 CRM_ONLY before the PDP),
// plus `validate` so invalid / unknown query params are a 400.
router.get(
  "/attempts",
  ...ensureAuthenticatedWithTenantContext,
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  listPaymentAttemptsRules,
  validate,
  listPaymentAttemptsHandler
);

router.use(internalAuth);

// P5 caller rules (internalAuth above only establishes identity). "Internal" below means a
// genuine S2S call (x-internal-request, NO user JWT); events-/profile-/subscription-service
// forward the originating user's identity, so those calls are judged as that user.
//
// POST /intents stays open to PORTAL members: assertIntentAuthorized (paymentIntentGuard)
// already binds a portal caller's memberId/profileId/applicationId to the verified principal
// and checks the amount server-side.
router.post(
  "/intents",
  idempotency(),
  zodValidate(zCreateIntent),
  createPaymentIntent
);

// Re-syncs a Payment with Stripe. The body only identifies the PaymentIntent; amount/status
// are re-read from Stripe and the Payment lookup is pinned to the trusted tenant.
// Genuine S2S calls (x-internal-request, no user JWT) pass; user calls need finance write.
router.post(
  "/reconcile",
  requireInternalOrFinanceWrite,
  idempotency(),
  zodValidate(zReconcileRequest),
  reconcilePayment
);

// by-stripe: events-service (portal registration create, forwarding the member's identity),
// audit-service, CRM. A PORTAL caller may only read a Payment it created itself.
router.get(
  "/by-stripe/:paymentIntentId",
  requireInternalOrCrmOrIntentOwner,
  getPaymentByStripeId
);
// profile-service application approval (CRM) only.
router.get(
  "/applications/:applicationId/latest",
  requireInternalOrCrm,
  getLatestApplicationPayment
);

// capture / cancel: CRM approval / rejection flows (profile-service applications,
// events-service registrations) forwarding the CRM approver's identity, or internal S2S.
// Never a PORTAL member: capturing posts the GL. P5 containment: a CRM caller needs the exact
// business permission of the stored row's domain (application:write / events:write), never
// payments:write - see paymentMutationAuthority.middleware.js.
router.post(
  "/intents/:paymentIntentId/capture",
  requireInternalOrCrm,
  createRequirePaymentMutationAuthority("capture"),
  idempotency({ bindBody: true }),
  captureExistingPaymentIntent
);

router.post(
  "/intents/:paymentIntentId/cancel",
  requireInternalOrCrm,
  createRequirePaymentMutationAuthority("cancel"),
  idempotency({ bindBody: true }),
  cancelExistingPaymentIntent
);

// Attaches registrationId/productCode/eventCategoryCode to a Payment whose
// PaymentIntent was created directly against POST /intents by portal/mobile
// BEFORE the events-service Registration existed - see the comment on
// attachRegistrationToPaymentIntent in payments.service.js.
router.post(
  "/intents/:paymentIntentId/attach-registration",
  requireInternalOrCrmOrIntentOwner,
  idempotency(),
  attachRegistrationToExistingIntent
);

// Gateway aggregation: list payments by member IDs (subscription service)
// (CRM subscription grid aggregation, forwarding the CRM user's identity, or a worker.)
router.post("/batch", requireInternalOrCrm, listPaymentsBatch);

// CRM finance back-office manual backfill (AssociateMemberModal).
router.post(
  "/associate-member",
  requireCrmUser,
  requireFinanceWrite,
  zodValidate(zAssociateMemberLink),
  associateMemberLinksForTransactions
);

// Creates a succeeded Payment + GL journal: genuine internal S2S, or CRM finance write
// (Accounts Manager / Deputy / ASU role + finance write permission). Tenant is the trusted
// req.ctx tenant (recordExternal never reads a body tenant).
router.post(
  "/record-external",
  requireInternalOrCrm,
  requireInternalOrFinanceWrite,
  idempotency(),
  zodValidate(zRecordExternal),
  recordExternalPayment
);

router.get(
  "/refunds",
  requireInternalOrFinanceDataRead,
  zodValidate(zListRefundsQuery),
  listPaymentRefunds
);

// P5: refunds move money - CRM finance staff only. requireCrmUser (verified userType CRM, never
// a genuine internal call) before the unchanged finance role + permission check.
router.post(
  "/refunds",
  requireCrmUser,
  requireFinanceWrite,
  idempotency(),
  zodValidate(zCreateRefund),
  createPaymentRefund
);

// P5 refund operations: unresolved / uncertain refunds are visible to CRM finance (read), and
// reconciliation (read-only provider lookup; dry-run unless {apply:true}) is a finance write.
router.get("/refund-operations", requireCrmUser, requireFinanceRead, listRefundOperationsHandler);
router.post("/refund-operations/reconcile", requireCrmUser, requireFinanceWrite, reconcileRefundOperationsHandler);

export default router;
