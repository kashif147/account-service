import express from "express";
import { listCoA } from "../controllers/admin.controller.js";
import { ensureAuthenticated } from "../middlewares/auth.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";
import { idempotency } from "../middlewares/idempotency.js";

const router = express.Router();

// CoA - single route with role-based access (Accounts Manager or higher)
router.get(
  "/coa",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.admin", "read"),
  listCoA
);

// Create CoA - Super User only
router.post(
  "/coa",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.admin", "write"),
  idempotency(),
  (req, res) => {
    res.created({ message: "CoA created", user: req.ctx });
  }
);

// Update CoA - Accounts Manager or higher
router.put(
  "/coa/:id",
  ensureAuthenticated,
  defaultPolicyMiddleware.requirePermission("accounts.admin", "write"),
  idempotency(),
  (req, res) => {
    res.success({ message: "CoA updated", user: req.ctx });
  }
);

export default router;
