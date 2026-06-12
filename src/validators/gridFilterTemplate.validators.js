import { AppError } from "../errors/AppError.js";
import {
  CREDIT_NOTE_TEMPLATE_FILTER_KEYS,
  FILTER_OPERATOR,
  FINANCE_TEMPLATE_TYPES,
  GENERAL_LEDGER_TEMPLATE_FILTER_KEYS,
  JOURNAL_ADJUSTMENT_TEMPLATE_FILTER_KEYS,
  ONLINE_PAYMENT_TEMPLATE_FILTER_KEYS,
  RECONCILIATION_TEMPLATE_FILTER_KEYS,
  REFUNDS_TEMPLATE_FILTER_KEYS,
  WRITE_OFFS_TEMPLATE_FILTER_KEYS,
} from "../constants/gridTemplateEnums.js";

const VALID_OPERATORS = new Set(Object.values(FILTER_OPERATOR));

function validateFilterEntry(key, entry) {
  if (!entry || typeof entry !== "object") {
    throw AppError.badRequest(`Invalid filter entry for "${key}"`);
  }
  if (!VALID_OPERATORS.has(entry.operator)) {
    throw AppError.badRequest(`Invalid operator for filter "${key}"`);
  }
  if (!Array.isArray(entry.values) || entry.values.length === 0) {
    throw AppError.badRequest(`Filter "${key}" requires at least one value`);
  }
}

function allowedKeysForType(type) {
  if (type === "creditnotes") return CREDIT_NOTE_TEMPLATE_FILTER_KEYS;
  if (type === "journaladjustments") return JOURNAL_ADJUSTMENT_TEMPLATE_FILTER_KEYS;
  if (type === "onlinepayment") return ONLINE_PAYMENT_TEMPLATE_FILTER_KEYS;
  if (type === "refunds") return REFUNDS_TEMPLATE_FILTER_KEYS;
  if (type === "writeoffs") return WRITE_OFFS_TEMPLATE_FILTER_KEYS;
  if (type === "generalledger") return GENERAL_LEDGER_TEMPLATE_FILTER_KEYS;
  if (type === "reconciliation") return RECONCILIATION_TEMPLATE_FILTER_KEYS;
  return null;
}

function validateFiltersForType(templateType, filters = {}) {
  if (!filters || typeof filters !== "object") {
    throw AppError.badRequest("filters must be an object");
  }

  const type = String(templateType || "creditnotes").trim().toLowerCase();
  const allowedKeys = allowedKeysForType(type);

  for (const [key, entry] of Object.entries(filters)) {
    if (allowedKeys && !allowedKeys.includes(key)) {
      throw AppError.badRequest(`Unknown filter key "${key}" for ${type}`);
    }
    validateFilterEntry(key, entry);
  }
}

function resolveVisibleFilters(body = {}) {
  if (Array.isArray(body.visibleFilters)) return body.visibleFilters;
  if (Array.isArray(body.meta?.visibleToolbarFilters)) {
    return body.meta.visibleToolbarFilters;
  }
  return [];
}

export function validateCreateGridTemplate(body = {}) {
  const templateType = String(body.templateType || "creditnotes").trim();
  const normalizedType = templateType.toLowerCase();

  if (!FINANCE_TEMPLATE_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`Unsupported templateType: ${templateType}`);
  }

  validateFiltersForType(normalizedType, body.filters || {});

  const columns = Array.isArray(body.columns) ? body.columns : [];
  for (const col of columns) {
    if (typeof col !== "string" || !col.trim()) {
      throw AppError.badRequest("columns must be an array of non-empty strings");
    }
  }

  return {
    name: body.name != null && body.name !== "" ? String(body.name).trim() : null,
    templateType: normalizedType,
    filters: body.filters || {},
    columns,
    columnLabels:
      body.columnLabels && typeof body.columnLabels === "object"
        ? body.columnLabels
        : {},
    visibleFilters: resolveVisibleFilters(body),
    isDefault: Boolean(body.isDefault),
    pinned: Boolean(body.pinned),
  };
}

export function validateUpdateGridTemplate(body = {}) {
  const out = {};

  if (body.name !== undefined) {
    out.name = body.name !== "" ? String(body.name).trim() : null;
  }
  if (body.templateType !== undefined) {
    const normalizedType = String(body.templateType).trim().toLowerCase();
    if (!FINANCE_TEMPLATE_TYPES.includes(normalizedType)) {
      throw AppError.badRequest(`Unsupported templateType: ${body.templateType}`);
    }
    out.templateType = normalizedType;
  }
  if (body.filters !== undefined) {
    validateFiltersForType(
      out.templateType || body.templateType || "creditnotes",
      body.filters,
    );
    out.filters = body.filters;
  }
  if (body.columns !== undefined) {
    if (!Array.isArray(body.columns)) {
      throw AppError.badRequest("columns must be an array");
    }
    out.columns = body.columns;
  }
  if (body.columnLabels !== undefined) {
    out.columnLabels = body.columnLabels;
  }
  if (
    body.visibleFilters !== undefined ||
    body.meta?.visibleToolbarFilters !== undefined
  ) {
    out.visibleFilters = resolveVisibleFilters(body);
  }
  if (body.isDefault !== undefined) {
    out.isDefault = Boolean(body.isDefault);
  }
  if (body.pinned !== undefined) {
    out.pinned = Boolean(body.pinned);
  }

  return out;
}
