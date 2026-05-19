import { asyncHandler } from "../helpers/asyncHandler.js";
import { collectRequestPermissions } from "../helpers/financePermissions.js";
import { getLedgerActionsForDocument } from "../services/ledgerActions.service.js";

export const memberLedgerActions = asyncHandler(async (req, res) => {
  const { memberId } = req.params;
  const { docType, docNo, status, year } = req.query;

  const permissions = collectRequestPermissions(req);

  const result = await getLedgerActionsForDocument({
    docType,
    docNo,
    status,
    memberId,
    permissions,
    year: year ? parseInt(year, 10) : undefined,
  });

  res.success(result);
});
