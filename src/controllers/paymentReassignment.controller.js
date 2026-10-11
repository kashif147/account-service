import { asyncHandler } from "../helpers/asyncHandler.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import { reassignMemberPayments } from "../services/paymentReassignment.service.js";

export const reassignPaymentsHandler = asyncHandler(async (req, res) => {
  const result = await reassignMemberPayments({
    ...req.body,
    correctionDate: req.body.correctionDate || req.body.effectiveDate,
    userId: req.ctx?.userId,
    // Trusted tenant always wins over any body tenantId spread above.
    tenantId: requireTenantId(req),
  });

  res.created(result);
});
