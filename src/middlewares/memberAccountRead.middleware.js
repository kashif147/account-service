// PDP rollout P5, blocker 2 (option b): a member's OWN statement / net balance for the portal, without the PDP.
//
// At P5 the PDP audience makes accounts.reports:read CRM-only, so the portal member statement and net-balance
// routes cannot keep asking the PDP for it. Portal members do not hold accounts.member:read until the
// existing-tenant role migration (phase X), and no role grant may change under the role freeze. So the caller
// types are split, with the record-ownership check unchanged and FIRST:
//
//   ensureAuthenticatedWithTenantContext   verified token + verified tenant (unchanged)
//   requireCrmOrOwnMember                  CRM -> next; PORTAL -> :memberId must be the caller's OWN
//                                          membershipNumber / profileId from the verified principal
//                                          (profile-service my-profile, trusted tenant); else 403 NOT_OWNER;
//                                          any other caller type -> 403 CRM_ONLY (unchanged)
//   requireMemberAccountRead (this file)   PORTAL -> the verified token must still carry the member-account
//                                          claim it carries today (accounts.reports:read) or its successor
//                                          (accounts.member:read): literal match, local, NO PDP call - so it
//                                          is identical whatever PDP_AUDIENCE_MODE is; else 403
//                                          MEMBER_ACCOUNT_PERMISSION_REQUIRED.
//                                          CRM -> the PDP, accounts.member:read (BOTH audience; the
//                                          member-scoped finance read). Anything else -> 403 CRM_ONLY.
//
// Nothing here widens access: the portal branch requires exactly the ownership + claim it requires today; the
// CRM branch moves to the narrower member-account code. Tenant scope stays with the verified tenant (the
// ownership lookup and the controllers read the trusted tenant only).
import { AppError } from "../errors/AppError.js";
import { collectRequestPermissions } from "../helpers/financePermissions.js";
import { isCrmCaller, isPortalCaller } from "./callerScope.middleware.js";

export const PORTAL_MEMBER_ACCOUNT_CLAIMS = Object.freeze(["accounts.reports:read", "accounts.member:read"]);
export const MEMBER_ACCOUNT_PERMISSION_REQUIRED = "MEMBER_ACCOUNT_PERMISSION_REQUIRED";

/**
 * @param {{ crmCheck: Function }} deps crmCheck = the PDP middleware for CRM callers
 *   (defaultPolicyMiddleware.requirePermission("accounts.member", "read")).
 * Mount AFTER requireCrmOrOwnMember.
 */
export function createRequireMemberAccountRead({ crmCheck } = {}) {
  if (typeof crmCheck !== "function") throw new Error("createRequireMemberAccountRead: crmCheck required");
  return function requireMemberAccountRead(req, res, next) {
    if (isPortalCaller(req)) {
      const perms = collectRequestPermissions(req);
      if (PORTAL_MEMBER_ACCOUNT_CLAIMS.some((p) => perms.includes(p))) return next();
      return next(
        new AppError("Member account permission required", 403, MEMBER_ACCOUNT_PERMISSION_REQUIRED),
      );
    }
    if (isCrmCaller(req)) return crmCheck(req, res, next);
    return next(new AppError("This action is restricted to CRM staff", 403, "CRM_ONLY"));
  };
}
