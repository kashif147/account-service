import { logWarn } from "../middlewares/logger.mw.js";

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

function buildForwardHeaders(req, includeInternal = false) {
  const headers = { Accept: "application/json" };
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth) headers.Authorization = auth;

  const passthroughHeaders = [
    "x-jwt-verified",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
    "x-client-principal-id",
    "x-client-principal-name",
    "x-ms-client-principal",
    "x-ms-token-aad-access-token",
  ];
  for (const key of passthroughHeaders) {
    const value = req.headers[key];
    if (value != null && value !== "") headers[key] = String(value);
  }

  const tenantId = req.tenantId || req.ctx?.tenantId || req.headers["x-tenant-id"];
  if (tenantId) headers["x-tenant-id"] = String(tenantId);
  if (includeInternal) headers["x-internal-request"] = "true";
  return headers;
}

async function fetchJson(url, req, options = {}) {
  const cache = options.cache instanceof Map ? options.cache : null;
  const cacheKey = `${options.method || "GET"}:${url}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  const requestPromise = (async () => {
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
        throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      return await response.json();
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

  const base = (process.env.PROFILE_SERVICE_URL || "").replace(/\/$/, "");
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
      if (app && app.applicationId) byApplicationId.set(String(app.applicationId), app);
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
      )}&limit=25`;
      const searchPayload = await fetchJson(searchUrl, req, { cache: fetchCache });
      const searchData = resolveApiPayload(searchPayload);
      const results = Array.isArray(searchData?.results) ? searchData.results : [];
      const profile =
        results.find(
          (r) =>
            String(r?.membershipNumber || "").trim().toLowerCase() ===
            String(memberId).trim().toLowerCase()
        ) || null;
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
        const list = Array.isArray(subData?.data)
          ? subData.data
          : Array.isArray(subData)
          ? subData
          : [];
        currentSubscription = list.find((s) => s?.isCurrent === true) || list[0] || null;
      } catch (subError) {
        logWarn("Failed to fetch current subscription for profile", {
          memberId,
          profileId: profile._id,
          error: subError.message,
        });
      }

      byMemberId.set(String(memberId), { profile, currentSubscription });
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
  }

  return {
    ...item,
    memberId: memberId || null,
    applicationId: applicationId || null,
    membershipNumber,
    fullName,
    normalizedEmail,
    mobileNumber,
    membershipCategory,
    membershipStatus,
    memberhsipStatus: membershipStatus,
    joinDate,
    JoinDate: joinDate,
    renewalDate,
    RenewalDate: renewalDate,
    billingCycle,
    email: normalizedEmail,
    phone: mobileNumber,
    category: membershipCategory,
    "Member No": membershipNumber || applicationId || "-",
    id: item?._id ? String(item._id) : item?.docNo,
    transactionId: item?.docNo,
  };
}

export async function enrichStripePaymentItems(rawItems, req) {
  const idPairs = rawItems.map((item) => ({
    item,
    identifiers: extractIdentifiers(item.entries),
  }));
  const memberIds = [...new Set(idPairs.map((p) => p.identifiers.memberId).filter(Boolean))];
  const applicationIds = [
    ...new Set(idPairs.map((p) => p.identifiers.applicationId).filter(Boolean)),
  ];

  const [pendingByApp, approvedByMember] = await Promise.all([
    loadPendingApplicationMap(applicationIds, req),
    loadApprovedMemberMap(memberIds, req),
  ]);

  return idPairs.map(({ item, identifiers }) =>
    enrichStripePaymentItem({ item, identifiers, pendingByApp, approvedByMember })
  );
}
