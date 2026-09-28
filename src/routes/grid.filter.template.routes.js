import express from "express";
import { ensureAuthenticatedWithTenantContext } from "../middlewares/auth.js";
import {
  requireFinanceRead,
  requireFinanceWrite,
} from "../middlewares/financePermission.middleware.js";
import {
  createTemplate,
  deleteTemplate,
  getDefaultTemplate,
  getTemplateById,
  getUserTemplates,
  updateTemplate,
} from "../controllers/grid.filter.template.controller.js";

const router = express.Router();

router.post("/", ...ensureAuthenticatedWithTenantContext, requireFinanceWrite, createTemplate);
router.get("/", ...ensureAuthenticatedWithTenantContext, requireFinanceRead, getUserTemplates);
router.get(
  "/default",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceRead,
  getDefaultTemplate,
);
router.get(
  "/:templateId",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceRead,
  getTemplateById,
);
router.put(
  "/:templateId",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  updateTemplate,
);
router.delete(
  "/:templateId",
  ...ensureAuthenticatedWithTenantContext,
  requireFinanceWrite,
  deleteTemplate,
);

export default router;
