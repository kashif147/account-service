import { asyncHandler } from "../helpers/asyncHandler.js";
import { reassignMemberPayments } from "../services/paymentReassignment.service.js";

export const reassignPaymentsHandler = asyncHandler(async (req, res) => {
  const result = await reassignMemberPayments({
    ...req.body,
    correctionDate: req.body.correctionDate || req.body.effectiveDate,
    userId: req.ctx?.userId,
    tenantId: req.ctx?.tenantId ?? req.tenantId,
  });

  res.created(result);
});
