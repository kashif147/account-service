// src/controllers/admin.controller.js
import CoA from "../models/coa.model.js";
import { AppError } from "../errors/AppError.js";
import { requireTenantId } from "../helpers/tenantScope.js";
import { logInfo } from "../middlewares/logger.mw.js";
import { publishDomainEvent, EVENT_TYPES } from "../rabbitMQ/events.js";

export async function listCoA(req, res, next) {
  try {
    logInfo("Listing Chart of Accounts");
    // The tenant's own chart (CoA rows are tenant-owned).
    const rows = await CoA.find({ tenantId: requireTenantId(req) }).sort({ code: 1 }).lean();

    // Publish CoA list accessed event
    await publishDomainEvent(
      "coa.list.accessed",
      {
        count: rows.length,
        timestamp: new Date().toISOString(),
      },
      {
        source: "admin.controller",
        operation: "listCoA",
      }
    );

    res.success({
      count: rows.length,
      items: rows.map((a) => ({
        code: a.code,
        description: a.description,
        type: a.type,
        label: `${a.code} (${a.description})`,
        isCash: a.isCash,
        isClearing: a.isClearing,
        isMemberTracked: a.isMemberTracked,
        isRevenue: a.isRevenue,
        isContraRevenue: a.isContraRevenue,
      })),
    });
    logInfo("Chart of Accounts retrieved", { count: rows.length });
  } catch (e) {
    logError("Failed to retrieve Chart of Accounts", { error: e.message });
    next(e);
  }
}
