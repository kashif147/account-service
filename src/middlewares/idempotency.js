import { AppError } from "../errors/AppError.js";

const mem = new Map();

export function idempotency() {
  return (req, res, next) => {
    const key = req.header("Idempotency-Key");

    // If no key provided, continue without idempotency
    if (!key) return next();

    // Validate idempotency key format (optional)
    if (key.length < 8 || key.length > 128) {
      const validationError = AppError.badRequest(
        "Invalid Idempotency-Key format",
        {
          idempotencyError: true,
          keyLength: key.length,
          expectedRange: "8-128 characters",
        }
      );
      return res.status(validationError.status).json({
        error: {
          message: validationError.message,
          code: validationError.code,
          status: validationError.status,
          idempotencyError: validationError.idempotencyError,
          keyLength: validationError.keyLength,
          expectedRange: validationError.expectedRange,
        },
      });
    }

    // Add idempotency key to request context for services to use
    if (!req.ctx) req.ctx = {};
    req.ctx.idempotencyKey = key;

    // Check if we've seen this key before
    if (mem.has(key)) {
      const cachedResponse = mem.get(key);
      return res.status(200).json(cachedResponse);
    }

    // Intercept the response to cache it
    const origJson = res.json.bind(res);
    res.json = (body) => {
      // Cache the response for 5 minutes (300000ms)
      mem.set(key, body);
      setTimeout(() => mem.delete(key), 300000);
      return origJson(body);
    };

    next();
  };
}

// Utility function to clear idempotency cache (useful for testing)
export function clearIdempotencyCache() {
  mem.clear();
}

// Utility function to get cache size (useful for monitoring)
export function getIdempotencyCacheSize() {
  return mem.size;
}
