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
import notFound from "./middlewares/notFound.js";
import errorHandler from "./middlewares/errorHandler.js";
import routes from "./routes/index.js";
import logger from "./config/logger.js";

const app = express();

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

// basic, global rate limit
app.use(limiterGeneral);

// health
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/ready", (req, res) => res.json({ ok: true }));

// swagger
app.use("/api/docs", swaggerServe, swaggerSetup);

// api routes
app.use("/api", routes);

// 404 + errors
app.use(notFound);
app.use(errorHandler);

export default app;
