import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
import GL from "../models/glTransaction.model.js";
import { getProfileReadModel } from "../models/profileRead.model.js";

export function normMemberKey(value) {
  return String(value || "").trim().toLowerCase();
}

function memberIdFromClaimJournal(txn) {
  if (!txn?.entries?.length) return null;
  for (const e of txn.entries) {
    if (e.accountCode !== "2020" || e.dc !== "C" || !e.memberId) continue;
    const mid = String(e.memberId).trim();
    if (mid && !mid.toLowerCase().startsWith("app:")) return mid;
  }
  return null;
}

export function collectIdentityKeysFromGlTxns(txns) {
  const applicationIds = new Set();
  const profileIds = new Set();
  for (const txn of txns || []) {
    if (txn.sourceApplicationId) {
      applicationIds.add(String(txn.sourceApplicationId).trim());
    }
    for (const e of txn.entries || []) {
      if (e.applicationId) {
        applicationIds.add(String(e.applicationId).trim());
      }
      const m = String(e.memberId || "").trim();
      if (m.startsWith("profile:")) profileIds.add(m.slice(8));
      if (m.toLowerCase().startsWith("app:")) applicationIds.add(m.slice(4));
    }
  }
  return {
    applicationIds: [...applicationIds].filter(Boolean),
    profileIds: [...profileIds].filter(Boolean),
  };
}

export async function profileKeysLinkedToMember(memberId) {
  const mid = String(memberId || "").trim();
  if (!mid) return [];
  try {
    const Profile = getProfileReadModel();
    const profile = await Profile.findOne({ membershipNumber: mid })
      .select("_id")
      .lean();
    if (profile?._id) return [`profile:${profile._id}`];
  } catch {
    // profile DB not configured
  }
  return [];
}

export async function applicationIdsLinkedToMember(memberId) {
  const mid = String(memberId || "").trim();
  if (!mid) return [];
  const ids = new Set();
  const [payments, refunds, claimDocs] = await Promise.all([
    Payment.find({ memberId: mid }).select("applicationId").lean(),
    Refund.find({ memberId: mid }).select("applicationId").lean(),
    GL.find({ claimMemberId: mid }).select("sourceApplicationId docNo").lean(),
  ]);
  for (const p of payments) {
    if (p.applicationId) ids.add(String(p.applicationId).trim());
  }
  for (const r of refunds) {
    if (r.applicationId) ids.add(String(r.applicationId).trim());
  }
  for (const doc of claimDocs) {
    if (doc.sourceApplicationId) {
      ids.add(String(doc.sourceApplicationId).trim());
    }
    const m = String(doc.docNo || "").match(/^CLAIM-(.+)$/i);
    if (m?.[1]) ids.add(m[1].trim());
  }
  return [...ids].filter(Boolean);
}

export async function buildApplicationMemberMap(applicationIds) {
  const map = new Map();
  const ids = [
    ...new Set(
      (applicationIds || []).map((id) => String(id).trim()).filter(Boolean),
    ),
  ];
  if (!ids.length) return map;

  const claimDocNos = ids.map((id) => `CLAIM-${id}`);
  const [payments, refunds, claimDocs] = await Promise.all([
    Payment.find({
      applicationId: { $in: ids },
      memberId: { $exists: true, $nin: [null, ""] },
    })
      .select("applicationId memberId")
      .lean(),
    Refund.find({
      applicationId: { $in: ids },
      memberId: { $exists: true, $nin: [null, ""] },
    })
      .select("applicationId memberId")
      .lean(),
    GL.find({ docNo: { $in: claimDocNos } })
      .select({ docNo: 1, claimMemberId: 1, entries: 1 })
      .lean(),
  ]);

  for (const row of [...payments, ...refunds]) {
    const appId = String(row.applicationId || "").trim();
    const member = String(row.memberId || "").trim();
    if (
      appId &&
      member &&
      !member.toLowerCase().startsWith("app:") &&
      !member.startsWith("profile:")
    ) {
      map.set(appId, member);
    }
  }

  for (const doc of claimDocs) {
    const appId = String(doc.docNo || "")
      .replace(/^CLAIM-/i, "")
      .trim();
    const mid =
      String(doc.claimMemberId || "").trim() || memberIdFromClaimJournal(doc);
    if (
      appId &&
      mid &&
      !mid.toLowerCase().startsWith("app:") &&
      !mid.startsWith("profile:")
    ) {
      if (!map.has(appId)) map.set(appId, mid);
    }
  }

  return map;
}

export async function buildProfileMemberMap(profileIds) {
  const map = new Map();
  const ids = [
    ...new Set(
      (profileIds || []).map((id) => String(id).trim()).filter(Boolean),
    ),
  ];
  if (!ids.length) return map;
  try {
    const Profile = getProfileReadModel();
    const profiles = await Profile.find({ _id: { $in: ids } })
      .select("membershipNumber")
      .lean();
    for (const p of profiles) {
      const mn = String(p.membershipNumber || "").trim();
      if (mn && p._id) map.set(String(p._id), mn);
    }
  } catch {
    // profile DB unavailable
  }
  return map;
}

export async function createMemberIdentityResolver(txns, options = {}) {
  const { seedMemberId } = options;
  const keys = collectIdentityKeysFromGlTxns(txns);
  const applicationIds = new Set(keys.applicationIds);
  const profileIds = new Set(keys.profileIds);

  if (seedMemberId) {
    const linkedApps = await applicationIdsLinkedToMember(seedMemberId);
    for (const id of linkedApps) applicationIds.add(id);
    const profileKeys = await profileKeysLinkedToMember(seedMemberId);
    for (const pk of profileKeys) profileIds.add(pk.slice(8));
  }

  const [appToMember, profileToMember] = await Promise.all([
    buildApplicationMemberMap([...applicationIds]),
    buildProfileMemberMap([...profileIds]),
  ]);

  function resolveMemberId(raw) {
    const m = String(raw || "").trim();
    if (!m) return "";
    if (m.startsWith("profile:")) {
      return profileToMember.get(m.slice(8)) || "";
    }
    if (m.toLowerCase().startsWith("app:")) {
      return appToMember.get(m.slice(4)) || "";
    }
    return m;
  }

  return {
    appToMember,
    profileToMember,
    resolveMemberId,
    resolveApplicationId(appId) {
      const id = String(appId || "").trim();
      if (!id) return "";
      return appToMember.get(id) || "";
    },
  };
}

export function entryBelongsToMember(entry, memberId, resolver) {
  const tid = normMemberKey(memberId);
  const resolvedEntryMember = resolver.resolveMemberId(entry?.memberId);
  if (resolvedEntryMember && normMemberKey(resolvedEntryMember) === tid) {
    return true;
  }
  if (entry?.applicationId) {
    const fromApp = resolver.resolveApplicationId(entry.applicationId);
    if (fromApp && normMemberKey(fromApp) === tid) return true;
  }
  return false;
}

export async function buildMemberFacingGlQuery({
  memberId,
  docType,
  from,
  to,
}) {
  const q = { docType: { $ne: "Settlement" } };
  const date = {};
  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) date.$gte = fromDate;
  }
  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) date.$lte = toDate;
  }
  if (Object.keys(date).length) q.date = date;

  if (memberId) {
    const mid = String(memberId).trim();
    const memberOr = [
      { "entries.memberId": mid },
      { claimMemberId: mid },
    ];
    const profileKeys = await profileKeysLinkedToMember(mid);
    for (const pk of profileKeys) {
      memberOr.push({ "entries.memberId": pk });
    }
    const appIds = await applicationIdsLinkedToMember(mid);
    if (appIds.length) {
      memberOr.push(
        { "entries.applicationId": { $in: appIds } },
        { sourceApplicationId: { $in: appIds } },
      );
    }
    q.$or = memberOr;
  } else {
    q.$or = [
      { "entries.memberId": { $exists: true, $nin: [null, ""] } },
      { claimMemberId: { $exists: true, $nin: [null, ""] } },
      { "entries.applicationId": { $exists: true, $nin: [null, ""] } },
      { sourceApplicationId: { $exists: true, $nin: [null, ""] } },
    ];
  }

  if (docType) q.docType = docType;
  return q;
}
