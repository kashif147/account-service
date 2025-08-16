import GL from "../models/glTransaction.model.js";
import Balance from "../models/balance.model.js";

export async function memberStatement(req, res, next) {
  try {
    const { memberId } = req.params;
    const { from, to } = req.query;
    const q = { "entries.memberId": memberId };
    if (from || to) q.date = {};
    if (from) q.date.$gte = new Date(from);
    if (to) q.date.$lte = new Date(to);
    const txns = await GL.find(q).sort({ date: 1, createdAt: 1 }).lean();
    res.json({ memberId, txns });
  } catch (e) { next(e); }
}

export async function balancesSnapshot(req, res, next) {
  try {
    const agg = await Balance.aggregate([
      { $group: { _id: { code: "$accountCode", bucket: "$periodBucket" }, total: { $sum: "$balance" } } },
      { $project: { _id: 0, accountCode: "$_id.code", bucket: "$_id.bucket", total: 1 } }
    ]);
    res.json({ agg });
  } catch (e) { next(e); }
}
