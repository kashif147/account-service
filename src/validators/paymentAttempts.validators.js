// GET /api/payments/attempts query validation (strict: unknown keys / values -> 400).
import { query } from "express-validator";
import { AppError } from "../errors/AppError.js";
import {
  ATTEMPT_MODES,
  ATTEMPT_PURPOSES,
  LIFECYCLE_STATUSES,
  MAX_LIMIT,
  decodeCursor,
} from "../services/paymentAttempts.service.js";

export const ATTEMPT_QUERY_KEYS = Object.freeze([
  "status",
  "purpose",
  "mode",
  "applicationId",
  "registrationId",
  "from",
  "to",
  "limit",
  "cursor",
]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Rejects any query key outside the allow-list (e.g. tenantId - scope is never caller-chosen). */
export function rejectUnknownAttemptQueryKeys(req, res, next) {
  const unknown = Object.keys(req.query || {}).filter((k) => !ATTEMPT_QUERY_KEYS.includes(k));
  if (!unknown.length) return next();
  return res.appError(
    AppError.badRequest(`Unknown query parameter(s): ${unknown.join(", ")}`, {
      code: "UNKNOWN_QUERY_PARAMETER",
    }),
  );
}

export const listPaymentAttemptsRules = [
  rejectUnknownAttemptQueryKeys,
  query("status")
    .optional()
    .isString()
    .withMessage("status must be a comma-separated string")
    .bail()
    .custom((v) => {
      const parts = String(v).split(",").map((s) => s.trim());
      if (!parts.length || parts.some((s) => !LIFECYCLE_STATUSES.includes(s))) {
        throw new Error(`status must be a comma-separated list of: ${LIFECYCLE_STATUSES.join(", ")}`);
      }
      return true;
    }),
  query("purpose").optional().isString().bail().isIn(ATTEMPT_PURPOSES),
  query("mode").optional().isString().bail().isIn(ATTEMPT_MODES),
  query("applicationId").optional().isString().bail().matches(ID_PATTERN),
  query("registrationId").optional().isString().bail().matches(ID_PATTERN),
  query("from").optional().isString().bail().isISO8601(),
  query("to").optional().isString().bail().isISO8601(),
  query("limit").optional().isString().bail().isInt({ min: 1, max: MAX_LIMIT }),
  query("cursor")
    .optional()
    .isString()
    .bail()
    .custom((v) => {
      if (!decodeCursor(v)) throw new Error("Invalid cursor");
      return true;
    }),
];
