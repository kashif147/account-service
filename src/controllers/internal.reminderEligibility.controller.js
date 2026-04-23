import { asyncHandler } from "../helpers/asyncHandler.js";
import { getReminderEligibilitySnapshot } from "../services/reminderEligibilityRead.service.js";
import { AppError } from "../errors/AppError.js";

const BULK_MAX = 5000;

/**
 * GET /api/internal/members/:memberId/reminder-eligibility?asOf=ISO
 * Requires x-tenant-id + x-api-key (see context middleware).
 */
export const reminderEligibility = asyncHandler(async (req, res) => {
  const { memberId } = req.params;
  const asOf = req.query.asOf;
  const data = await getReminderEligibilitySnapshot(memberId, asOf);
  res.success(data);
});

/**
 * POST /api/internal/members/reminder-eligibility-bulk
 * Body: { memberIds: string[], asOf?: string ISO }
 */
export const reminderEligibilityBulk = asyncHandler(async (req, res) => {
  const { memberIds, asOf } = req.body || {};
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw AppError.badRequest("memberIds must be a non-empty array");
  }
  const trimmed = memberIds
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const slice = trimmed.slice(0, BULK_MAX);
  const PARALLEL = 100;
  const items = [];
  for (let i = 0; i < slice.length; i += PARALLEL) {
    const part = slice.slice(i, i + PARALLEL);
    const partItems = await Promise.all(
      part.map((memberId) => getReminderEligibilitySnapshot(memberId, asOf))
    );
    items.push(...partItems);
  }
  res.success({
    items,
    truncated: trimmed.length > BULK_MAX,
    requested: trimmed.length,
  });
});
