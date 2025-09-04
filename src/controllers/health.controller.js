// Template controller - replace with your service-specific logic
import { AppError } from "../errors/AppError.js";
import { logInfo, logError } from "../middlewares/logger.mw.js";

export async function getHealth(req, res, next) {
  try {
    logInfo("Health check requested");
    res.success({
      status: "healthy",
      service: "template-service",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError("Health check failed", { error: error.message });
    next(error);
  }
}

export async function getStatus(req, res, next) {
  try {
    res.success({
      status: "operational",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}
