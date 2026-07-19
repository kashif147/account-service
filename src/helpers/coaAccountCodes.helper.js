import CoA from "../models/coa.model.js";

/**
 * Account codes flagged isMemberTracked=true on the Chart of Accounts - these
 * require a memberId/applicationId/registrationId + periodBucket when posted
 * (see postBalancedJournal in journal.controller.js). Seeding a new code with
 * this flag (e.g. events/courses AR/POA codes) gets the same guardrail
 * automatically, with no new hardcoded account-code literals.
 */
export async function getMemberTrackedAccountCodes() {
  const rows = await CoA.find({ isMemberTracked: true }).select("code").lean();
  return rows.map((r) => r.code).filter(Boolean);
}
