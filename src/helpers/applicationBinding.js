// P5 (b7): the one rule for "this stored Payment is an APPLICATION payment" (shared by the
// transitional CRM user path in paymentMutationAuthority.middleware.js and the bound internal
// command in paymentBoundCommand.service.js, so the two can never disagree):
//   - purpose "applicationFee" with its applicationId, or
//   - purpose "subscriptionFee" with applicationBinding === applicationId, where
//     applicationBinding is written only at creation by a path that verified the application
//     (portal intent guard / account's own payment-link flow).
// An applicationId alone never makes a subscriptionFee row an application payment.
function norm(v) {
  return v == null ? "" : String(v).trim();
}

export function hasAuthoritativeApplicationBinding(row) {
  const app = norm(row?.applicationId);
  if (!app) return false;
  const purpose = norm(row.purpose);
  if (purpose === "applicationFee") return true;
  return purpose === "subscriptionFee" && norm(row.applicationBinding) === app;
}
