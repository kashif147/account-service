import SepaReferenceSequence from "../models/sepaReferenceSequence.model.js";
import { AppError } from "../errors/AppError.js";

export const SEPA_MAX = {
  MSG_ID: 35,
  PMT_INF_ID: 35,
  END_TO_END_ID: 35,
  RUN_NO: 64,
};

const MONTH_ABBR = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

export const RUN_TYPE_LABELS = {
  MONTHLY: "MONTHLY",
  BI_WEEKLY: "BIWEEKLY",
  ANNUAL: "ANNUAL",
  AD_HOC: "ADHOC",
};

export function normalizeTenantCode(code, tenantIdFallback = "") {
  const raw = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (raw) return raw.slice(0, 12);
  const fallback = String(tenantIdFallback || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 8);
  return fallback || "TENANT";
}

export function runTypeLabel(runType) {
  return RUN_TYPE_LABELS[String(runType || "").toUpperCase()] || "MONTHLY";
}

/**
 * Period key for run numbering — YYYYMM for monthly/bi-weekly/ad hoc, YYYY for annual.
 */
export function derivePeriodKey(runType, periodEndDate) {
  const d = periodEndDate instanceof Date ? periodEndDate : new Date(periodEndDate);
  if (Number.isNaN(d.getTime())) {
    throw AppError.badRequest("Invalid period end date for periodKey");
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (String(runType || "").toUpperCase() === "ANNUAL") {
    return String(year);
  }
  return `${year}${month}`;
}

export function sanitizeAlphanumeric(value, maxLen = 35) {
  const s = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return s.slice(0, maxLen);
}

export function validateSepaReference(value, { maxLength, fieldName, allowHyphen = false }) {
  const errors = [];
  const s = String(value || "");
  if (!s) {
    errors.push(`${fieldName} is required`);
    return errors;
  }
  if (s.length > maxLength) {
    errors.push(`${fieldName} exceeds max length ${maxLength}`);
  }
  if (/\s/.test(s)) {
    errors.push(`${fieldName} must not contain spaces`);
  }
  const pattern = allowHyphen ? /^[A-Z0-9-]+$/ : /^[A-Z0-9]+$/;
  if (!pattern.test(s.toUpperCase())) {
    errors.push(`${fieldName} contains invalid characters for SEPA`);
  }
  return errors;
}

export function generateRunNo({ tenantCode, runType, periodKey, sequence }) {
  const code = normalizeTenantCode(tenantCode);
  const type = runTypeLabel(runType);
  const period = sanitizeAlphanumeric(periodKey, 8);
  const seq = String(sequence).padStart(3, "0");
  const runNo = `DD-${code}-${type}-${period}-${seq}`.toUpperCase();
  const errors = validateSepaReference(runNo, {
    maxLength: SEPA_MAX.RUN_NO,
    fieldName: "runNo",
    allowHyphen: true,
  });
  if (errors.length) {
    throw AppError.internalServerError(errors.join("; "));
  }
  return runNo;
}

export function buildRunNoScopeKey(tenantCode, runType, periodKey) {
  return `${normalizeTenantCode(tenantCode)}|${runTypeLabel(runType)}|${periodKey}`;
}

/**
 * MSG<TENANTCODE><YYYYMMDDHHMMSS><SEQ>
 * UTC timestamp, 3-digit sequence suffix.
 */
export function generateMessageId({ tenantCode, utcTimestamp = new Date(), sequence = 1 }) {
  const code = normalizeTenantCode(tenantCode);
  const d =
    utcTimestamp instanceof Date ? utcTimestamp : new Date(utcTimestamp);
  const ts = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
    String(d.getUTCHours()).padStart(2, "0"),
    String(d.getUTCMinutes()).padStart(2, "0"),
    String(d.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  const seq = String(sequence).padStart(3, "0");
  const msgId = sanitizeAlphanumeric(`MSG${code}${ts}${seq}`, SEPA_MAX.MSG_ID);
  const errors = validateSepaReference(msgId, {
    maxLength: SEPA_MAX.MSG_ID,
    fieldName: "messageId",
  });
  if (errors.length) {
    throw AppError.internalServerError(errors.join("; "));
  }
  return msgId;
}

export function buildMessageIdScopeKey(tenantCode, utcDate = new Date()) {
  const d = utcDate instanceof Date ? utcDate : new Date(utcDate);
  const day = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("");
  return `${normalizeTenantCode(tenantCode)}|${day}`;
}

/**
 * <TENANTCODE>-<MMMYY>-<SEQ> — AIB uses first 15 chars on statements.
 */
export function generatePaymentInformationId({
  tenantCode,
  collectionDate,
  sequence = 1,
}) {
  const code = normalizeTenantCode(tenantCode);
  const d =
    collectionDate instanceof Date
      ? collectionDate
      : new Date(collectionDate);
  const monthAbbr = MONTH_ABBR[d.getUTCMonth()] || "JAN";
  const yy = String(d.getUTCFullYear()).slice(-2);
  const seq = String(sequence).padStart(2, "0");
  const pmtInfId = `${code}-${monthAbbr}${yy}-${seq}`.toUpperCase();
  const errors = validateSepaReference(pmtInfId, {
    maxLength: SEPA_MAX.PMT_INF_ID,
    fieldName: "paymentInformationId",
    allowHyphen: true,
  });
  if (errors.length) {
    throw AppError.internalServerError(errors.join("; "));
  }
  return pmtInfId;
}

export function buildPmtInfScopeKey(tenantCode, collectionDate) {
  const d =
    collectionDate instanceof Date
      ? collectionDate
      : new Date(collectionDate);
  const monthAbbr = MONTH_ABBR[d.getUTCMonth()] || "JAN";
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${normalizeTenantCode(tenantCode)}|${monthAbbr}${yy}`;
}

function normalizeMemberNumber(membershipNumber) {
  return String(membershipNumber || "")
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/**
 * MEM<memberNo>-<YYYYMM> with DDTX-<runSeq>-<itemSeq> fallback.
 */
export function generateEndToEndId({
  membershipNumber,
  periodKey,
  runSequence,
  itemSequence,
}) {
  const period = sanitizeAlphanumeric(periodKey, 6);
  const memberNo = normalizeMemberNumber(membershipNumber);

  if (memberNo && period.length >= 6) {
    const id = `MEM${memberNo}-${period}`.slice(0, SEPA_MAX.END_TO_END_ID);
    const errors = validateSepaReference(id, {
      maxLength: SEPA_MAX.END_TO_END_ID,
      fieldName: "endToEndId",
      allowHyphen: true,
    });
    if (!errors.length) return id;
  }

  const runSeq = String(runSequence || 0).padStart(3, "0");
  const itemSeq = String(itemSequence || 0).padStart(4, "0");
  const fallback = `DDTX-${runSeq}-${itemSeq}`.slice(0, SEPA_MAX.END_TO_END_ID);
  return fallback;
}

export async function allocateSequence(tenantId, scope, scopeKey) {
  const doc = await SepaReferenceSequence.findOneAndUpdate(
    { tenantId, scope, scopeKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: { seq: 0 } },
  );
  return doc.seq;
}

export async function allocateRunNumberParts({
  tenantId,
  tenantCode,
  runType,
  periodEndDate,
}) {
  const periodKey = derivePeriodKey(runType, periodEndDate);
  const scopeKey = buildRunNoScopeKey(tenantCode, runType, periodKey);
  const runSequence = await allocateSequence(tenantId, "DD_RUN_NO", scopeKey);
  const runNo = generateRunNo({
    tenantCode,
    runType,
    periodKey,
    sequence: runSequence,
  });
  return { runNo, runSequence, periodKey, tenantCode: normalizeTenantCode(tenantCode) };
}

export async function allocateMessageId({ tenantId, tenantCode, utcTimestamp = new Date() }) {
  const scopeKey = buildMessageIdScopeKey(tenantCode, utcTimestamp);
  const sequence = await allocateSequence(tenantId, "DD_MSG_ID", scopeKey);
  const messageId = generateMessageId({ tenantCode, utcTimestamp, sequence });
  return { messageId, sequence };
}

export async function allocatePaymentInformationId({
  tenantId,
  tenantCode,
  collectionDate,
}) {
  const scopeKey = buildPmtInfScopeKey(tenantCode, collectionDate);
  const sequence = await allocateSequence(tenantId, "DD_PMT_INF", scopeKey);
  const paymentInformationId = generatePaymentInformationId({
    tenantCode,
    collectionDate,
    sequence,
  });
  return { paymentInformationId, sequence };
}

/**
 * Ensure EndToEndId uniqueness within a batch (and optionally against existing set).
 */
export function assignUniqueEndToEndIds({
  items,
  periodKey,
  runSequence,
  existingIds = new Set(),
}) {
  const used = new Set(existingIds);
  return items.map((item, idx) => {
    let endToEndId = generateEndToEndId({
      membershipNumber: item.membershipNumber ?? item.memberId,
      periodKey,
      runSequence,
      itemSequence: idx + 1,
    });

    if (used.has(endToEndId)) {
      endToEndId = generateEndToEndId({
        membershipNumber: null,
        periodKey,
        runSequence,
        itemSequence: idx + 1,
      });
    }

    let suffix = 1;
    while (used.has(endToEndId)) {
      const base = generateEndToEndId({
        membershipNumber: item.membershipNumber ?? item.memberId,
        periodKey,
        runSequence,
        itemSequence: idx + 1,
      });
      endToEndId = `${base}-${suffix}`.slice(0, SEPA_MAX.END_TO_END_ID);
      suffix += 1;
    }

    used.add(endToEndId);
    return { ...item, endToEndId };
  });
}
