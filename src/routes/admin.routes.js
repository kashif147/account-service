import express from "express";
import { listCoA } from "../controllers/admin.controller.js";
import {
  ensureAuthenticated,
  authorizeMin,
  authorizeAny,
  requireRole,
} from "../middlewares/auth.js";
import { idempotency } from "../middlewares/idempotency.js";

const router = express.Router();

// Admin routes with different authorization levels
router.get("/coa", ensureAuthenticated, authorizeMin("Editor"), listCoA);

// Example: Route that requires exact Admin role
router.get(
  "/admin-only",
  ensureAuthenticated,
  requireRole("Admin"),
  (req, res) => {
    res.success({ message: "Admin only access", user: req.user });
  }
);

// Example: Route that accepts multiple roles
router.get(
  "/editor-or-admin",
  ensureAuthenticated,
  authorizeAny("Editor", "Admin"),
  (req, res) => {
    res.success({ message: "Editor or Admin access", user: req.user });
  }
);

// Example: Route with minimum User role
router.get(
  "/user-plus",
  ensureAuthenticated,
  authorizeMin("User"),
  (req, res) => {
    res.success({ message: "User or higher access", user: req.user });
  }
);

// Example: POST route with idempotency
router.post(
  "/coa",
  ensureAuthenticated,
  requireRole("Admin"),
  idempotency(),
  (req, res) => {
    res.created({ message: "CoA created", user: req.user });
  }
);

export default router;
