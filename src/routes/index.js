import express from "express";
import adminRoutes from "./admin.routes.js";
import journalRoutes from "./journal.routes.js";
import reportsRoutes from "./reports.routes.js";

const router = express.Router();

// Root route - service information
router.get("/", (req, res) => {
  res.success({
    service: "Account Service",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "/health",
      status: "/status",
      admin: "/admin",
      journal: "/journal",
      reports: "/reports",
      docs: "/api/docs",
    },
    timestamp: new Date().toISOString(),
  });
});

router.use("/admin", adminRoutes);
router.use("/journal", journalRoutes);
router.use("/reports", reportsRoutes);

export default router;
