import express from "express";
import { ensureAuthenticated, tenantContextWarn } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { requireCrmUser } from "../middlewares/callerScope.middleware.js";
import { uploadSingleOptional } from "../middlewares/upload.mw.js";
import {
  createBatchDetail,
  deleteBatchDetail,
  getBatchDetailById,
  getAllBatchDetails,
  resolveBatchException,
  addPaymentToBatch,
  excludeBatchPaymentsToExceptions,
  processBatchDetail,
  getBatchQueueStats,
} from "../controllers/batch.detail.controller.js";

const router = express.Router();

router.use(ensureAuthenticated, tenantContextWarn);

// CRM staff only (403 CRM_ONLY in the standard envelope), then the PDP permission.
const requireCrm = requireCrmUser;

router.post(
  "/",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  uploadSingleOptional,
  createBatchDetail
);

router.get(
  "/queue-stats",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  getBatchQueueStats
);

router.get(
  "/",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  getAllBatchDetails
);

router.post(
  "/add-profile/:batchDetailId",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  addPaymentToBatch
);

router.post(
  "/exclude-payments/:batchDetailId",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  excludeBatchPaymentsToExceptions
);

router.post(
  "/resolve-exception/:batchDetailId",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  resolveBatchException
);

router.post(
  "/process/:batchDetailId",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  processBatchDetail
);

router.delete(
  "/:batchDetailId",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  deleteBatchDetail
);

router.get(
  "/:batchDetailId",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "read"),
  getBatchDetailById
);

export default router;
