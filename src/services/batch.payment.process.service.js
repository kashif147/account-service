import XLSX from "xlsx";
import BatchDetail from "../models/batch.detail.model.js";
import { getProfileReadModel } from "../models/profileRead.model.js";
import * as azureBlob from "./azure.blob.service.js";
import logger from "../config/logger.js";

function memberFullNameFromPersonalInfo(pi) {
  if (!pi || typeof pi !== "object") return null;
  if (typeof pi.fullName === "string" && pi.fullName.trim()) {
    return pi.fullName.trim();
  }
  const parts = [pi.forename, pi.surname]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

const DEFAULT_COL = {
  MEMBERSHIP_NO: 0,
  LAST_NAME: 1,
  FIRST_NAME: 2,
  FULL_NAME: 3,
  VALUE_FOR_PERIOD: 4,
};

function getCell(row, index) {
  const v = row[index];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function findColumnIndex(headerRow, keywords) {
  if (!Array.isArray(headerRow)) return -1;
  for (let c = 0; c < headerRow.length; c++) {
    const cell = String(headerRow[c] || "").trim().toLowerCase();
    if (keywords.some((kw) => cell.includes(kw))) return c;
  }
  return -1;
}

export function parseRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) return [];
  const rows = XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  if (!rows.length) return [];
  const headerRow = rows[0];
  let membershipCol = DEFAULT_COL.MEMBERSHIP_NO;
  let lastCol = DEFAULT_COL.LAST_NAME;
  let firstCol = DEFAULT_COL.FIRST_NAME;
  let fullNameCol = DEFAULT_COL.FULL_NAME;
  let valueCol = DEFAULT_COL.VALUE_FOR_PERIOD;
  const membershipHeader = findColumnIndex(headerRow, [
    "membership",
    "member no",
    "member no.",
    "membership no",
    "membership no.",
  ]);
  if (membershipHeader >= 0) {
    membershipCol = membershipHeader;
    const lastIdx = findColumnIndex(headerRow, [
      "last name",
      "surname",
      "lastname",
    ]);
    const firstIdx = findColumnIndex(headerRow, [
      "first name",
      "forename",
      "firstname",
    ]);
    const fullIdx = findColumnIndex(headerRow, [
      "full name",
      "fullname",
      "name",
    ]);
    const valueIdx = findColumnIndex(headerRow, ["value", "amount", "period"]);
    if (lastIdx >= 0) lastCol = lastIdx;
    if (firstIdx >= 0) firstCol = firstIdx;
    if (fullIdx >= 0) fullNameCol = fullIdx;
    if (valueIdx >= 0) valueCol = valueIdx;
  }
  const dataRows = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const membershipNo = getCell(row, membershipCol);
    if (!membershipNo) continue;
    dataRows.push({
      rowIndex: i + 1,
      membershipNumber: membershipNo,
      lastName: getCell(row, lastCol),
      firstName: getCell(row, firstCol),
      fullName: getCell(row, fullNameCol),
      valueForPeriodSelected: (() => {
        const v = row[valueCol];
        if (v === undefined || v === null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
    });
  }
  return dataRows;
}

async function loadProfilesByMembership(tenantId, membershipNumbers) {
  const Profile = getProfileReadModel();
  const tenantFilter = tenantId ? { tenantId } : {};
  return Profile.find({
    ...tenantFilter,
    membershipNumber: { $in: membershipNumbers },
  })
    .select(
      "membershipNumber personalInfo contactInfo professionalDetails preferences"
    )
    .lean();
}

export async function processBatchDetail({ batchDetailId, tenantId }) {
  const batchDetail = await BatchDetail.findOne({
    _id: batchDetailId,
    isDeleted: false,
  });
  if (!batchDetail) {
    throw new Error("Batch detail not found");
  }
  if (!batchDetail.fileBlobPath) {
    throw new Error("No file attached to this batch detail");
  }
  if (!azureBlob.isConfigured) {
    throw new Error("Azure Storage is not configured");
  }

  const buffer = await azureBlob.downloadBlobToBuffer(batchDetail.fileBlobPath);
  const rows = parseRows(buffer);
  if (rows.length === 0) {
    batchDetail.batchPayments = [];
    batchDetail.batchExceptions = [];
    await batchDetail.save();
    return {
      paymentsCount: 0,
      exceptionsCount: 0,
      payments: [],
      exceptions: [],
      message: "No data rows found in file",
    };
  }

  const membershipNumbers = [...new Set(rows.map((r) => r.membershipNumber))];
  const profiles = await loadProfilesByMembership(tenantId, membershipNumbers);
  const profileByMembership = new Map(
    profiles.map((p) => [String(p.membershipNumber).trim(), p])
  );

  function toCents(euroVal) {
    if (euroVal == null || euroVal === "" || !Number.isFinite(Number(euroVal)))
      return null;
    const n = Number(euroVal);
    return n * 100;
  }

  function isValueMissingOrZero(val) {
    return val == null || val === "" || Number(val) === 0;
  }

  const batchPayments = [];
  const batchExceptions = [];
  for (const row of rows) {
    const normalizedMembership = String(row.membershipNumber).trim();
    const profile = profileByMembership.get(normalizedMembership);
    const valueMissingOrZero = isValueMissingOrZero(row.valueForPeriodSelected);
    const valueInCents = toCents(row.valueForPeriodSelected);

    if (profile && valueMissingOrZero) {
      batchExceptions.push({
        profileId: profile._id,
        membershipNumber: row.membershipNumber,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: row.fullName,
        valueForPeriodSelected: null,
        rowIndex: row.rowIndex,
      });
      continue;
    }

    if (profile) {
      const pi = profile.personalInfo || {};
      const ci = profile.contactInfo || {};
      const pd = profile.professionalDetails || {};
      const pref = profile.preferences || {};
      batchPayments.push({
        profileId: profile._id,
        membershipNumber: profile.membershipNumber || row.membershipNumber,
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
        forename: pi.forename ?? null,
        surname: pi.surname ?? null,
        fullName: memberFullNameFromPersonalInfo(pi),
        dateOfBirth: pi.dateOfBirth ?? null,
        gender: pi.gender ?? null,
        personalEmail: ci.personalEmail ?? null,
        workEmail: ci.workEmail ?? null,
        mobileNumber: ci.mobileNumber ?? null,
        fullAddress: ci.fullAddress ?? null,
        workLocation: pd.workLocation ?? null,
        grade: pd.grade ?? null,
        primarySection: pd.primarySection ?? null,
        valueAddedServices: pref.valueAddedServices ?? false,
        fileRow: {
          membershipNumber: row.membershipNumber,
          lastName: row.lastName,
          firstName: row.firstName,
          fullName: row.fullName,
          valueForPeriodSelected: valueInCents,
          rowIndex: row.rowIndex,
        },
      });
    } else {
      batchExceptions.push({
        membershipNumber: row.membershipNumber,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: row.fullName,
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
      });
    }
  }

  batchDetail.batchPayments = batchPayments;
  batchDetail.batchExceptions = batchExceptions;
  await batchDetail.save();

  return {
    paymentsCount: batchPayments.length,
    exceptionsCount: batchExceptions.length,
    payments: batchDetail.batchPayments,
    exceptions: batchDetail.batchExceptions,
    message: `Processed ${rows.length} rows: ${batchPayments.length} matched, ${batchExceptions.length} exceptions.`,
  };
}

export async function processBatchDetailWithBuffer(
  batchDetail,
  buffer,
  tenantId = null
) {
  const rows = parseRows(buffer);
  logger.info(
    {
      batchDetailId: batchDetail._id?.toString(),
      rowsCount: rows.length,
      tenantId: tenantId ?? "none",
    },
    "[BatchDetail] processBatchDetailWithBuffer: parsed file"
  );

  if (rows.length === 0) {
    batchDetail.batchPayments = [];
    batchDetail.batchExceptions = [];
    await batchDetail.save();
    return {
      paymentsCount: 0,
      exceptionsCount: 0,
      payments: [],
      exceptions: [],
      message: "No data rows found in file",
    };
  }

  const membershipNumbers = [...new Set(rows.map((r) => r.membershipNumber))];
  const profiles = await loadProfilesByMembership(tenantId, membershipNumbers);
  const profileByMembership = new Map(
    profiles.map((p) => [String(p.membershipNumber).trim(), p])
  );
  logger.info(
    {
      uniqueMembershipNumbers: membershipNumbers.length,
      profilesFound: profiles.length,
    },
    "[BatchDetail] processBatchDetailWithBuffer: profile lookup"
  );

  function toCents(euroVal) {
    if (euroVal == null || euroVal === "" || !Number.isFinite(Number(euroVal)))
      return null;
    const n = Number(euroVal);
    return n * 100;
  }

  function isValueMissingOrZero(val) {
    return val == null || val === "" || Number(val) === 0;
  }

  const batchPayments = [];
  const batchExceptions = [];
  for (const row of rows) {
    const normalizedMembership = String(row.membershipNumber).trim();
    const profile = profileByMembership.get(normalizedMembership);
    const valueMissingOrZero = isValueMissingOrZero(row.valueForPeriodSelected);
    const valueInCents = toCents(row.valueForPeriodSelected);

    if (profile && valueMissingOrZero) {
      batchExceptions.push({
        profileId: profile._id,
        membershipNumber: row.membershipNumber,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: row.fullName,
        valueForPeriodSelected: null,
        rowIndex: row.rowIndex,
      });
      continue;
    }

    if (profile) {
      const pi = profile.personalInfo || {};
      const ci = profile.contactInfo || {};
      const pd = profile.professionalDetails || {};
      const pref = profile.preferences || {};
      batchPayments.push({
        profileId: profile._id,
        membershipNumber: profile.membershipNumber || row.membershipNumber,
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
        forename: pi.forename ?? null,
        surname: pi.surname ?? null,
        fullName: memberFullNameFromPersonalInfo(pi),
        dateOfBirth: pi.dateOfBirth ?? null,
        gender: pi.gender ?? null,
        personalEmail: ci.personalEmail ?? null,
        workEmail: ci.workEmail ?? null,
        mobileNumber: ci.mobileNumber ?? null,
        fullAddress: ci.fullAddress ?? null,
        workLocation: pd.workLocation ?? null,
        grade: pd.grade ?? null,
        primarySection: pd.primarySection ?? null,
        valueAddedServices: pref.valueAddedServices ?? false,
        fileRow: {
          membershipNumber: row.membershipNumber,
          lastName: row.lastName,
          firstName: row.firstName,
          fullName: row.fullName,
          valueForPeriodSelected: valueInCents,
          rowIndex: row.rowIndex,
        },
      });
    } else {
      batchExceptions.push({
        membershipNumber: row.membershipNumber,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: row.fullName,
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
      });
    }
  }

  batchDetail.batchPayments = batchPayments;
  batchDetail.batchExceptions = batchExceptions;
  await batchDetail.save();

  return {
    paymentsCount: batchPayments.length,
    exceptionsCount: batchExceptions.length,
    payments: batchDetail.batchPayments,
    exceptions: batchDetail.batchExceptions,
    message: `Processed ${rows.length} rows: ${batchPayments.length} matched, ${batchExceptions.length} exceptions.`,
  };
}

/**
 * Maps a batch payment subdocument into a batch exception row (manual exclude from payments).
 */
export function batchPaymentEntryToException(payment) {
  if (!payment) return null;
  const fr = payment.fileRow || {};
  return {
    profileId: payment.profileId || null,
    membershipNumber: payment.membershipNumber,
    lastName: fr.lastName ?? payment.surname ?? null,
    firstName: fr.firstName ?? payment.forename ?? null,
    fullName: fr.fullName ?? payment.fullName ?? null,
    valueForPeriodSelected: fr.valueForPeriodSelected ?? null,
    rowIndex: fr.rowIndex ?? null,
  };
}

export function buildBatchPaymentEntryFromProfile(profile, fileRow) {
  const pi = profile.personalInfo || {};
  const ci = profile.contactInfo || {};
  const pd = profile.professionalDetails || {};
  const pref = profile.preferences || {};
  return {
    profileId: profile._id,
    membershipNumber: profile.membershipNumber || fileRow.membershipNumber,
    valueForPeriodSelected: fileRow.valueForPeriodSelected ?? null,
    rowIndex: fileRow.rowIndex ?? null,
    forename: pi.forename ?? null,
    surname: pi.surname ?? null,
    fullName: memberFullNameFromPersonalInfo(pi),
    dateOfBirth: pi.dateOfBirth ?? null,
    gender: pi.gender ?? null,
    personalEmail: ci.personalEmail ?? null,
    workEmail: ci.workEmail ?? null,
    mobileNumber: ci.mobileNumber ?? null,
    fullAddress: ci.fullAddress ?? null,
    workLocation: pd.workLocation ?? null,
    grade: pd.grade ?? null,
    primarySection: pd.primarySection ?? null,
    valueAddedServices: pref.valueAddedServices ?? false,
    fileRow: {
      membershipNumber: fileRow.membershipNumber ?? null,
      lastName: fileRow.lastName ?? null,
      firstName: fileRow.firstName ?? null,
      fullName: fileRow.fullName ?? null,
      valueForPeriodSelected: fileRow.valueForPeriodSelected ?? null,
      rowIndex: fileRow.rowIndex ?? null,
    },
  };
}
