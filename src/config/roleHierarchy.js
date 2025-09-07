/**
 * Role Hierarchy Configuration
 *
 * Defines the privilege levels for role-based authorization.
 * Higher numbers indicate higher privilege levels.
 *
 * This hierarchy is used by authorization middleware to determine
 * if a user has sufficient privileges to access resources.
 */

export const ROLE_HIERARCHY = {
  // System Roles
  SU: 100, // Super User - highest privilege, bypasses all authorization

  // Executive Roles
  GS: 90, // General Secretary
  DGS: 85, // Deputy General Secretary

  // Director Level
  DIR: 80, // Director of Industrial Relations
  DPRS: 80, // Director of Professional and Regulatory Services
  ADIR: 75, // Assistant Director Industrial Relations

  // Management Level
  AM: 70, // Accounts Manager
  DAM: 65, // Deputy Accounts Manager
  MO: 60, // Membership Officer
  AMO: 55, // Assistant Membership Officer

  // Executive Level
  IRE: 50, // Industrial Relation Executive
  IRO: 45, // Industrial Relations Officers
  RO: 40, // Regional Officer
  BO: 35, // Branch Officer

  // Officer Level
  IO: 30, // Information Officer
  HLS: 25, // Head of Library Services
  CC: 20, // Course Coordinator
  ACC: 15, // Assistant Course Coordinator

  // Support Level
  LS: 10, // Librarian
  LA: 5, // Library Assistant
  AA: 5, // Accounts Assistant

  // AI and Automated Systems
  AI: 2, // AI Agent - Read-only access for automated systems

  // Basic Access
  REO: 1, // Read Only
  MEMBER: 1, // Member - Portal access for online payments
  "NON-MEMBER": 0, // Non-Member
};

/**
 * Get the privilege level for a role
 * @param {string} roleCode - The role code
 * @returns {number} The privilege level (0 if role not found)
 */
export function getRoleLevel(roleCode) {
  return ROLE_HIERARCHY[roleCode] || 0;
}

/**
 * Get the highest privilege level from an array of roles
 * @param {string[]} roles - Array of role codes
 * @returns {number} The highest privilege level
 */
export function getHighestRoleLevel(roles) {
  if (!roles || !Array.isArray(roles)) return 0;
  return Math.max(...roles.map((role) => ROLE_HIERARCHY[role] || 0));
}

/**
 * Check if a user has minimum required role level
 * @param {string[]} userRoles - User's roles
 * @param {string} minRole - Minimum required role
 * @returns {boolean} True if user has sufficient privileges
 */
export function hasMinimumRole(userRoles, minRole) {
  if (!userRoles || !Array.isArray(userRoles)) return false;
  const minLevel = ROLE_HIERARCHY[minRole] || 0;
  const userMaxLevel = getHighestRoleLevel(userRoles);
  return userMaxLevel >= minLevel;
}

/**
 * Check if user has Super User privileges
 * @param {string[]} userRoles - User's roles
 * @returns {boolean} True if user is Super User
 */
export function isSuperUser(userRoles) {
  return userRoles && userRoles.includes("SU");
}

/**
 * Get all roles at or above a certain level
 * @param {number} minLevel - Minimum privilege level
 * @returns {string[]} Array of role codes
 */
export function getRolesAtOrAbove(minLevel) {
  return Object.entries(ROLE_HIERARCHY)
    .filter(([_, level]) => level >= minLevel)
    .map(([role, _]) => role);
}

/**
 * Get role hierarchy as a sorted array
 * @returns {Array} Array of {role, level} objects sorted by level (descending)
 */
export function getRoleHierarchySorted() {
  return Object.entries(ROLE_HIERARCHY)
    .map(([role, level]) => ({ role, level }))
    .sort((a, b) => b.level - a.level);
}

export default ROLE_HIERARCHY;
