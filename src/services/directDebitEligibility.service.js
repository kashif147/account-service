import DirectDebitMandate from "../models/directDebitMandate.model.js";
import DirectDebitRunItem from "../models/directDebitRunItem.model.js";
import DirectDebitRun, { OPEN_RUN_STATUSES } from "../models/directDebitRun.model.js";
import { normalizeIban } from "../helpers/sepaXml.helper.js";
import {
  buildRemittanceInfo,
  computeCollectibleAmountEur,
  resolveSeqTp,
} from "../helpers/directDebitAmount.helper.js";
import { assignUniqueEndToEndIds } from "./sepaReferenceGenerator.js";
import { memberOwed1400ByBucket } from "../helpers/paymentReceiptAllocation.js";
import { loadDirectDebitEligibilitySource } from "./directDebitUpstream.client.js";

const ACTIVE_SUBSCRIPTION = "Active";
const DIRECT_DEBIT_PAYMENT = "Direct Debit";

export async function findDuplicateOpenRun(tenantId, runType, periodStart, periodEnd, collectionDate) {
  return DirectDebitRun.findOne({
    tenantId,
    runType,
    periodStartDate: periodStart,
    periodEndDate: periodEnd,
    collectionDate,
    status: { $in: OPEN_RUN_STATUSES },
  }).lean();
}

export async function membersInOpenRunsForPeriod(tenantId, periodStart, periodEnd) {
  const openRuns = await DirectDebitRun.find({
    tenantId,
    periodStartDate: periodStart,
    periodEndDate: periodEnd,
    status: { $in: OPEN_RUN_STATUSES },
  })
    .select("_id")
    .lean();
  if (!openRuns.length) return new Set();
  const runIds = openRuns.map((r) => r._id);
  const items = await DirectDebitRunItem.find({
    tenantId,
    runId: { $in: runIds },
    status: { $in: ["INCLUDED", "FILED", "SUBMITTED", "PAID", "UNPAID", "REJECTED"] },
  })
    .select("memberId")
    .lean();
  return new Set(items.map((i) => i.memberId));
}

async function upsertMandateFromSnapshot(tenantId, profileId, membershipNumber, mandateRow, paymentFormId, org) {
  const dd = mandateRow?.mandate || mandateRow || {};
  const umr = dd.umr;
  if (!umr) return null;

  const payload = {
    tenantId,
    profileId,
    memberId: membershipNumber,
    membershipNumber,
    paymentFormId,
    umr,
    signedDate: dd.signedDate ? new Date(dd.signedDate) : new Date("2013-01-01"),
    status: "ACTIVE",
    debtorName: dd.debtorName,
    debtorIban: normalizeIban(dd.debtorIban),
    debtorBic: dd.debtorBic || null,
    debtorAddress: dd.debtorAddress,
    debtorCity: dd.debtorCity,
    debtorPostcode: dd.debtorPostcode,
    debtorCountry: dd.debtorCountry || "IE",
    creditorName: dd.creditorName || org?.legalName || org?.name,
    creditorOin: dd.creditorIdentifier || org?.sepaOriginatorIdentificationNumber,
    creditorIban: normalizeIban(dd.creditorIban || org?.iban),
    creditorBic: dd.creditorBic || org?.bic,
    syncedFromPaymentFormAt: new Date(),
  };

  return DirectDebitMandate.findOneAndUpdate(
    { tenantId, umr },
    { $set: payload, $setOnInsert: { successfulCollectionCount: 0 } },
    { upsert: true, new: true },
  );
}

function subscriptionProfileId(sub) {
  const pid = sub.profileId || sub.profile?._id;
  return pid ? String(pid) : null;
}

function subscriptionId(sub) {
  return sub._id || sub.id;
}

/**
 * Select eligible members via subscription-service + profile-service HTTP APIs.
 */
export async function buildEligibilityItems({
  tenantId,
  run,
  actorId,
  req,
}) {
  if (!req) {
    throw new Error("Request context required for direct debit eligibility (use queuePrepareJob with captured headers)");
  }

  const { subs, mandateByProfile } = await loadDirectDebitEligibilitySource(req);

  const eligibleSubs = subs.filter((sub) => {
    const status = sub.subscriptionStatus || sub.status;
    const paymentType = sub.paymentType || sub.paymentMethod;
    return (
      (status == null || status === ACTIVE_SUBSCRIPTION) &&
      String(paymentType || "") === DIRECT_DEBIT_PAYMENT &&
      sub.isCurrent !== false
    );
  });

  const alreadyInRun = await membersInOpenRunsForPeriod(
    tenantId,
    run.periodStartDate,
    run.periodEndDate,
  );

  const included = [];
  const excluded = [];

  for (const sub of eligibleSubs) {
    const pid = subscriptionProfileId(sub);
    const mandateRow = pid ? mandateByProfile.get(pid) : null;
    const memberId =
      mandateRow?.membershipNumber ||
      sub.membershipNumber ||
      sub.personalDetails?.membershipNo ||
      sub.memberSnapshot?.membershipNumber ||
      null;

    const exclusionBase = {
      profileId: pid,
      subscriptionId: subscriptionId(sub),
      memberId,
    };

    if (!pid) {
      excluded.push({
        ...exclusionBase,
        exclusionReason: {
          code: "NO_PROFILE",
          message: "Subscription missing profileId",
        },
      });
      continue;
    }

    if (!memberId) {
      excluded.push({
        ...exclusionBase,
        exclusionReason: {
          code: "NO_PROFILE",
          message: "Profile not found for subscription",
        },
      });
      continue;
    }

    if (alreadyInRun.has(memberId)) {
      excluded.push({
        ...exclusionBase,
        memberId,
        exclusionReason: {
          code: "DUPLICATE_OPEN_RUN",
          message: "Member already in another open DD run for this period",
        },
      });
      continue;
    }

    if (!mandateRow) {
      excluded.push({
        ...exclusionBase,
        memberId,
        exclusionReason: {
          code: "NO_ACTIVE_MANDATE",
          message: "No active verified DD mandate on file",
        },
      });
      continue;
    }

    const dd = mandateRow.mandate || {};
    const debtorIban = normalizeIban(dd.debtorIban);
    const debtorBic = dd.debtorBic || null;
    if (!debtorIban || !dd.debtorName || !dd.umr) {
      excluded.push({
        ...exclusionBase,
        memberId,
        exclusionReason: {
          code: "INCOMPLETE_MANDATE",
          message: "Mandate missing UMR, debtor name, or IBAN",
        },
      });
      continue;
    }

    let outstandingCurrentCents = 0;
    try {
      const owed = await memberOwed1400ByBucket(memberId, new Date(run.periodEndDate).getFullYear());
      outstandingCurrentCents = Math.max(0, owed.current || 0);
    } catch {
      /* optional for non-AD_HOC */
    }

    const amountEur = computeCollectibleAmountEur({
      runType: run.runType,
      membershipCategory: sub.membershipCategory,
      paymentFrequency: sub.paymentFrequency,
      outstandingCurrentCents,
    });

    if (amountEur <= 0) {
      excluded.push({
        ...exclusionBase,
        memberId,
        exclusionReason: {
          code: "NO_COLLECTIBLE_AMOUNT",
          message: "No collectible amount for the period",
        },
      });
      continue;
    }

    const mandate = await upsertMandateFromSnapshot(
      tenantId,
      pid,
      memberId,
      mandateRow,
      mandateRow.paymentFormId,
      mandateRow.organisationSnapshot,
    );

    const seqTp = resolveSeqTp(mandate);
    const memberSnapshot = mandateRow.memberSnapshot || {};

    included.push({
      tenantId,
      runId: run._id,
      memberId,
      profileId: pid,
      subscriptionId: subscriptionId(sub),
      mandateId: mandate?._id,
      paymentFormId: mandateRow.paymentFormId,
      membershipNumber: memberId,
      memberSnapshot: {
        membershipNumber: memberId,
        fullName: memberSnapshot.fullName || memberId,
        email: memberSnapshot.email || null,
        membershipCategory: sub.membershipCategory,
        paymentFrequency: sub.paymentFrequency,
      },
      mandateSnapshot: {
        umr: dd.umr,
        signedDate: dd.signedDate ? new Date(dd.signedDate) : new Date("2013-01-01"),
        debtorName: dd.debtorName,
        debtorIban,
        debtorBic,
        debtorAddress: dd.debtorAddress,
        debtorCity: dd.debtorCity,
        debtorPostcode: dd.debtorPostcode,
        debtorCountry: dd.debtorCountry || "IE",
        seqTp,
      },
      amountEur,
      currency: "EUR",
      remittanceInfo: buildRemittanceInfo({
        membershipNumber: memberId,
        periodStart: run.periodStartDate,
        periodEnd: run.periodEndDate,
      }),
      collectionPeriod: {
        startDate: run.periodStartDate,
        endDate: run.periodEndDate,
      },
      status: "INCLUDED",
    });
  }

  const periodKey =
    run.periodKey ||
    (run.periodEndDate
      ? new Date(run.periodEndDate).toISOString().slice(0, 7).replace("-", "")
      : "");
  const runSequence = run.runSequence || 1;

  const withE2e = assignUniqueEndToEndIds({
    items: included.map((row) => ({ ...row, membershipNumber: row.memberId })),
    periodKey,
    runSequence,
  });

  const finalizedIncluded = withE2e.map((row) => {
    const endToEndId = row.endToEndId;
    const { membershipNumber: _m, ...rest } = row;
    return {
      ...rest,
      collection: { endToEndId },
      endToEndId,
    };
  });

  return { included: finalizedIncluded, excluded, preparedBy: actorId };
}

export function computeRunTotals(items) {
  const excluded = items.filter((i) => i.status === "EXCLUDED");
  const included = items.filter((i) => i.status !== "EXCLUDED");
  const unpaid = items.filter((i) => i.status === "UNPAID" || i.status === "REJECTED");
  const paid = items.filter((i) => i.status === "PAID");
  const billable = included.filter((i) => i.status !== "EXCLUDED");

  const sum = (arr) =>
    Math.round(arr.reduce((a, i) => a + Number(i.amountEur || 0), 0) * 100) / 100;

  return {
    includedCount: billable.length,
    excludedCount: excluded.length,
    includedAmountEur: sum(billable),
    paidCount: paid.length,
    paidAmountEur: sum(paid),
    unpaidCount: unpaid.length,
    unpaidAmountEur: sum(unpaid),
    rejectedCount: items.filter((i) => i.status === "REJECTED").length,
    rejectedAmountEur: sum(items.filter((i) => i.status === "REJECTED")),
  };
}
