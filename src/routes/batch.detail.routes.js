import express from "express";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { uploadSingleOptional } from "../middlewares/upload.mw.js";
import {
  createBatchDetail,
  getBatchDetailById,
  getAllBatchDetails,
  resolveBatchException,
  addPaymentToBatch,
  processBatchDetail,
} from "../controllers/batch.detail.controller.js";

const router = express.Router();

router.use(ensureAuthenticated);

function requireCrm(req, res, next) {
  if (req.user?.userType !== "CRM") {
    return res.status(403).json({
      success: false,
      message: "Only CRM users can perform this action on batch details",
    });
  }
  next();
}

router.post(
  "/",
  requireCrm,
  defaultPolicyMiddleware.requirePermission("accounts.journals", "create"),
  uploadSingleOptional,
  createBatchDetail
);

router.get(
  "/",
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

router.get("/:batchDetailId", getBatchDetailById);

export default router;
