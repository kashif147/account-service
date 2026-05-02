import logger from "../../config/logger.js";
import ProductType from "../../models/productType.model.js";
import Product from "../../models/product.model.js";
import Pricing from "../../models/pricing.model.js";

const HEX_OBJECT_ID = /^[a-fA-F0-9]{24}$/;

/** Collapse populated / malformed refs to the same 24-char hex string user-service uses logically (BSON ObjectId). */
function normalizeRefId(value, label = "ref") {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const t = value.trim();
    if (HEX_OBJECT_ID.test(t)) return t;
    logger.warn(
      { label, sample: t.slice(0, 160) },
      "Pricing/product sync: invalid id string (expected 24 hex chars)"
    );
    return null;
  }
  if (typeof value === "object") {
    const nested = value._id ?? value.id;
    if (nested != null) return normalizeRefId(nested, label);
  }
  if (typeof value?.toString === "function") {
    const s = value.toString().trim();
    if (HEX_OBJECT_ID.test(s)) return s;
  }
  logger.warn({ label }, "Pricing/product sync: could not normalize ref id");
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function upsertProductType(data) {
  const {
    productTypeId,
    name,
    code,
    description,
    status,
    isActive,
    isDeleted,
    tenantId,
    createdBy,
    updatedBy,
    createdAt,
    updatedAt,
  } = data;

  const typeId = normalizeRefId(productTypeId, "productTypeId");
  if (!typeId || !tenantId) {
    logger.warn(
      { data },
      "Invalid product type payload: missing productTypeId or tenantId"
    );
    return;
  }

  await ProductType.updateOne(
    { _id: typeId, tenantId },
    {
      $set: {
        name: name || null,
        code: code ? String(code).toUpperCase() : null,
        description: description || null,
        status: status || null,
        isActive: isActive ?? true,
        isDeleted: isDeleted ?? false,
        tenantId,
        createdBy: normalizeRefId(createdBy, "createdBy"),
        updatedBy: normalizeRefId(updatedBy, "updatedBy"),
        createdAt: parseDate(createdAt),
        updatedAt: parseDate(updatedAt),
      },
    },
    { upsert: true }
  );
}

async function upsertProduct(data) {
  const {
    productId,
    name,
    code,
    description,
    productTypeId,
    status,
    isActive,
    isDeleted,
    tenantId,
    createdBy,
    updatedBy,
    createdAt,
    updatedAt,
  } = data;

  const pid = normalizeRefId(productId, "productId");
  const ptid = normalizeRefId(productTypeId, "productTypeId");
  if (!pid || !tenantId) {
    logger.warn(
      { data },
      "Invalid product payload: missing productId or tenantId"
    );
    return;
  }
  if (!ptid) {
    logger.warn(
      { data },
      "Invalid product payload: productTypeId missing or invalid — skip upsert"
    );
    return;
  }

  await Product.updateOne(
    { _id: pid, tenantId },
    {
      $set: {
        name: name || null,
        code: code ? String(code).toUpperCase() : null,
        description: description || null,
        productTypeId: ptid,
        status: status || null,
        isActive: isActive ?? true,
        isDeleted: isDeleted ?? false,
        tenantId,
        createdBy: normalizeRefId(createdBy, "createdBy"),
        updatedBy: normalizeRefId(updatedBy, "updatedBy"),
        createdAt: parseDate(createdAt),
        updatedAt: parseDate(updatedAt),
      },
    },
    { upsert: true }
  );
}

async function upsertPricing(data) {
  const {
    pricingId,
    productId,
    currency,
    price,
    memberPrice,
    nonMemberPrice,
    effectiveFrom,
    effectiveTo,
    status,
    isActive,
    isDeleted,
    tenantId,
    createdBy,
    updatedBy,
    createdAt,
    updatedAt,
  } = data;

  const rid = normalizeRefId(pricingId, "pricingId");
  const pid = normalizeRefId(productId, "productId");
  if (!rid || !tenantId) {
    logger.warn(
      { data },
      "Invalid pricing payload: missing pricingId or tenantId"
    );
    return;
  }
  if (!pid) {
    logger.warn(
      { data },
      "Invalid pricing payload: productId missing or not a 24-char hex id — skip upsert"
    );
    return;
  }

  await Pricing.updateOne(
    { _id: rid, tenantId },
    {
      $set: {
        productId: pid,
        currency: currency ? String(currency).toUpperCase() : null,
        price: price ?? null,
        memberPrice: memberPrice ?? null,
        nonMemberPrice: nonMemberPrice ?? null,
        effectiveFrom: parseDate(effectiveFrom),
        effectiveTo: parseDate(effectiveTo),
        status: status || null,
        isActive: isActive ?? true,
        isDeleted: isDeleted ?? false,
        tenantId,
        createdBy: normalizeRefId(createdBy, "createdBy"),
        updatedBy: normalizeRefId(updatedBy, "updatedBy"),
        createdAt: parseDate(createdAt),
        updatedAt: parseDate(updatedAt),
      },
    },
    { upsert: true }
  );
}

export async function handleProductTypeCreated(payload) {
  try {
    await upsertProductType(payload.data || {});
    logger.info("Product type created synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling product type created event"
    );
    throw error;
  }
}

export async function handleProductTypeUpdated(payload) {
  try {
    await upsertProductType(payload.data || {});
    logger.info("Product type updated synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling product type updated event"
    );
    throw error;
  }
}

export async function handleProductTypeDeleted(payload) {
  try {
    const data = payload.data || {};
    await upsertProductType({
      ...data,
      isDeleted: true,
      isActive: false,
      status: data.status || "Inactive",
    });
    logger.info("Product type deleted synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling product type deleted event"
    );
    throw error;
  }
}

export async function handleProductCreated(payload) {
  try {
    await upsertProduct(payload.data || {});
    logger.info("Product created synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling product created event"
    );
    throw error;
  }
}

export async function handleProductUpdated(payload) {
  try {
    await upsertProduct(payload.data || {});
    logger.info("Product updated synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling product updated event"
    );
    throw error;
  }
}

export async function handleProductDeleted(payload) {
  try {
    const data = payload.data || {};
    await upsertProduct({
      ...data,
      isDeleted: true,
      isActive: false,
      status: data.status || "Inactive",
    });
    logger.info("Product deleted synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling product deleted event"
    );
    throw error;
  }
}

export async function handlePricingCreated(payload) {
  try {
    await upsertPricing(payload.data || {});
    logger.info("Pricing created synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling pricing created event"
    );
    throw error;
  }
}

export async function handlePricingUpdated(payload) {
  try {
    await upsertPricing(payload.data || {});
    logger.info("Pricing updated synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling pricing updated event"
    );
    throw error;
  }
}

export async function handlePricingDeleted(payload) {
  try {
    const data = payload.data || {};
    await upsertPricing({
      ...data,
      isDeleted: true,
      isActive: false,
      status: data.status || "Inactive",
    });
    logger.info("Pricing deleted synced");
  } catch (error) {
    logger.error(
      { error: error.message },
      "Error handling pricing deleted event"
    );
    throw error;
  }
}
