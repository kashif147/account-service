import { AppError } from "../errors/AppError.js";

export default function errorHandler(err, req, res, next) {
  // Handle AppError instances
  if (err instanceof AppError) {
    return res.appError(err);
  }

  // Handle Mongoose validation errors
  if (err.name === "ValidationError") {
    const validationError = AppError.badRequest("Validation failed", {
      details: Object.values(err.errors).map((e) => ({
        field: e.path,
        message: e.message,
        value: e.value,
      })),
    });
    return res.appError(validationError);
  }

  // Handle Mongoose duplicate key errors. Report the FULL compound key (not
  // just its first field) plus the collection/index name parsed out of
  // MongoDB's own error message - a compound unique index almost always has
  // more than one key, and reporting only the first (e.g. "tenantId", which
  // is the first field of nearly every compound index in this service) is
  // useless for telling two different indexes apart.
  if (err.code === 11000) {
    const collectionMatch = /collection:\s*([^\s]+)/.exec(err.message || "");
    const indexMatch = /index:\s*([^\s]+)/.exec(err.message || "");
    const conflictError = AppError.conflict("Duplicate entry", {
      collection: collectionMatch ? collectionMatch[1] : undefined,
      index: indexMatch ? indexMatch[1] : undefined,
      keyPattern: err.keyPattern,
      keyValue: err.keyValue,
      // Kept for backward compatibility with any existing caller reading
      // .field/.value directly.
      field: Object.keys(err.keyPattern || {})[0],
      value: err.keyValue?.[Object.keys(err.keyPattern || {})[0]],
    });
    return res.appError(conflictError);
  }

  // Handle JWT errors
  if (err.name === "JsonWebTokenError") {
    const authError = AppError.badRequest("Invalid token", {
      tokenError: true,
    });
    return res.appError(authError);
  }

  if (err.name === "TokenExpiredError") {
    const authError = AppError.badRequest("Token expired", {
      tokenExpired: true,
    });
    return res.appError(authError);
  }

  // Default error handling
  const message = err.message || "Internal server error";
  const isDevelopment = process.env.NODE_ENV !== "production";

  res.serverError(
    isDevelopment ? message : "Internal server error",
    isDevelopment ? { originalError: err.message, stack: err.stack } : {},
  );
}
