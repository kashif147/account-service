/**
 * Permission checks aligned with finance UI (payments:*) and journal APIs (accounts.journals:*).
 * @param {string[]} permissions
 * @param {string} resource
 * @param {string} action
 */
export function hasFinancePermission(permissions, resource, action) {
  const perms = Array.isArray(permissions) ? permissions : [];
  if (
    perms.includes("*") ||
    perms.includes("admin") ||
    perms.includes(`${resource}:*`)
  ) {
    return true;
  }
  if (perms.includes(`${resource}:${action}`)) return true;

  const aliases = {
    "accounts.journals": {
      read: ["payments:read", "accounts.reports:read", "accounts.admin:read"],
      create: ["payments:create", "payments:write", "accounts.admin:write"],
      write: ["payments:write", "accounts.admin:write"],
    },
    payments: {
      read: ["accounts.reports:read", "accounts.admin:read"],
      write: ["accounts.admin:write"],
      create: ["accounts.admin:write"],
    },
    "accounts.admin": {
      read: ["payments:read", "accounts.reports:read"],
      write: ["payments:write", "payments:create"],
    },
  };

  const list = aliases[resource]?.[action] || [];
  return list.some((p) => perms.includes(p));
}

export function collectRequestPermissions(req) {
  const fromUser = req.user?.permissions;
  const fromCtx = req.ctx?.permissions;
  const fromReq = req.permissions;
  const fromQuery = req.query?.permissions;
  const merged = [];
  for (const src of [fromUser, fromCtx, fromReq]) {
    if (Array.isArray(src)) merged.push(...src);
  }
  if (typeof fromQuery === "string" && fromQuery.trim()) {
    merged.push(
      ...fromQuery
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    );
  }
  return [...new Set(merged)];
}
