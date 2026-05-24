import mongoose from "mongoose";
import { getSubscriptionReadModel } from "../models/subscriptionRead.model.js";
import { getPaymentFormReadModel } from "../models/paymentFormRead.model.js";
import { getProfileReadModel } from "../models/profileRead.model.js";
import DirectDebitMandate from "../models/directDebitMandate.model.js";
import DirectDebitRunItem from "../models/directDebitRunItem.model.js";
import DirectDebitRun, { OPEN_RUN_STATUSES } from "../models/directDebitRun.model.js";
import { decryptField } from "../helpers/paymentFormCrypto.js";
import { normalizeIban } from "../helpers/sepaXml.helper.js";
import {
  buildEndToEndId,
  buildRemittanceInfo,
  computeCollectibleAmountEur,
  resolveSeqTp,
} from "../helpers/directDebitAmount.helper.js";
import { memberOwed1400ByBucket } from "../helpers/paymentReceiptAllocation.js";

const ACTIVE_SUBSCRIPTION = "Active";
const DIRECT_DEBIT_PAYMENT = "Direct Debit";
const DD_FORM_TYPE = "DD_MANDATE";
const ACTIVE_FORM_STATUS = "active";

function resolveMemberName(profile) {
  const pi = profile?.personalInfo || {};
  const forename = pi.forename || pi.firstName || "";
  const surname = pi.surname || pi.lastName || "";
  return `${forename} ${surname}`.trim() || profile?.membershipNumber || "";
}

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

async function upsertMandateFromForm(tenantId, profile, form, decrypted) {
  const dd = form.directDebitMandate || {};
  const org = form.organisationSnapshot || {};
  const memberId = profile.membershipNumber;
  const umr = dd.uniqueMandateReference;
  if (!umr) return null;

  const payload = {
    tenantId,
    profileId: profile._id,
    memberId,
    membershipNumber: profile.membershipNumber,
    paymentFormId: form._id,
    umr,
    signedDate: dd.signedDate ? new Date(dd.signedDate) : new Date("2013-01-01"),
    status: "ACTIVE",
    debtorName: dd.debtorName,
    debtorIban: normalizeIban(decrypted.iban),
    debtorBic: decrypted.bic || null,
    debtorAddress: dd.debtorAddress,
    debtorCity: dd.debtorCity,
    debtorPostcode: dd.debtorPostcode,
    debtorCountry: dd.debtorCountry || "IE",
    creditorName: dd.creditorName || org.name,
    creditorOin: dd.creditorIdentifier || org.sepaOriginatorIdentificationNumber,
    creditorIban: normalizeIban(dd.creditorIban || org.creditorIban),
    creditorBic: dd.creditorBic || org.creditorBic,
    syncedFromPaymentFormAt: new Date(),
  };

  return DirectDebitMandate.findOneAndUpdate(
    { tenantId, umr },
    { $set: payload, $setOnInsert: { successfulCollectionCount: 0 } },
    { upsert: true, new: true },
  );
}

/**
 * Select eligible members and return INCLUDED + EXCLUDED item drafts.
 */
export async function buildEligibilityItems({
  tenantId,
  run,
  actorId,
}) {
  const Subscription = getSubscriptionReadModel();
  const PaymentForm = getPaymentFormReadModel();
  const Profile = getProfileReadModel();

  const subs = await Subscription.find({
    tenantId,
    isCurrent: true,
    subscriptionStatus: ACTIVE_SUBSCRIPTION,
    paymentType: DIRECT_DEBIT_PAYMENT,
    deleted: { $ne: true },
  })
    .select(
      "profileId membershipCategory paymentFrequency subscriptionStatus startDate endDate",
    )
    .lean();

  const profileIds = subs.map((s) => s.profileId).filter(Boolean);
  const profiles = await Profile.find({
    _id: { $in: profileIds },
    ...(tenantId ? { tenantId } : {}),
  })
    .select("membershipNumber personalInfo contactInfo tenantId")
    .lean();
  const profileById = new Map(profiles.map((p) => [String(p._id), p]));

  const forms = await PaymentForm.find({
    tenantId,
    profileId: { $in: profileIds },
    formType: DD_FORM_TYPE,
    status: ACTIVE_FORM_STATUS,
    "directDebitMandate.isAuthorized": true,
  })
    .sort({ updatedAt: -1 })
    .lean();

  const formByProfile = new Map();
  for (const f of forms) {
    const k = String(f.profileId);
    if (!formByProfile.has(k)) formByProfile.set(k, f);
  }

  const alreadyInRun = await membersInOpenRunsForPeriod(
    tenantId,
    run.periodStartDate,
    run.periodEndDate,
  );

  const included = [];
  const excluded = [];

  for (const sub of subs) {
    const pid = String(sub.profileId);
    const profile = profileById.get(pid);
    const memberId = profile?.membershipNumber;
    const exclusionBase = {
      profileId: sub.profileId,
      subscriptionId: sub._id,
      memberId: memberId || null,
    };

    if (!profile || !memberId) {
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

    const form = formByProfile.get(pid);
    if (!form) {
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

    const dd = form.directDebitMandate || {};
    const debtorIban = normalizeIban(decryptField(dd.debtorIban));
    const debtorBic = decryptField(dd.debtorBic);
    if (!debtorIban || !dd.debtorName || !dd.uniqueMandateReference) {
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

    const mandate = await upsertMandateFromForm(tenantId, profile, form, {
      iban: debtorIban,
      bic: debtorBic,
    });

    const seqTp = resolveSeqTp(mandate);
    const endToEndId = buildEndToEndId({
      membershipNumber: memberId,
      periodEndDate: run.periodEndDate,
      runNo: run.runNo,
    });

    included.push({
      tenantId,
      runId: run._id,
      memberId,
      profileId: profile._id,
      subscriptionId: sub._id,
      mandateId: mandate?._id,
      paymentFormId: form._id,
      memberSnapshot: {
        membershipNumber: memberId,
        fullName: resolveMemberName(profile),
        email:
          profile.contactInfo?.personalEmail ||
          profile.contactInfo?.workEmail ||
          null,
        membershipCategory: sub.membershipCategory,
        paymentFrequency: sub.paymentFrequency,
      },
      mandateSnapshot: {
        umr: dd.uniqueMandateReference,
        signedDate: dd.signedDate ? new Date(dd.signedDate) : new Date("2013-01-01"),
        debtorName: dd.debtorName,
        debtorIban,
        debtorBic: debtorBic || null,
        debtorAddress: dd.debtorAddress,
        debtorCity: dd.debtorCity,
        debtorPostcode: dd.debtorPostcode,
        debtorCountry: dd.debtorCountry || "IE",
        seqTp,
      },
      amountEur,
      currency: "EUR",
      endToEndId,
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

  return { included, excluded, preparedBy: actorId };
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
