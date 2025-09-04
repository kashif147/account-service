import express from "express";
import compression from "compression";
import pinoHttp from "pino-http";
import helmet from "helmet";
import bodyParser from "body-parser";
import { corsMiddleware } from "./config/cors.js";
import { securityHeaders } from "./config/security.js";
import { limiterGeneral } from "./config/rateLimiters.js";
import { swaggerServe, swaggerSetup } from "./config/swagger.js";
import requestId from "./middlewares/requestId.js";
import loggerMiddleware from "./middlewares/logger.mw.js";
import responseMiddleware from "./middlewares/response.mw.js";
import notFound from "./middlewares/notFound.js";
import errorHandler from "./middlewares/errorHandler.js";
import routes from "./routes/index.js";
import logger from "./config/logger.js";
import { getIdempotencyCacheSize } from "./middlewares/idempotency.js";
import {
  initEventSystem,
  setupConsumers,
  shutdownEventSystem,
} from "./infra/rabbit/events.js";

const app = express();

// Initialize event system
let eventSystemInitialized = false;

async function initializeEventSystem() {
  try {
    await initEventSystem();
    await setupConsumers();
    eventSystemInitialized = true;
    logger.info("Event system initialized successfully");
  } catch (error) {
    logger.warn(
      { error: error.message },
      "Event system initialization failed, continuing without messaging"
    );
  }
}

// Initialize event system on startup
initializeEventSystem();

// logging first
app.use(pinoHttp({ logger }));

// hardening
app.use(corsMiddleware);
app.use(securityHeaders);
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(compression());

// body
app.use(bodyParser.json({ limit: "1mb" }));

// request id for correlation
app.use(requestId);

// custom logger middleware for detailed request/response logging
app.use(loggerMiddleware);

// response middleware for consistent API responses
app.use(responseMiddleware);

// basic, global rate limit
app.use(limiterGeneral);

// health
app.get("/health", (req, res) => res.success({ ok: true }));
app.get("/ready", (req, res) => res.success({ ok: true }));

// idempotency health check
app.get("/health/idempotency", (req, res) => {
  res.success({
    cacheSize: getIdempotencyCacheSize(),
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// logging health check
app.get("/health/logging", (req, res) => {
  res.success({
    status: "healthy",
    level: process.env.LOG_LEVEL || "info",
    timestamp: new Date().toISOString(),
  });
});

// event system health check
app.get("/health/events", (req, res) => {
  res.success({
    status: eventSystemInitialized ? "healthy" : "initializing",
    initialized: eventSystemInitialized,
    timestamp: new Date().toISOString(),
  });
});

// swagger
app.use("/api/docs", swaggerServe, swaggerSetup);

// api routes
app.use("/api", routes);

// 404 + errors
app.use(notFound);
app.use(errorHandler);

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await shutdownEventSystem();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down gracefully");
  await shutdownEventSystem();
  process.exit(0);
});

export default app;
