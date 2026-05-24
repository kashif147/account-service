import rateLimit from "express-rate-limit";

const windowMs = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000),
  10,
);
const max = parseInt(process.env.RATE_LIMIT_MAX || "600", 10);

/** Per-user when gateway forwards x-user-id; else first X-Forwarded-For hop or IP. */
function rateLimitKey(req) {
  const userId = req.headers["x-user-id"];
  if (userId) return `user:${userId}`;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

export const limiterGeneral = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: {
    status: "fail",
    message: "Too many requests — please wait a few minutes and try again",
    code: "TOO_MANY_REQUESTS",
  },
});

export const limiterSensitive = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_SENSITIVE_WINDOW_MS || String(10 * 60 * 1000), 10),
  max: parseInt(process.env.RATE_LIMIT_SENSITIVE_MAX || "120", 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: {
    status: "fail",
    message: "Too many requests — please wait a few minutes and try again",
    code: "TOO_MANY_REQUESTS",
  },
});
