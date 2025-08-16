// src/controllers/report.controller.js
import Balance from "../models/balance.model.js";
import CoA from "../models/coa.model.js";

export async function getBalances(req, res, next) {
  try {
    const balances = await Balance.find({}).lean();
    const coaMap = Object.fromEntries(
      (await CoA.find({})).map(c => [c.code, c.description])
    );

    const data = balances.map(b => ({
      memberId: b.memberId,
      coaCode: b.coaCode,
      coaDesc: coaMap[b.coaCode] || "Unknown",
      bucket: b.bucket,
      debit: b.debit,
      credit: b.credit,
      balance: b.balance
    }));

    res.json({ count: data.length, items: data });
  } catch (err) {
    next(err);
  }
}
