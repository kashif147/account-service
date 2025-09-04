// Template controller - replace with your service-specific endpoints
import { body, param, query } from "express-validator";
import validate from "../middlewares/validate.js";
import { asyncHandler } from "../helpers/asyncHandler.js";
import * as templateService from "../services/template.service.js";
import { logInfo } from "../middlewares/logger.mw.js";

export const createTemplate = [
  body("name").trim().isLength({ min: 1 }).withMessage("Name is required"),
  body("description").optional().trim(),
  body("status").optional().isIn(["active", "inactive", "pending"]),
  body("metadata").optional().isObject(),
  validate,
  asyncHandler(async (req, res) => {
    const template = await templateService.createTemplate(req.body);
    logInfo("Template created", { id: template._id, name: template.name });
    res.created(template);
  }),
];

export const getTemplate = [
  param("id").isMongoId().withMessage("Invalid template ID"),
  validate,
  asyncHandler(async (req, res) => {
    const template = await templateService.getTemplateById(req.params.id);
    res.success(template);
  }),
];

export const updateTemplate = [
  param("id").isMongoId().withMessage("Invalid template ID"),
  body("name").optional().trim().isLength({ min: 1 }),
  body("description").optional().trim(),
  body("status").optional().isIn(["active", "inactive", "pending"]),
  body("metadata").optional().isObject(),
  validate,
  asyncHandler(async (req, res) => {
    const template = await templateService.updateTemplate(
      req.params.id,
      req.body
    );
    logInfo("Template updated", { id: template._id, name: template.name });
    res.success(template);
  }),
];

export const deleteTemplate = [
  param("id").isMongoId().withMessage("Invalid template ID"),
  validate,
  asyncHandler(async (req, res) => {
    await templateService.deleteTemplate(req.params.id);
    logInfo("Template deleted", { id: req.params.id });
    res.success({ message: "Template deleted successfully" });
  }),
];

export const listTemplates = [
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("status").optional().isIn(["active", "inactive", "pending"]),
  query("search").optional().trim(),
  validate,
  asyncHandler(async (req, res) => {
    const result = await templateService.listTemplates(req.query);
    res.success(result);
  }),
];
