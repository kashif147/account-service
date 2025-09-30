import { AppError } from "../errors/AppError.js";

export default function context(req, res, next) {
  const tenantId = req.header("x-tenant-id");
  const apiKey = req.header("x-api-key");
  const idempotencyKey = req.header("x-idempotency-key") || null;

  if (!tenantId) {
    return res.appError(AppError.unauthorized("Missing tenant id"));
  }

  const expectedKey = process.env.ACCOUNTS_API_KEY || "";
  const apiKeyOk = expectedKey && apiKey === expectedKey;
  if (!apiKeyOk) {
    return res.appError(AppError.unauthorized("Invalid API key"));
  }

  req.ctx = { tenantId, apiKeyOk: true, idempotencyKey };
  return next();
}
