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

/** Prefer name from the uploaded row; else CRM profile. */
function fullNameFromFileOrProfile(row, pi) {
  const fromFile =
    row?.fullName != null && String(row.fullName).trim() !== ""
      ? String(row.fullName).trim()
      : null;
  if (fromFile) {
    return fromFile;
  }
  return memberFullNameFromPersonalInfo(pi) || null;
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

/**
 * Read a cell as displayed in Excel: use cached `w` or `format_cell` (shared strings,
 * custom formats) so alphanumerics like B0000S are not misread from the row array.
 */
function getTextFromSheetCell(sheet, row0Based, col0Based, rowFallback, colIndex) {
  if (!sheet || row0Based < 0 || col0Based < 0) {
    return getCell(rowFallback, colIndex);
  }
  const addr = XLSX.utils.encode_cell({ r: row0Based, c: col0Based });
  const cell = sheet[addr];
  if (cell == null || cell.t === "z" || cell.t === "e") {
    return getCell(rowFallback, colIndex);
  }
  if (cell.w != null && String(cell.w).trim() !== "") {
    return String(cell.w).trim();
  }
  try {
    const formatted = XLSX.utils.format_cell(cell);
    if (formatted != null && String(formatted).trim() !== "") {
      return String(formatted).trim();
    }
  } catch (e) {
    /* use fallback */
  }
  if (cell.v == null) return getCell(rowFallback, colIndex);
  return String(cell.v).trim() === "" ? null : String(cell.v).trim();
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
  const fileRefCol = findColumnIndex(headerRow, [
    "file ref",
    "file ref no",
    "file reference",
    "fileref",
  ]);
  if (fileRefCol >= 0) {
    membershipCol = fileRefCol;
  } else {
    const membershipHeader = findColumnIndex(headerRow, [
      "membership",
      "member no",
      "member no.",
      "membership no",
      "membership no.",
    ]);
    if (membershipHeader >= 0) {
      membershipCol = membershipHeader;
    }
  }
  // Map columns from header whenever labels exist (not only when membership col matched).
  // Do not use generic "name" for full name — it matches "first name" before "full name".
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
    "member name",
    "name as shown",
    "display name",
  ]);
  const valueIdx = findColumnIndex(headerRow, [
    "value",
    "amount",
    "period",
    "value for",
  ]);
  if (lastIdx >= 0) lastCol = lastIdx;
  if (firstIdx >= 0) firstCol = firstIdx;
  if (fullIdx >= 0) fullNameCol = fullIdx;
  if (valueIdx >= 0) valueCol = valueIdx;
  const dataRows = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const membershipNo = getTextFromSheetCell(
      firstSheet,
      i,
      membershipCol,
      row,
      membershipCol,
    );
    if (!membershipNo) continue;
    dataRows.push({
      rowIndex: i + 1,
      membershipNumber: membershipNo,
      lastName: getTextFromSheetCell(firstSheet, i, lastCol, row, lastCol),
      firstName: getTextFromSheetCell(firstSheet, i, firstCol, row, firstCol),
      fullName: getTextFromSheetCell(
        firstSheet,
        i,
        fullNameCol,
        row,
        fullNameCol,
      ),
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
      const piEx = profile.personalInfo || {};
      batchExceptions.push({
        profileId: profile._id,
        membershipNumber: String(profile.membershipNumber ?? "").trim() || null,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: fullNameFromFileOrProfile(row, piEx),
        valueForPeriodSelected: null,
        rowIndex: row.rowIndex,
        fileRow: {
          membershipNumber: row.membershipNumber,
          lastName: row.lastName,
          firstName: row.firstName,
          fullName: row.fullName,
          valueForPeriodSelected: null,
          rowIndex: row.rowIndex,
        },
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
        membershipNumber: String(profile.membershipNumber ?? "").trim(),
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
        forename: pi.forename ?? null,
        surname: pi.surname ?? null,
        fullName: fullNameFromFileOrProfile(row, pi),
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
        profileId: null,
        membershipNumber: null,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: row.fullName,
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
        fileRow: {
          membershipNumber: row.membershipNumber,
          lastName: row.lastName,
          firstName: row.firstName,
          fullName: row.fullName,
          valueForPeriodSelected: valueInCents,
          rowIndex: row.rowIndex,
        },
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
      const piEx = profile.personalInfo || {};
      batchExceptions.push({
        profileId: profile._id,
        membershipNumber: String(profile.membershipNumber ?? "").trim() || null,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: fullNameFromFileOrProfile(row, piEx),
        valueForPeriodSelected: null,
        rowIndex: row.rowIndex,
        fileRow: {
          membershipNumber: row.membershipNumber,
          lastName: row.lastName,
          firstName: row.firstName,
          fullName: row.fullName,
          valueForPeriodSelected: null,
          rowIndex: row.rowIndex,
        },
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
        membershipNumber: String(profile.membershipNumber ?? "").trim(),
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
        forename: pi.forename ?? null,
        surname: pi.surname ?? null,
        fullName: fullNameFromFileOrProfile(row, pi),
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
        profileId: null,
        membershipNumber: null,
        lastName: row.lastName,
        firstName: row.firstName,
        fullName: row.fullName,
        valueForPeriodSelected: valueInCents,
        rowIndex: row.rowIndex,
        fileRow: {
          membershipNumber: row.membershipNumber,
          lastName: row.lastName,
          firstName: row.firstName,
          fullName: row.fullName,
          valueForPeriodSelected: valueInCents,
          rowIndex: row.rowIndex,
        },
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
    membershipNumber: payment.membershipNumber ?? null,
    lastName: fr.lastName ?? payment.surname ?? null,
    firstName: fr.firstName ?? payment.forename ?? null,
    fullName: fr.fullName ?? payment.fullName ?? null,
    valueForPeriodSelected: fr.valueForPeriodSelected ?? null,
    rowIndex: fr.rowIndex ?? null,
    fileRow: {
      membershipNumber: fr.membershipNumber ?? null,
      lastName: fr.lastName ?? null,
      firstName: fr.firstName ?? null,
      fullName: fr.fullName ?? null,
      valueForPeriodSelected: fr.valueForPeriodSelected ?? null,
      rowIndex: fr.rowIndex ?? null,
    },
  };
}

export function buildBatchPaymentEntryFromProfile(profile, fileRow) {
  const pi = profile.personalInfo || {};
  const ci = profile.contactInfo || {};
  const pd = profile.professionalDetails || {};
  const pref = profile.preferences || {};
  return {
    profileId: profile._id,
    membershipNumber: String(profile.membershipNumber ?? "").trim(),
    valueForPeriodSelected: fileRow.valueForPeriodSelected ?? null,
    rowIndex: fileRow.rowIndex ?? null,
    forename: pi.forename ?? null,
    surname: pi.surname ?? null,
    fullName: fullNameFromFileOrProfile(fileRow, pi),
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
