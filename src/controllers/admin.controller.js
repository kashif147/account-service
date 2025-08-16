// src/controllers/admin.controller.js
import CoA from "../models/coa.model.js";

export async function listCoA(req, res, next) {
  try {
    const rows = await CoA.find({}).sort({ code: 1 }).lean();
    res.json({
      count: rows.length,
      items: rows.map(a => ({
        code: a.code,
        description: a.description,
        type: a.type,
        label: `${a.code} (${a.description})`,
        isCash: a.isCash,
        isClearing: a.isClearing,
        isMemberTracked: a.isMemberTracked,
        isRevenue: a.isRevenue,
        isContraRevenue: a.isContraRevenue
      }))
    });
  } catch (e) {
    next(e);
  }
}
