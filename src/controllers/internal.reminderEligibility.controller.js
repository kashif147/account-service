import { asyncHandler } from "../helpers/asyncHandler.js";
import { getReminderEligibilitySnapshot } from "../services/reminderEligibilityRead.service.js";
import { AppError } from "../errors/AppError.js";
import { postBalancedJournal } from "./journal.controller.js";

const BULK_MAX = 5000;
const VALID_WRITE_OFF_BUCKETS = new Set(["arrears", "current"]);

/**
 * GET /api/internal/members/:memberId/reminder-eligibility?asOf=ISO
 * Gated by internal.routes.js's internalAuth: gateway/JWT auth, or x-internal-request: true
 * with forwardedInternalContext (x-tenant-id + forwarded user headers).
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

/**
 * POST /api/internal/members/writeoff
 * Body: { date, docNo, memberId, amount, periodBucket, memo? }
 */
export const internalWriteOff = asyncHandler(async (req, res) => {
  const {
    date,
    docNo,
    memberId,
    amount,
    periodBucket = "arrears",
    memo: bodyMemo,
  } = req.body || {};

  const resolvedMemberId = String(memberId || "").trim();
  const resolvedDocNo = String(docNo || "").trim();
  const resolvedAmount = Number(amount);
  const bucket = String(periodBucket || "").trim();

  if (!date || Number.isNaN(new Date(date).getTime())) {
    throw AppError.badRequest("date must be ISO (YYYY-MM-DD)");
  }
  if (!resolvedDocNo) {
    throw AppError.badRequest("docNo is required");
  }
  if (!resolvedMemberId) {
    throw AppError.badRequest("memberId is required");
  }
  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    throw AppError.badRequest("amount must be > 0");
  }
  if (!VALID_WRITE_OFF_BUCKETS.has(bucket)) {
    throw AppError.badRequest("periodBucket must be arrears or current");
  }

  const userMemo =
    bodyMemo != null && String(bodyMemo).trim() !== ""
      ? String(bodyMemo).trim()
      : "";
  const memo = userMemo ? `Write off (${userMemo})` : "Write off";

  const out = await postBalancedJournal({
    date,
    userId: req.ctx?.userId,
    tenantId: req.ctx?.tenantId,
    docType: "WriteOff",
    docNo: resolvedDocNo,
    memo,
    operation: "internal_writeoff",
    lines: [
      { accountCode: "5200", dc: "D", amount: resolvedAmount, adjSubType: "writeoff" },
      {
        accountCode: "1400",
        dc: "C",
        amount: resolvedAmount,
        memberId: resolvedMemberId,
        periodBucket: bucket,
      },
    ],
  });

  res.created(out);
});
