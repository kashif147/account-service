// src/controllers/journal.controller.js
import CoA from "../models/coa.model.js";
import GL from "../models/glTransaction.model.js";
import dayjs from "dayjs";
// import { calculateProRataFee } from "../helpers/prorata.js";
import { prorataFromJoinToYearEnd, yearBoundsFrom, prorataForPeriod } from "../helpers/prorata.js";
import { stripeFeeBreakdown } from "../helpers/fees.js";

function sum(arr, sel) {
  return Number(arr.reduce((s, x) => s + sel(x), 0).toFixed(2));
}

// Load CoA rows for the accounts referenced in the journal,
// and attach 'accountName' by mapping CoA.description → accountName.
// We leave your GL model untouched (it still expects accountName).
async function enrichLines(lines) {
  const codes = [...new Set(lines.map(l => l.accountCode))];
  const coaRows = await CoA.find({ code: { $in: codes } }).lean();

  const byCode = Object.fromEntries(coaRows.map(a => [a.code, a]));
  return lines.map(l => {
    const a = byCode[l.accountCode];
    if (!a) throw new Error(`Unknown account ${l.accountCode}`);
    return {
      ...l,
      accountName: a.description, // <-- map description to the name field GL stores
      _a: a                       // keep the CoA row handy for guardrails if needed
    };
  });
}

export async function postBalancedJournal({ date, docType, docNo, memo, lines }) {
  const enriched = await enrichLines(lines);

  // basic balance check
  const deb = sum(enriched, x => x.dc === "D" ? x.amount : 0);
  const cre = sum(enriched, x => x.dc === "C" ? x.amount : 0);
  if (deb !== cre) throw new Error(`Unbalanced journal D ${deb} vs C ${cre}`);

  // optional: simple guardrails (kept light; extend as you like)
  // - prevent posting to 1200 (Bank) except via settlements
  if (docType !== "Settlement" && enriched.some(e => e.accountCode === "1200")) {
    throw new Error("Only Settlement documents may post to 1200 (Bank)");
  }
  // - require memberId/periodBucket on member-tracked accounts (1400, 2020)
  for (const e of enriched) {
    if ((e.accountCode === "1400" || e.accountCode === "2020") && (!e.memberId || !e.periodBucket)) {
      throw new Error(`memberId and periodBucket required on ${e.accountCode}`);
    }
  }
  

  // idempotency on docNo
  const exists = await GL.findOne({ docNo }).lean();
  if (exists) return exists;

  // strip helper and persist
  const entries = enriched.map(({ _a, ...rest }) => rest);
  const txn = await GL.create({ date, docType, docNo, memo, entries });

  // add a friendly label in the response
  const obj = txn.toObject();
  obj.entries = obj.entries.map(e => ({
    ...e,
    accountLabel: `${e.accountCode} (${e.accountName})`
  }));
  return obj;
}

// Invoice → 1400 (AR) debit, income credit
// export async function invoice(req, res, next) {
//   try {
//     const {
//       date,
//       docNo,
//       memberId,
//       annualFee,
//       incomeCode,                      // e.g., "4000"
//       revenueSubType = "fee",
//       periodBucket,                    // optional override
//       joinDate,                        // optional; when present we compute pro-rata
//       yearEndDate                      // optional; if omitted we infer from joinDate
//     } = req.body;

//     const invoiceDate = dayjs(date);
//     const join = joinDate ? dayjs(joinDate) : null;

//     // If join is in a future calendar year relative to invoice date, default AR to 'advance'
//     const inferredBucket =
//       periodBucket ||
//       (join && invoiceDate.year() < join.year() ? "advance" : "current");

//     const journals = [];

//     // 1) Always post the full annual fee
//     const fullInvoice = await postBalancedJournal({
//       date,
//       docType: "Invoice",
//       docNo,
//       memo: "Member invoice (annual)",
//       lines: [
//         { accountCode: "1400", dc: "D", amount: annualFee, memberId, periodBucket: inferredBucket },
//         { accountCode: incomeCode, dc: "C", amount: annualFee, revenueSubType }
//       ]
//     });
//     journals.push(fullInvoice);

//     // 2) If joinDate present, post the pro-rata credit (difference)
//     if (joinDate) {
//       const { daysRemaining, totalDays, prorataFee } =
//         calculateProRataFee(joinDate, yearEndDate, annualFee);

//       if (prorataFee < annualFee) {
//         const reduction = Number((annualFee - prorataFee).toFixed(2));
//         if (reduction > 0) {
//           const prorataCredit = await postBalancedJournal({
//             date,
//             docType: "CreditNote",
//             docNo: `${docNo}-PRORATA`,
//             memo: `Pro-rata adjustment (${daysRemaining}/${totalDays} days)`,
//             lines: [
//               { accountCode: "4900", dc: "D", amount: reduction, adjSubType: "prorata" },
//               { accountCode: "1400", dc: "C", amount: reduction, memberId, periodBucket: inferredBucket }
//             ]
//           });
//           journals.push(prorataCredit);
//         }
//       }
//     }

//     res.status(201).json(journals);
//   } catch (e) {
//     next(e);
//   }
// }
export async function invoice(req, res, next) {
  try {
    const {
      date,                // invoice date
      docNo,
      memberId,
      annualFee,
      incomeCode,          // e.g. "4000"
      categoryName,        // e.g. "General All Grades"
      periodBucket = "current",
      joinDate             // optional for mid-year join (ISO)
    } = req.body;

    const memoBase = `Subscription ${new Date(date).getFullYear()} – ${categoryName}`;

    // 1) Full-year invoice
    const inv = await postBalancedJournal({
      date,
      docType: "Invoice",
      docNo,
      memo: memoBase,
      lines: [
        { accountCode: "1400", dc: "D", amount: annualFee, memberId, periodBucket },
        { accountCode: incomeCode, dc: "C", amount: annualFee, revenueSubType: "fee", categoryName }
      ]
    });

    const out = [inv];

    // 2) Daily pro-rata credit note if join mid-year
    if (joinDate) {
      const { end } = yearBoundsFrom(joinDate);
      // Amount due for join→year end
      const due = prorataFromJoinToYearEnd(annualFee, joinDate);
      const reduction = Number((annualFee - due).toFixed(2));
      if (reduction > 0) {
        const cn = await postBalancedJournal({
          date,
          docType: "CreditNote",
          docNo: `${docNo}-PRORATA`,
          memo: `Credit note – Pro-rata (${categoryName}) ${joinDate} to ${end.format("YYYY-MM-DD")}`,
          lines: [
            { accountCode: "4900", dc: "D", amount: reduction, adjSubType: "prorata", categoryName },
            { accountCode: "1400", dc: "C", amount: reduction, memberId, periodBucket }
          ]
        });
        out.push(cn);
      }
    }

    res.status(201).json(out);
  } catch (e) { next(e); }
}

export async function changeCategory(req, res, next) {
  try {
    const {
      date, docNoBase, memberId,
      oldIncomeCode, oldCategoryName, oldAnnualFee,
      newIncomeCode, newCategoryName, newAnnualFee,
      changeDate,               // ISO, within the target year
      periodBucket = "current"
    } = req.body;

    const { start, end } = yearBoundsFrom(changeDate);
    const changeMinus1 = new Date(new Date(changeDate).getTime() - 24*3600*1000);
    const changeMinusISO = changeMinus1.toISOString().slice(0,10);

    const isUpgrade = newAnnualFee > oldAnnualFee;

    const results = [];

    // 1) New plan full-year invoice
    results.push(await postBalancedJournal({
      date,
      docType: "Invoice",
      docNo: `${docNoBase}-INVNEW`,
      memo: `Subscription ${start.year()} – ${newCategoryName}`,
      lines: [
        { accountCode: "1400", dc: "D", amount: newAnnualFee, memberId, periodBucket },
        { accountCode: newIncomeCode, dc: "C", amount: newAnnualFee, revenueSubType: "fee", categoryName: newCategoryName }
      ]
    }));

    // 2) Credit unused old category: changeDate → year end
    const creditOldUnused = prorataForPeriod(oldAnnualFee, changeDate, end.format("YYYY-MM-DD"));
    if (creditOldUnused > 0) {
      results.push(await postBalancedJournal({
        date,
        docType: "CreditNote",
        docNo: `${docNoBase}-COLD`,
        memo: `Credit note – Unused period (${oldCategoryName}) ${changeDate} to ${end.format("YYYY-MM-DD")}`,
        lines: [
          { accountCode: "4900", dc: "D", amount: creditOldUnused,
            adjSubType: isUpgrade ? "fee-increase-credit" : "downgrade", categoryName: oldCategoryName },
          { accountCode: "1400", dc: "C", amount: creditOldUnused, memberId, periodBucket }
        ]
      }));
    }

    // 3) Credit pre-change portion of new category: year start → changeDate-1
    const creditNewPre = prorataForPeriod(newAnnualFee, start.format("YYYY-MM-DD"), changeMinusISO);
    if (creditNewPre > 0) {
      results.push(await postBalancedJournal({
        date,
        docType: "CreditNote",
        docNo: `${docNoBase}-CNEW`,
        memo: `Credit note – Pre-change portion (${newCategoryName}) ${start.format("YYYY-MM-DD")} to ${changeMinusISO}`,
        lines: [
          { accountCode: "4900", dc: "D", amount: creditNewPre, adjSubType: "prorata", categoryName: newCategoryName },
          { accountCode: "1400", dc: "C", amount: creditNewPre, memberId, periodBucket }
        ]
      }));
    }

    res.status(201).json(results);
  } catch (e) { next(e); }
}


// Credit note / discount → 4900 debit, 1400 credit
// export async function creditNote(req, res, next) {
//   try {
//     const { date, docNo, memberId, amount, periodBucket = "current" } = req.body;

//     const lines = [
//       { accountCode: "4900", dc: "D", amount, adjSubType: "discount" },
//       { accountCode: "1400", dc: "C", amount, memberId, periodBucket }
//     ];

//     const out = await postBalancedJournal({
//       date, docType: "CreditNote", docNo, memo: "Credit note", lines
//     });
//     res.status(201).json(out);
//   } catch (e) { next(e); }
// }
export async function creditNote(req, res, next) {
  try {
    const { date, docNo, memberId, amount, periodBucket = "current", adjSubType = "discount", categoryName } = req.body;
    const out = await postBalancedJournal({
      date, docType: "CreditNote", docNo,
      memo: `Credit note – ${categoryName || adjSubType}`,
      lines: [
        { accountCode: "4900", dc: "D", amount, adjSubType, categoryName },
        { accountCode: "1400", dc: "C", amount, memberId, periodBucket }
      ]
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
}


// // Receipt (unlinked money-in) → 12xx clearing debit, 2020 credit
// export async function receipt(req, res, next) {
//   try {
//     const { date, docNo, memberId, applicationId, amount, clearingCode, bucket = "current" } = req.body;

//     // derive a pseudo-member for application-held money
//     const effectiveMemberId = memberId || (applicationId ? `app:${applicationId}` : null);
//     if (!effectiveMemberId) {
//       throw new Error("memberId or applicationId is required");
//     }

//     const lines = [
//       { accountCode: clearingCode, dc: "D", amount }, // 1210/1220/1230/1240/1250
//       { accountCode: "2020", dc: "C", amount, memberId: effectiveMemberId, periodBucket: bucket }
//     ];

//     const out = await postBalancedJournal({
//       date, docType: "Receipt", docNo, memo: applicationId ? `Unlinked receipt (app ${applicationId})` : "Unlinked receipt", lines
//     });
//     res.status(201).json(out);
//   } catch (e) { next(e); }
// }

export async function receipt(req, res, next) {
  try {
    const { date, docNo, memberId, applicationId, amount, clearingCode, bucket = "current", provider } = req.body;
    const effectiveMemberId = memberId || (applicationId ? `app:${applicationId}` : null);
    if (!effectiveMemberId) throw new Error("memberId or applicationId is required");

    const lines = [
      { accountCode: clearingCode, dc: "D", amount },                  // 1210..1250
      { accountCode: "2020",       dc: "C", amount, memberId: effectiveMemberId, periodBucket: bucket } // Payment on Account
    ];

    // Stripe fee and VAT (Ireland), applied against the clearing account
    if (provider === "stripe") {
      const { feeNoVat, feeVat, feeTotal } = stripeFeeBreakdown(amount);
      lines.push({ accountCode: "5100", dc: "D", amount: feeNoVat }); // Processing fee
      lines.push({ accountCode: "1160", dc: "D", amount: feeVat   }); // VAT recoverable
      lines.push({ accountCode: clearingCode, dc: "C", amount: feeTotal });
    }

    const out = await postBalancedJournal({
      date, docType: "Receipt", docNo, memo: applicationId ? `Receipt (app ${applicationId})` : "Receipt", lines
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
}


//  “claim credit” endpoint (transfer 2020 from app → member)
export async function claimApplicationCredit(req, res, next) {
  try {
    const { date, docNo, applicationId, memberId, amount, bucket = "current" } = req.body;
    if (!applicationId || !memberId || !amount) throw new Error("applicationId, memberId and amount are required");

    const appMember = `app:${applicationId}`;

    const lines = [
      // reduce app-held credit
      { accountCode: "2020", dc: "D", amount, memberId: appMember, periodBucket: bucket },
      // assign credit to real member
      { accountCode: "2020", dc: "C", amount, memberId,        periodBucket: bucket }
    ];

    const out = await postBalancedJournal({
      date, docType: "Claim", docNo, memo: `Claim app credit ${applicationId} → ${memberId}`, lines
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
}

export async function writeOff(req, res, next) {
  try {
    const { date, docNo, memberId, amount, periodBucket = "current" } = req.body;
    const out = await postBalancedJournal({
      date, docType: "WriteOff", docNo, memo: "Bad debt write-off",
      lines: [
        { accountCode: "5200", dc: "D", amount, adjSubType: "writeoff" },
        { accountCode: "1400", dc: "C", amount, memberId, periodBucket }
      ]
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
}


// List journals
/**
 * GET /api/journal
 * Query params:
 *  - from, to: ISO dates
 *  - docType: e.g. Invoice, CreditNote, Receipt, Settlement
 *  - memberId: exact match on entries.memberId
 *  - skip, limit: pagination (defaults: 0, 50; max limit 200)
 */
export async function listJournals(req, res, next) {
  try {
    const { from, to, docType, memberId, limit = 50, skip = 0 } = req.query;

    const query = {};
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) query.date.$lte = new Date(to);
    }
    if (docType) query.docType = docType;
    if (memberId) query["entries.memberId"] = memberId;

    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(skip, 10) || 0, 0);

    const [items, total] = await Promise.all([
      GL.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(offset)
        .limit(pageSize)
        .lean(),
      GL.countDocuments(query)
    ]);

    res.json({
      total,
      skip: offset,
      limit: pageSize,
      items
    });
  } catch (err) {
    next(err);
  }
}
   
