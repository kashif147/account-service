import { AppError } from "../errors/AppError.js";
import { collectRequestPermissions } from "./financePermissions.js";

/**
 * PDP rollout P3 (Q2): bank-sensitive data on the direct-debit run routes.
 *
 * Plaintext creditor / debtor IBAN + BIC and the PAIN.008 file are released only to a CRM caller whose
 * verified token carries the bank-data permission (catalogue code PAYMENTS.BANK_READ, issued in the token
 * as `payments.bank:read` by user-service role.handler.js getUserPermissions: `${resource}:${action}`
 * lower-cased) or the tenant wildcard `*` (computed for ASU only, own tenant). Everyone else who passes the
 * finance read gate sees masked values. Literal match only, fail closed:
 *   - `payments:read` / `payments:*` / `admin` / `accounts.admin:*` do NOT unlock it (different resource);
 *   - this check never goes through the PDP: until the P1 catalogue PR lands, `payments.bank` is an
 *     unknown resource there and would deny everyone (ASU included).
 */
export const BANK_READ_PERMISSION = "payments.bank:read";
const BANK_READ_CLAIMS = Object.freeze(["*", BANK_READ_PERMISSION]);

export const BANK_DATA_PERMISSION_REQUIRED = "BANK_DATA_PERMISSION_REQUIRED";

function callerUserType(req) {
  return String(req?.user?.userType || "").trim().toUpperCase();
}

/** True only for a CRM caller whose verified permissions carry `payments.bank:read` (or ASU's `*`). */
export function canReadBankData(req) {
  if (callerUserType(req) !== "CRM") return false;
  const perms = collectRequestPermissions(req);
  return BANK_READ_CLAIMS.some((p) => perms.includes(p));
}

/** Route gate for outputs that have no masked form (the PAIN.008 file). Mount after requireFinanceRead. */
export function requireBankDataRead(req, res, next) {
  if (canReadBankData(req)) return next();
  return next(
    new AppError(
      "Bank data permission required (payments.bank:read)",
      403,
      BANK_DATA_PERMISSION_REQUIRED,
    ),
  );
}

/** Same display format as profile-service helpers/iban.js maskIban: first 4 + **** + last 4. */
export function maskIban(value) {
  const n = String(value || "").trim().replace(/\s+/g, "").toUpperCase();
  if (!n) return n;
  if (n.length <= 8) return "****";
  return `${n.slice(0, 4)}****${n.slice(-4)}`;
}

function plain(doc) {
  if (!doc || typeof doc !== "object") return doc;
  if (typeof doc.toObject === "function") return doc.toObject();
  return { ...doc };
}

/**
 * A run as returned to a caller. Without bank access: creditor IBAN masked, creditor BIC removed and the
 * stored PAIN.008 blob URL removed (the file itself is behind requireBankDataRead). The creditor name and
 * SEPA OIN stay (organisation details printed on member mandates).
 */
export function runForCaller(run, allowed) {
  if (allowed || !run || typeof run !== "object") return run;
  const out = plain(run);
  if (out.creditorSnapshot && typeof out.creditorSnapshot === "object") {
    const cs = { ...out.creditorSnapshot };
    if (cs.iban) cs.iban = maskIban(cs.iban);
    delete cs.bic;
    out.creditorSnapshot = cs;
  }
  if (out.pain008 && typeof out.pain008 === "object" && "downloadUrl" in out.pain008) {
    const p = { ...out.pain008 };
    delete p.downloadUrl;
    out.pain008 = p;
  }
  return out;
}

/** A run item as returned to a caller. Without bank access: debtor IBAN masked, debtor BIC removed. */
export function runItemForCaller(item, allowed) {
  if (allowed || !item || typeof item !== "object") return item;
  const out = plain(item);
  if (out.mandateSnapshot && typeof out.mandateSnapshot === "object") {
    const ms = { ...out.mandateSnapshot };
    if (ms.debtorIban) ms.debtorIban = maskIban(ms.debtorIban);
    delete ms.debtorBic;
    out.mandateSnapshot = ms;
  }
  return out;
}
