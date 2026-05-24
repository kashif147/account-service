import express from "express";
import adminRoutes from "./admin.routes.js";
import journalRoutes from "./journal.routes.js";
import reportsRoutes from "./reports.routes.js";
import paymentsRoutes from "./payment.routes.js";
import batchDetailRoutes from "./batch.detail.routes.js";
import internalRoutes from "./internal.routes.js";
import financeRoutes from "./finance.routes.js";
import directDebitRunRoutes from "./directDebitRun.routes.js";

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
      batchDetails: "/batch-details",
      internal: "/internal",
      finance: "/finance",
      directDebitRuns: "/direct-debit-runs",
      docs: "/api/docs",
    },
    timestamp: new Date().toISOString(),
  });
});

router.use("/admin", adminRoutes);
router.use("/journal", journalRoutes);
router.use("/reports", reportsRoutes);
router.use("/payments", paymentsRoutes);
router.use("/batch-details", batchDetailRoutes);
router.use("/internal", internalRoutes);
router.use("/finance", financeRoutes);
router.use("/direct-debit-runs", directDebitRunRoutes);

export default router;
