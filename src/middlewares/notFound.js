import { AppError } from "../errors/AppError.js";

export default function notFound(req, res, next) {
  const notFoundError = AppError.notFound(
    `Route ${req.method} ${req.originalUrl} not found`,
    {
      method: req.method,
      url: req.originalUrl,
      path: req.path,
    }
  );

  res.status(notFoundError.status).json({
    error: {
      message: notFoundError.message,
      code: notFoundError.code,
      status: notFoundError.status,
      method: notFoundError.method,
      url: notFoundError.url,
      path: notFoundError.path,
    },
  });
}
