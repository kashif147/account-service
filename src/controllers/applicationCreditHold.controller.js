import { asyncHandler } from "../helpers/asyncHandler.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import { listApplicationCreditHolds } from "../services/applicationCreditHold.service.js";

/** GET /api/finance/application-credit-holds (CRM finance read; tenant from the verified token). */
export const listApplicationCreditHoldsHandler = asyncHandler(async (req, res) => {
  const { status, limit, skip } = req.query;
  const result = await listApplicationCreditHolds({
    tenantId: requireTenantId(req),
    status,
    limit,
    skip,
  });
  res.success(result);
});
