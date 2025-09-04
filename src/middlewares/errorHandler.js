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

  // Handle Mongoose duplicate key errors
  if (err.code === 11000) {
    const conflictError = AppError.conflict("Duplicate entry", {
      field: Object.keys(err.keyPattern)[0],
      value: err.keyValue[Object.keys(err.keyPattern)[0]],
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
  const status = err.status || 500;
  const message = err.message || "Internal server error";

  res.serverError(message, { originalError: err });
}
