import logger from "../config/logger.js";

export default function loggerMiddleware(req, res, next) {
  const startTime = Date.now();

  // Log request details
  const logData = {
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    userAgent: req.get("User-Agent"),
    ip: req.ip || req.connection.remoteAddress,
    requestId: req.id, // From requestId middleware
    user: req.user?.id, // From auth middleware
    tenantId: req.tenantId,
  };

  // Log request body for POST/PUT/PATCH (sanitized)
  if (
    ["POST", "PUT", "PATCH"].includes(req.method) &&
    req.body &&
    Object.keys(req.body).length
  ) {
    // Sanitize sensitive data
    const sanitizedBody = sanitizeRequestBody(req.body);
    logData.body = sanitizedBody;
  }

  // Log request
  logger.info(logData, `Incoming ${req.method} ${req.url}`);

  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function (chunk, encoding) {
    const duration = Date.now() - startTime;

    const responseLog = {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      requestId: req.id,
      user: req.user?.id,
      tenantId: req.tenantId,
    };

    // Log response based on status code
    if (res.statusCode >= 400) {
      logger.warn(
        responseLog,
        `Response ${res.statusCode} for ${req.method} ${req.url}`
      );
    } else {
      logger.info(
        responseLog,
        `Response ${res.statusCode} for ${req.method} ${req.url}`
      );
    }

    originalEnd.call(this, chunk, encoding);
  };

  next();
}

// Sanitize request body to remove sensitive data
function sanitizeRequestBody(body) {
  const sensitiveFields = [
    "password",
    "token",
    "secret",
    "key",
    "authorization",
  ];
  const sanitized = { ...body };

  sensitiveFields.forEach((field) => {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  });

  return sanitized;
}

// Utility function for manual logging
export function logInfo(message, data = {}) {
  logger.info(data, message);
}

export function logWarn(message, data = {}) {
  logger.warn(data, message);
}

export function logError(message, data = {}) {
  logger.error(data, message);
}

export function logDebug(message, data = {}) {
  logger.debug(data, message);
}
