import express from "express";
import { listCoA } from "../controllers/admin.controller.js";
import {
  ensureAuthenticated,
  authorizeMin,
  requireRole,
} from "../middlewares/auth.js";
import { idempotency } from "../middlewares/idempotency.js";

const router = express.Router();

// CoA - single route with role-based access (Accounts Manager or higher)
router.get("/coa", ensureAuthenticated, authorizeMin("AM"), listCoA);

// Create CoA - Super User only
router.post(
  "/coa",
  ensureAuthenticated,
  requireRole("SU"),
  idempotency(),
  (req, res) => {
    res.created({ message: "CoA created", user: req.ctx });
  }
);

// Update CoA - Accounts Manager or higher
router.put(
  "/coa/:id",
  ensureAuthenticated,
  authorizeMin("AM"),
  idempotency(),
  (req, res) => {
    res.success({ message: "CoA updated", user: req.ctx });
  }
);

export default router;
