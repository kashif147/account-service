import axios from "axios";

const POLICY_SERVICE_URL =
  process.env.POLICY_SERVICE_URL ||
  process.env.USER_SERVICE_URL ||
  "http://localhost:3000";

/**
 * Fetch tenant record (code, name) for SEPA reference generation.
 */
export async function fetchTenantRecord(tenantId, req = null) {
  if (!tenantId) return null;
  const base = POLICY_SERVICE_URL.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    "x-tenant-id": String(tenantId),
    "x-internal-request": "true",
  };
  if (req?.headers?.authorization) {
    headers.authorization = req.headers.authorization;
  }
  try {
    const response = await axios.get(`${base}/api/tenants/${tenantId}`, {
      headers,
      timeout: 8000,
      validateStatus: (s) => s < 500,
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    return response.data?.data || response.data || null;
  } catch {
    return null;
  }
}

export async function resolveTenantCode(tenantId, req = null) {
  const tenant = await fetchTenantRecord(tenantId, req);
  return tenant?.code || null;
}
