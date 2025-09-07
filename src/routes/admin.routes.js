import express from "express";
import { listCoA } from "../controllers/admin.controller.js";
import {
  ensureAuthenticated,
  authorizeMin,
  authorizeAny,
  requireRole,
  requirePermission,
  requireAnyPermission,
} from "../middlewares/auth.js";
import { idempotency } from "../middlewares/idempotency.js";
import PERMISSIONS from "@membership/shared-constants/permissions";

const router = express.Router();

// Admin routes with different authorization levels
// Chart of Accounts - requires minimum Accounts Manager level or specific permission
router.get(
  "/coa",
  ensureAuthenticated,
  authorizeMin("AM"), // Accounts Manager or higher
  listCoA
);

// Chart of Accounts - Read-only access for AI Agents and higher
router.get(
  "/coa/readonly",
  ensureAuthenticated,
  authorizeMin("AI"), // AI Agent or higher (read-only access)
  listCoA
);

// Example: Route that requires exact Super User role
router.get(
  "/admin-only",
  ensureAuthenticated,
  requireRole("SU"), // Super User only
  (req, res) => {
    res.success({ message: "Super User only access", user: req.ctx });
  }
);

// Example: Route that accepts multiple roles (Accounts Manager or General Secretary)
router.get(
  "/manager-or-secretary",
  ensureAuthenticated,
  authorizeAny("AM", "GS"),
  (req, res) => {
    res.success({ message: "Manager or Secretary access", user: req.ctx });
  }
);

// Example: Route with minimum Membership Officer role
router.get(
  "/membership-plus",
  ensureAuthenticated,
  authorizeMin("MO"), // Membership Officer or higher
  (req, res) => {
    res.success({
      message: "Membership Officer or higher access",
      user: req.ctx,
    });
  }
);

// Example: Route with permission-based authorization
router.get(
  "/financial-reports",
  ensureAuthenticated,
  requirePermission(PERMISSIONS.ACCOUNT.FINANCIAL_READ), // Requires specific permission
  (req, res) => {
    res.success({ message: "Financial reports access", user: req.ctx });
  }
);

// Example: Route requiring any of multiple permissions
router.get(
  "/sensitive-data",
  ensureAuthenticated,
  requireAnyPermission(
    PERMISSIONS.ACCOUNT.ADMIN_READ,
    PERMISSIONS.ACCOUNT.FINANCIAL_READ,
    PERMISSIONS.AUDIT.READ
  ),
  (req, res) => {
    res.success({ message: "Sensitive data access", user: req.ctx });
  }
);

// Example: POST route with idempotency and role requirement
router.post(
  "/coa",
  ensureAuthenticated,
  requireRole("SU"), // Only Super User can create CoA
  idempotency(),
  (req, res) => {
    res.created({ message: "CoA created", user: req.ctx });
  }
);

// Example: Route for Accounts Manager and above to update CoA
router.put(
  "/coa/:id",
  ensureAuthenticated,
  authorizeMin("AM"), // Accounts Manager or higher
  idempotency(),
  (req, res) => {
    res.success({ message: "CoA updated", user: req.ctx });
  }
);

export default router;
