import cors from "cors";
import { AppError } from "../errors/AppError.js";

/**
 * CORS Configuration for Microservice Architecture
 * Handles cross-origin requests from multiple frontend applications
 */

// Environment-based CORS configuration
export const getCorsConfig = () => {
  const environment = process.env.NODE_ENV || "development";

  // Base allowed origins for different environments
  const baseOrigins = {
    development: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:8080",
      "http://localhost:8081",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
    ],
    staging: [
      "http://localhost:3000",
      "https://testportal-dabravg2h3hfbke9.canadacentral-01.azurewebsites.net",
      "https://userserviceshell-aqf6f0b8fqgmagch.canadacentral-01.azurewebsites.net",
      "https://projectshellapi-c0hqhbdwaaahbcab.northeurope-01.azurewebsites.net",
      "https://staging-admin.yourdomain.com",
      "https://staging-mobile.yourdomain.com",
    ],
    production: [
      "https://app.yourdomain.com",
      "https://admin.yourdomain.com",
      "https://mobile.yourdomain.com",
    ],
  };

  // Get additional origins from environment variables
  const additionalOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [];

  // Combine base origins with additional ones
  const allowedOrigins = [
    ...(baseOrigins[environment] || baseOrigins.development),
    ...additionalOrigins.filter((origin) => origin.trim()),
  ];

  // Remove duplicates
  const uniqueOrigins = [...new Set(allowedOrigins)];

  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman, etc.)
      if (!origin) {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      if (uniqueOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // Log blocked origins for debugging
        console.warn(`CORS blocked origin: ${origin}`);
        console.log(`Allowed origins: ${uniqueOrigins.join(", ")}`);
        callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
      }
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Request-ID",
      "X-Correlation-ID",
      "X-Tenant-ID",
      "X-User-ID",
      "Cache-Control",
      "Pragma",
      "maxbodylength",
    ],
    exposedHeaders: [
      "X-Request-ID",
      "X-Correlation-ID",
      "X-Total-Count",
      "X-Page-Count",
    ],
    maxAge: 86400, // 24 hours
  };
};

// Create CORS middleware
export const corsMiddleware = cors(getCorsConfig());

// Preflight handler for OPTIONS requests
export const handlePreflight = (req, res, next) => {
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Origin", req.headers.origin);
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD"
    );
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Request-ID, X-Correlation-ID, X-Tenant-ID, X-User-ID, Cache-Control, Pragma, maxbodylength"
    );
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Max-Age", "86400");
    return res.status(200).end();
  }
  next();
};

// CORS error handler
export const corsErrorHandler = (err, req, res, next) => {
  if (err.message && err.message.includes("Not allowed by CORS")) {
    return next(
      AppError.forbidden("CORS policy violation", {
        code: "CORS_ERROR",
        details:
          process.env.NODE_ENV === "development"
            ? err.message
            : "Cross-origin request blocked",
        allowedOrigins:
          process.env.NODE_ENV === "development"
            ? process.env.ALLOWED_ORIGINS?.split(",") || []
            : undefined,
      })
    );
  }
  next(err);
};
