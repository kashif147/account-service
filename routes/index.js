import express from "express";
import adminRoutes from "./admin.routes.js";
import journalRoutes from "./journal.routes.js";
import reportsRoutes from "./reports.routes.js";

const router = express.Router();

router.use("/admin", adminRoutes);
router.use("/journal", journalRoutes);
router.use("/reports", reportsRoutes);

export default router;
