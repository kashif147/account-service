import mongoose from "mongoose";
import Template from "../models/template.model.js";
import { AppError } from "../errors/AppError.js";

function toTemplateResponse(doc) {
  const obj =
    doc && typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete obj.meta;
  delete obj.__v;
  return obj;
}

function tenantOrLegacyMatch(tenantId) {
  if (!tenantId) return {};
  return {
    $or: [
      { tenantId },
      { tenantId: null },
      { tenantId: { $exists: false } },
    ],
  };
}

function toObjectIdOrSelf(id) {
  if (id == null) return id;
  const s = String(id);
  if (mongoose.isValidObjectId(s)) {
    return new mongoose.Types.ObjectId(s);
  }
  return id;
}

function clearSisterIsDefaultFlags(userId, templateType, excludeId, tenantId) {
  const uid = toObjectIdOrSelf(userId);
  const mq = {
    userId: uid,
    templateType,
    "meta.deleted": false,
    systemDefault: { $ne: true },
  };
  if (excludeId != null) {
    mq._id = { $ne: toObjectIdOrSelf(excludeId) };
  }
  Object.assign(mq, tenantOrLegacyMatch(tenantId));
  return Template.updateMany(mq, { $set: { isDefault: false } });
}

async function findSystemDefaultTemplateDoc(type, tenantId) {
  const base = {
    systemDefault: true,
    "meta.deleted": false,
    templateType: type,
  };
  if (tenantId) {
    const scoped = await Template.findOne({ ...base, tenantId });
    if (scoped) return scoped;
  }
  return Template.findOne({
    ...base,
    $or: [{ tenantId: null }, { tenantId: { $exists: false } }],
  });
}

class GridFilterTemplateService {
  async createTemplate(userId, templateData, tenantId = null) {
    const {
      name,
      templateType,
      filters,
      columns,
      columnLabels,
      isDefault,
      pinned,
    } = templateData;
    const type = templateType || "creditnotes";

    if (isDefault) {
      await clearSisterIsDefaultFlags(userId, type, null, tenantId);
    }

    const template = new Template({
      userId,
      tenantId: tenantId || undefined,
      name: name != null && name !== "" ? name : undefined,
      templateType: type,
      filters: filters || {},
      columns: columns || [],
      columnLabels: columnLabels || {},
      isDefault: isDefault || false,
      pinned: pinned || false,
    });

    const saved = await template.save();
    return toTemplateResponse(saved);
  }

  async getUserTemplatesWithSystemDefault(userId, type = "creditnotes", tenantId = null) {
    const typeFilter = { templateType: type };
    const systemDefault = await findSystemDefaultTemplateDoc(type, tenantId);

    const uq = {
      userId,
      "meta.deleted": false,
      ...typeFilter,
    };
    Object.assign(uq, tenantOrLegacyMatch(tenantId));

    const userTemplates = await Template.find(uq).sort({
      isDefault: -1,
      createdAt: -1,
    });

    const allTemplates = [];
    if (systemDefault) allTemplates.push(systemDefault);
    allTemplates.push(...userTemplates);
    return allTemplates;
  }

  async getTemplateById(templateId, userId, tenantId = null) {
    const systemDefault = await Template.findOne({
      _id: templateId,
      systemDefault: true,
      "meta.deleted": false,
    });

    if (systemDefault) {
      if (
        tenantId &&
        systemDefault.tenantId &&
        String(systemDefault.tenantId) !== String(tenantId)
      ) {
        throw AppError.notFound("Filter template not found");
      }
      const type = systemDefault.templateType || "creditnotes";
      const dq = {
        userId,
        templateType: type,
        isDefault: true,
        "meta.deleted": false,
      };
      Object.assign(dq, tenantOrLegacyMatch(tenantId));
      const userHasDefault = await Template.exists(dq);
      const out = toTemplateResponse(systemDefault);
      if (!userHasDefault) out.isDefault = true;
      return out;
    }

    const tq = { _id: templateId, userId, "meta.deleted": false };
    Object.assign(tq, tenantOrLegacyMatch(tenantId));

    const template = await Template.findOne(tq);
    if (!template) {
      throw AppError.notFound("Filter template not found");
    }
    return template;
  }

  async updateTemplate(
    templateId,
    userId,
    updateData,
    tenantId = null,
    allowSystemDefaultEdits = false,
  ) {
    const {
      name,
      templateType,
      filters,
      columns,
      columnLabels,
      isDefault,
      pinned,
    } = updateData;

    let template = await Template.findOne({
      _id: templateId,
      systemDefault: true,
      "meta.deleted": false,
    });

    if (
      template &&
      tenantId &&
      template.tenantId &&
      String(template.tenantId) !== String(tenantId)
    ) {
      template = null;
    }

    if (!template) {
      const tq = { _id: templateId, userId, "meta.deleted": false };
      Object.assign(tq, tenantOrLegacyMatch(tenantId));
      template = await Template.findOne(tq);
    }

    if (!template) {
      throw AppError.notFound("Filter template not found");
    }

    const type =
      templateType !== undefined && templateType !== null
        ? templateType
        : template.templateType || "creditnotes";

    if (template.systemDefault && !allowSystemDefaultEdits) {
      if (isDefault === true) {
        await clearSisterIsDefaultFlags(userId, type, null, tenantId);
      }
      if (pinned !== undefined) template.pinned = pinned;
      const saved = await template.save();
      const response = toTemplateResponse(saved);
      if (isDefault === true) response.isDefault = true;
      return response;
    }

    if (isDefault === true) {
      await clearSisterIsDefaultFlags(userId, type, template._id, tenantId);
    }

    if (name !== undefined) template.name = name !== "" ? name : null;
    if (templateType !== undefined) template.templateType = templateType;
    if (filters !== undefined) template.filters = filters;
    if (columns !== undefined) template.columns = columns;
    if (columnLabels !== undefined) template.columnLabels = columnLabels;
    if (isDefault !== undefined) template.isDefault = isDefault;
    if (pinned !== undefined) template.pinned = pinned;

    const saved = await template.save();
    return toTemplateResponse(saved);
  }

  async deleteTemplate(templateId, userId, tenantId = null) {
    const tq = { _id: templateId, userId, "meta.deleted": false };
    Object.assign(tq, tenantOrLegacyMatch(tenantId));

    const template = await Template.findOne(tq);
    if (!template) {
      throw AppError.notFound("Filter template not found");
    }

    template.meta.deleted = true;
    template.meta.deletedAt = new Date();
    return template.save();
  }

  async getDefaultTemplate(userId, tenantId = null) {
    const dq = { userId, isDefault: true, "meta.deleted": false };
    Object.assign(dq, tenantOrLegacyMatch(tenantId));
    return Template.findOne(dq);
  }
}

export default new GridFilterTemplateService();
