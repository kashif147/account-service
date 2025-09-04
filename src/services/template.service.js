// Template service - replace with your service-specific business logic
import Template from "../models/template.model.js";
import { AppError } from "../errors/AppError.js";
import { logInfo, logError } from "../middlewares/logger.mw.js";

export async function createTemplate(data) {
  try {
    logInfo("Creating template", { name: data.name });
    const template = await Template.create(data);
    return template;
  } catch (error) {
    logError("Template creation failed", { error: error.message });
    throw error;
  }
}

export async function getTemplateById(id) {
  const template = await Template.findById(id);
  if (!template) {
    throw AppError.notFound("Template not found", { id });
  }
  return template;
}

export async function updateTemplate(id, data) {
  const template = await Template.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });
  if (!template) {
    throw AppError.notFound("Template not found", { id });
  }
  return template;
}

export async function deleteTemplate(id) {
  const template = await Template.findByIdAndDelete(id);
  if (!template) {
    throw AppError.notFound("Template not found", { id });
  }
  return template;
}

export async function listTemplates(query = {}) {
  const { page = 1, limit = 10, status, search } = query;

  const filter = {};
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;

  const [templates, total] = await Promise.all([
    Template.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Template.countDocuments(filter),
  ]);

  return {
    templates,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit),
    },
  };
}
