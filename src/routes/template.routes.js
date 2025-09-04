// Template routes - replace with your service-specific routes
import express from "express";
import * as templateController from "../controllers/template.controller.js";
import * as healthController from "../controllers/health.controller.js";

const router = express.Router();

// Health endpoints
router.get("/health", healthController.getHealth);
router.get("/status", healthController.getStatus);

// Template CRUD endpoints
router.post("/templates", templateController.createTemplate);
router.get("/templates", templateController.listTemplates);
router.get("/templates/:id", templateController.getTemplate);
router.put("/templates/:id", templateController.updateTemplate);
router.delete("/templates/:id", templateController.deleteTemplate);

export default router;
