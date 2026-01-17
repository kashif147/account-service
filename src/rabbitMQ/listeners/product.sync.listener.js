import logger from "../../config/logger.js";
import ProductType from "../../models/productType.model.js";
import Product from "../../models/product.model.js";
import Pricing from "../../models/pricing.model.js";

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

  if (!productTypeId || !tenantId) {
    logger.warn(
      { data },
      "Invalid product type payload: missing productTypeId or tenantId"
    );
    return;
  }

  await ProductType.updateOne(
    { _id: productTypeId, tenantId },
    {
      $set: {
        name: name || null,
        code: code ? String(code).toUpperCase() : null,
        description: description || null,
        status: status || null,
        isActive: isActive ?? true,
        isDeleted: isDeleted ?? false,
        tenantId,
        createdBy: createdBy || null,
        updatedBy: updatedBy || null,
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

  if (!productId || !tenantId) {
    logger.warn(
      { data },
      "Invalid product payload: missing productId or tenantId"
    );
    return;
  }

  await Product.updateOne(
    { _id: productId, tenantId },
    {
      $set: {
        name: name || null,
        code: code ? String(code).toUpperCase() : null,
        description: description || null,
        productTypeId: productTypeId || null,
        status: status || null,
        isActive: isActive ?? true,
        isDeleted: isDeleted ?? false,
        tenantId,
        createdBy: createdBy || null,
        updatedBy: updatedBy || null,
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

  if (!pricingId || !tenantId) {
    logger.warn(
      { data },
      "Invalid pricing payload: missing pricingId or tenantId"
    );
    return;
  }

  await Pricing.updateOne(
    { _id: pricingId, tenantId },
    {
      $set: {
        productId: productId || null,
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
        createdBy: createdBy || null,
        updatedBy: updatedBy || null,
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
