// src/controllers/admin.controller.js
import CoA from "../models/coa.model.js";
import { AppError } from "../errors/AppError.js";
import { logInfo } from "../middlewares/logger.mw.js";
import { publishDomainEvent, EVENT_TYPES } from "../infra/rabbit/events.js";

export async function listCoA(req, res, next) {
  try {
    logInfo("Listing Chart of Accounts");
    const rows = await CoA.find({}).sort({ code: 1 }).lean();

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
