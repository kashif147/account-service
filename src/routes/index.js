import express from "express";
import templateRoutes from "./template.routes.js";

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
      templates: "/templates",
      docs: "/api/docs",
    },
    timestamp: new Date().toISOString(),
  });
});

router.use("/", templateRoutes);

export default router;
