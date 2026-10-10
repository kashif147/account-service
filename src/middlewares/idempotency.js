import { AppError } from "../errors/AppError.js";

const mem = new Map();
const TTL_MS = 300000;

/**
 * Trusted tenant/user for scoping the cache. Only values set by the auth layer
 * (ensureAuthenticated / forwardedInternalContext, re-pinned by tenantContextWarn) —
 * never body/query.
 */
function trustedScope(req) {
  const tenantId = req.ctx?.tenantId || req.tenantId || null;
  const userId = req.ctx?.userId || req.userId || null;
  return { tenantId, userId };
}

function routeScope(req) {
  const method = String(req.method || "").toUpperCase();
  const base = req.baseUrl || "";
  const path = req.path || (req.originalUrl || req.url || "").split("?")[0];
  return `${method} ${base}${path}`;
}

/**
 * Cache key = tenant + user + method/route + Idempotency-Key. The client key alone is
 * never a cache key: two callers (or two tenants, or two routes) reusing the same
 * Idempotency-Key must never receive each other's response.
 */
export function buildIdempotencyCacheKey(req, key) {
  const { tenantId, userId } = trustedScope(req);
  if (!tenantId) return null;
  return JSON.stringify([
    String(tenantId),
    userId ? String(userId) : "internal",
    routeScope(req),
    key,
  ]);
}

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

    // No trusted tenant => no response cache (never share across callers).
    const cacheKey = buildIdempotencyCacheKey(req, key);
    if (!cacheKey) return next();

    // Check if we've seen this key before (same tenant + user + route)
    if (mem.has(cacheKey)) {
      const cached = mem.get(cacheKey);
      return res.status(cached.status).json(cached.body);
    }

    // Intercept the response to cache it — successful (2xx) responses only, so a
    // transient failure or validation error can be retried with the same key.
    const origJson = res.json.bind(res);
    res.json = (body) => {
      const status = Number(res.statusCode) || 200;
      if (status >= 200 && status < 300) {
        mem.set(cacheKey, { status, body });
        const t = setTimeout(() => mem.delete(cacheKey), TTL_MS);
        if (typeof t?.unref === "function") t.unref();
      }
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
