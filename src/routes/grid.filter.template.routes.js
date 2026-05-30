import express from "express";
import { ensureAuthenticated } from "../middlewares/auth.js";
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

router.post("/", ensureAuthenticated, requireFinanceWrite, createTemplate);
router.get("/", ensureAuthenticated, requireFinanceRead, getUserTemplates);
router.get(
  "/default",
  ensureAuthenticated,
  requireFinanceRead,
  getDefaultTemplate,
);
router.get(
  "/:templateId",
  ensureAuthenticated,
  requireFinanceRead,
  getTemplateById,
);
router.put(
  "/:templateId",
  ensureAuthenticated,
  requireFinanceWrite,
  updateTemplate,
);
router.delete(
  "/:templateId",
  ensureAuthenticated,
  requireFinanceWrite,
  deleteTemplate,
);

export default router;
