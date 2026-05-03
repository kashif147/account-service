import mongoose from "mongoose";
import { logWarn } from "../middlewares/logger.mw.js";
import Payment from "../models/payment.model.js";

const isDebugEnabled = () =>
  String(process.env.STRIPE_ENRICHMENT_DEBUG || "").toLowerCase() === "true";

function debugLog(...args) {
  if (isDebugEnabled()) {
    console.log("[stripe-enrichment]", ...args);
  }
}

/** Receipts from Stripe reconciliation use docNo `RCP-<payment Mongo _id>`. */
function paymentIdStringFromReceiptDocNo(docNo) {
  if (!docNo || typeof docNo !== "string") return null;
  const m = /^RCP-([a-fA-F0-9]{24})$/u.exec(docNo.trim());
  return m && mongoose.Types.ObjectId.isValid(m[1]) ? m[1] : null;
}

async function loadPaymentIntentIdByPaymentId(paymentIdStrings, tenantId) {
  const map = new Map();
  if (!tenantId || !paymentIdStrings.length) return map;
  const unique = [...new Set(paymentIdStrings.filter(Boolean))];
  const objectIds = unique
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!objectIds.length) return map;

  const rows = await Payment.find({
    tenantId: String(tenantId),
    _id: { $in: objectIds },
  })
    .select({ stripe: 1 })
    .lean();

  for (const p of rows) {
    map.set(String(p._id), p.stripe?.paymentIntentId ?? null);
  }
  return map;
}

function extractIdentifiers(entries = []) {
  const linked =
    entries.find((e) => e?.accountCode === "2020" && (e?.memberId || e?.applicationId)) ||
    entries.find((e) => e?.memberId || e?.applicationId) ||
    null;
  return {
    memberId: linked?.memberId || null,
    applicationId: linked?.applicationId || null,
  };
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pickPreferredEmail(raw) {
  if (!raw) return null;
  const preferred = String(raw.preferredEmail || "")
    .trim()
    .toLowerCase();
  const fromPreferred =
    preferred === "work"
      ? raw.workEmail
      : preferred === "personal"
      ? raw.personalEmail
      : null;
  const email = fromPreferred || raw.personalEmail || raw.workEmail || raw.normalizedEmail;
  return email ? String(email).trim().toLowerCase() : null;
}

function resolveApiPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.data !== undefined) return payload.data;
  return payload;
}

/** Single header value (Node may use string[]). */
function incomingHeader(req, name) {
  const v = req.headers[name];
  if (v === undefined || v === null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  const t = String(s).trim();
  return t === "" ? null : t;
}

/**
 * Profile-service trusts gateway headers + JWT_SECRET for Bearer.
 * Subscription-service CRM routes use gateway headers or ACCESS_TOKEN_SECRET for Bearer — secrets often differ,
 * so always forward the gateway trust bundle when present so upstream uses the same auth path as account-service.
 */
function buildForwardHeaders(req, includeInternal = false) {
  const headers = { Accept: "application/json" };
  const auth = req.headers.authorization || req.headers.Authorization || null;
  const aadToken = req.headers["x-ms-token-aad-access-token"] || null;
  if (auth) {
    headers.Authorization = auth;
  } else if (aadToken) {
    headers.Authorization = `Bearer ${aadToken}`;
  }

  const tenantId =
    req.tenantId || req.ctx?.tenantId || incomingHeader(req, "x-tenant-id");
  if (tenantId) headers["x-tenant-id"] = String(tenantId);
  if (includeInternal) headers["x-internal-request"] = "true";

  const forwardGateway = [
    "x-jwt-verified",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
    "x-token-expires-at",
  ];
  for (const key of forwardGateway) {
    const v = incomingHeader(req, key);
    if (v !== null) headers[key] = v;
  }

  return headers;
}

/** Normalized list of subscriptions from GET /subscriptions or profile/current response inner payload. */
function subscriptionsListFromPayload(subData) {
  if (!subData || typeof subData !== "object") return [];
  const inner = subData.data;
  if (Array.isArray(inner)) return inner;
  if (inner && typeof inner === "object" && inner._id != null) return [inner];
  if (Array.isArray(subData)) return subData;
  return [];
}

function isApprovedApplicationStatus(value) {
  const s = String(value || "").trim().toLowerCase();
  return s === "approved";
}

async function fetchJson(url, req, options = {}) {
  const cache = options.cache instanceof Map ? options.cache : null;
  const cacheKey = `${options.method || "GET"}:${url}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  const requestPromise = (async () => {
    debugLog("HTTP request", {
      method: options.method || "GET",
      url,
      includeInternal: !!options.includeInternal,
    });
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 8000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          ...buildForwardHeaders(req, options.includeInternal),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        debugLog("HTTP error", { url, status: response.status, body });
        throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      const json = await response.json();
      debugLog("HTTP success", {
        url,
        status: response.status,
        hasData: json?.data != null,
      });
      return json;
    } finally {
      clearTimeout(timer);
    }
  })();

  if (cache) cache.set(cacheKey, requestPromise);
  return requestPromise;
}

async function mapWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const out = new Array(items.length);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, items.length));
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: safeLimit }, () => run()));
  return out;
}

async function loadPendingApplicationMap(applicationIds, req) {
  const byApplicationId = new Map();
  if (!applicationIds.length) return byApplicationId;
  debugLog("pending applications input", { applicationIds });

  const base = (process.env.PROFILE_SERVICE_URL || "").replace(/\/$/, "");
  const subscriptionBase = (process.env.SUBSCRIPTION_SERVICE_URL || "").replace(/\/$/, "");
  if (!base) {
    logWarn("PROFILE_SERVICE_URL not configured");
    return byApplicationId;
  }

  const fetchCache = new Map();
  const upstreamConcurrency = parseInt(
    process.env.STRIPE_ENRICHMENT_UPSTREAM_CONCURRENCY || "6",
    10
  );

  await mapWithConcurrency(applicationIds, upstreamConcurrency, async (applicationId) => {
    try {
      const url = `${base}/api/applications/${encodeURIComponent(applicationId)}`;
      const payload = await fetchJson(url, req, { cache: fetchCache });
      const app = resolveApiPayload(payload);
      if (!app) return;

      const status = app?.applicationStatus;
      const hasMembershipNumber =
        String(app?.membershipNumber || "").trim() !== "";
      let profileId = app?.profileId || app?.personalDetails?.profileId || null;
      let resolvedMembershipNumber = null;
      let resolvedProfile = null;

      // Some approved records still come via applicationId and have null membershipNumber.
      // Resolve through profileId so downstream UI can use membership number for approved members.
      if (isApprovedApplicationStatus(status) && !hasMembershipNumber) {
        if (!profileId && subscriptionBase) {
          try {
            const subByAppUrl =
              `${subscriptionBase}/api/v1/subscriptions` +
              `?applicationId=${encodeURIComponent(String(applicationId))}` +
              `&isCurrent=true`;
            const subPayload = await fetchJson(subByAppUrl, req, {
              includeInternal: true,
              cache: fetchCache,
            });
            const subData = resolveApiPayload(subPayload);
            const list = subscriptionsListFromPayload(subData);
            const sub = list[0] || null;
            profileId = sub?.profileId || profileId;
          } catch (subError) {
            logWarn("Failed to resolve profileId from subscription by applicationId", {
              applicationId,
              error: subError.message,
            });
          }
        }

        if (profileId) {
          try {
            const profileUrl = `${base}/api/profile/${encodeURIComponent(String(profileId))}`;
            const profilePayload = await fetchJson(profileUrl, req, { cache: fetchCache });
            const profileData = resolveApiPayload(profilePayload);
            const profile = profileData?.profile || profileData || null;
            resolvedMembershipNumber = profile?.membershipNumber || null;
            resolvedProfile = profile || null;
          } catch (profileError) {
            logWarn("Failed to resolve profile by profileId for approved application", {
              applicationId,
              profileId,
              error: profileError.message,
            });
          }
        }

        app._resolvedProfile = resolvedProfile;
        app._resolvedMembershipNumber = resolvedMembershipNumber;
      }

      if (app && app.applicationId) byApplicationId.set(String(app.applicationId), app);
      debugLog("pending application map result", {
        applicationId,
        found: !!(app && app.applicationId),
      });
    } catch (error) {
      logWarn("Failed to fetch application for stripe payment enrichment", {
        applicationId,
        error: error.message,
      });
    }
  });

  return byApplicationId;
}

async function loadApprovedMemberMap(memberIds, req) {
  const byMemberId = new Map();
  if (!memberIds.length) return byMemberId;
  debugLog("approved members input", { memberIds });

  const profileBase = (process.env.PROFILE_SERVICE_URL || "").replace(/\/$/, "");
  const subscriptionBase = (process.env.SUBSCRIPTION_SERVICE_URL || "").replace(/\/$/, "");
  if (!profileBase || !subscriptionBase) {
    logWarn(
      "PROFILE_SERVICE_URL or SUBSCRIPTION_SERVICE_URL not configured — approved enrichment limited"
    );
    return byMemberId;
  }

  const fetchCache = new Map();
  const upstreamConcurrency = parseInt(
    process.env.STRIPE_ENRICHMENT_UPSTREAM_CONCURRENCY || "6",
    10
  );

  await mapWithConcurrency(memberIds, upstreamConcurrency, async (memberId) => {
    try {
      const searchUrl = `${profileBase}/api/profile/search?q=${encodeURIComponent(
        memberId
      )}&limit=500`;
      const searchPayload = await fetchJson(searchUrl, req, { cache: fetchCache });
      const searchData = resolveApiPayload(searchPayload);
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      const profile =
        results.find(
          (r) =>
            String(r?.membershipNumber || "").trim().toLowerCase() ===
            String(memberId).trim().toLowerCase()
        ) || null;
      debugLog("profile search result", {
        memberId,
        resultsCount: results.length,
        matchedProfileId: profile?._id || null,
      });
      if (!profile?._id) return;

      const subscriptionsByQueryUrl =
        `${subscriptionBase}/api/v1/subscriptions` +
        `?profileId=${encodeURIComponent(String(profile._id))}` +
        `&isCurrent=true`;
      let currentSubscription = null;
      try {
        const subPayload = await fetchJson(subscriptionsByQueryUrl, req, {
          includeInternal: true,
          cache: fetchCache,
        });
        const subData = resolveApiPayload(subPayload);
        const list = subscriptionsListFromPayload(subData);
        currentSubscription = list.find((s) => s?.isCurrent === true) || list[0] || null;
        debugLog("subscription lookup result", {
          memberId,
          profileId: profile._id,
          subscriptionsCount: list.length,
          hasCurrentSubscription: !!currentSubscription,
        });
      } catch (subError) {
        logWarn("Failed to fetch current subscription for profile", {
          memberId,
          profileId: profile._id,
          error: subError.message,
        });
      }

      byMemberId.set(String(memberId), { profile, currentSubscription });
      debugLog("approved member map set", {
        memberId,
        hasProfile: !!profile,
        hasSubscription: !!currentSubscription,
      });
    } catch (error) {
      logWarn("Failed to fetch profile for stripe payment enrichment", {
        memberId,
        error: error.message,
      });
    }
  });

  return byMemberId;
}

function enrichStripePaymentItem({ item, identifiers, pendingByApp, approvedByMember }) {
  const memberId = identifiers.memberId;
  const applicationId = identifiers.applicationId;
  let resolvedMemberId = memberId || null;

  let membershipNumber = null;
  let fullName = null;
  let normalizedEmail = null;
  let mobileNumber = null;
  let membershipCategory = null;
  let membershipStatus = null;
  let joinDate = null;
  let renewalDate = null;
  let billingCycle = null;

  if (memberId) {
    const approved = approvedByMember.get(String(memberId));
    const profile = approved?.profile || null;
    const sub = approved?.currentSubscription || null;
    membershipNumber = String(memberId);
    fullName =
      profile?.personalInfo?.fullName ||
      [profile?.personalInfo?.forename, profile?.personalInfo?.surname]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      null;
    normalizedEmail = profile?.normalizedEmail || pickPreferredEmail(profile?.contactInfo);
    mobileNumber = profile?.contactInfo?.mobileNumber || null;
    membershipCategory = sub?.membershipCategory || null;
    membershipStatus =
      sub?.subscriptionStatus || profile?.additionalInformation?.membershipStatus || null;
    joinDate = safeDate(sub?.startDate);
    renewalDate = safeDate(sub?.endDate);
    billingCycle = sub?.paymentFrequency || null;
  } else if (applicationId) {
    const appId = String(applicationId);
    const application = pendingByApp.get(appId);
    const personal = application?.personalDetails || null;
    const professional = application?.professionalDetails || null;
    const subscription = application?.subscriptionDetails || null;
    fullName =
      personal?.personalInfo?.fullName ||
      [personal?.personalInfo?.forename, personal?.personalInfo?.surname]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      null;
    normalizedEmail = personal?.normalizedEmail || pickPreferredEmail(personal?.contactInfo);
    mobileNumber = personal?.contactInfo?.mobileNumber || null;
    membershipCategory = subscription?.membershipCategory || professional?.membershipCategory || null;
    membershipStatus = subscription?.membershipStatus || application?.applicationStatus || null;
    joinDate = safeDate(subscription?.dateJoined);
    renewalDate = safeDate(subscription?.dateLeft);
    billingCycle = subscription?.paymentFrequency || null;

    const resolvedMembershipNumber =
      application?.membershipNumber ||
      application?._resolvedMembershipNumber ||
      null;
    if (isApprovedApplicationStatus(application?.applicationStatus) && resolvedMembershipNumber) {
      membershipNumber = String(resolvedMembershipNumber);
      resolvedMemberId = membershipNumber;
      // Prefer canonical profile fields when available from profile lookup fallback.
      const profile = application?._resolvedProfile || null;
      if (profile) {
        fullName =
          fullName ||
          profile?.personalInfo?.fullName ||
          [profile?.personalInfo?.forename, profile?.personalInfo?.surname]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          null;
        normalizedEmail =
          normalizedEmail ||
          profile?.normalizedEmail ||
          pickPreferredEmail(profile?.contactInfo);
        mobileNumber = mobileNumber || profile?.contactInfo?.mobileNumber || null;
      }
    }
  }

  return {
    ...item,
    memberId: resolvedMemberId,
    applicationId: applicationId || null,
    membershipNumber,
    fullName,
    normalizedEmail,
    mobileNumber,
    membershipCategory,
    membershipStatus,
    joinDate,
    renewalDate,
    billingCycle,
  };
}

export async function enrichStripePaymentItems(rawItems, req) {
  debugLog("raw stripe items", {
    count: Array.isArray(rawItems) ? rawItems.length : 0,
    docs: Array.isArray(rawItems)
      ? rawItems.slice(0, 20).map((x) => ({
          docNo: x?.docNo,
          date: x?.date,
          entriesCount: Array.isArray(x?.entries) ? x.entries.length : 0,
        }))
      : [],
  });
  const idPairs = rawItems.map((item) => ({
    item,
    identifiers: extractIdentifiers(item.entries),
  }));
  const memberIds = [...new Set(idPairs.map((p) => p.identifiers.memberId).filter(Boolean))];
  const applicationIds = [
    ...new Set(idPairs.map((p) => p.identifiers.applicationId).filter(Boolean)),
  ];

  const paymentIdStrings = rawItems
    .map((item) => paymentIdStringFromReceiptDocNo(item?.docNo))
    .filter(Boolean);
  const tenantId = req.ctx?.tenantId ?? req.tenantId ?? null;

  const [pendingByApp, approvedByMember, paymentIntentByPaymentId] = await Promise.all([
    loadPendingApplicationMap(applicationIds, req),
    loadApprovedMemberMap(memberIds, req),
    loadPaymentIntentIdByPaymentId(paymentIdStrings, tenantId),
  ]);
  debugLog("lookup maps sizes", {
    pendingApplications: pendingByApp.size,
    approvedMembers: approvedByMember.size,
    paymentIntentLookups: paymentIntentByPaymentId.size,
  });

  const enriched = idPairs.map(({ item, identifiers }) => {
    const base = enrichStripePaymentItem({
      item,
      identifiers,
      pendingByApp,
      approvedByMember,
    });
    const payId = paymentIdStringFromReceiptDocNo(item?.docNo);
    const paymentIntentId = payId ? paymentIntentByPaymentId.get(payId) ?? null : null;
    return { ...base, paymentIntentId };
  });
  debugLog("enriched output sample", {
    count: enriched.length,
    sample: enriched.slice(0, 20).map((x) => ({
      docNo: x?.docNo,
      memberId: x?.memberId,
      applicationId: x?.applicationId,
      fullName: x?.fullName,
      normalizedEmail: x?.normalizedEmail,
      membershipCategory: x?.membershipCategory,
      membershipStatus: x?.membershipStatus,
    })),
  });
  return enriched;
}
