import mongoose from "mongoose";
import logger from "./logger.js";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
import { disconnectProfileDB } from "./profileDb.js";
import { disconnectSubscriptionDB } from "./subscriptionDb.js";

export async function connectDB(
  uri = process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/account-service"
) {
  // Parse pool size from environment variables with sensible defaults
  const maxPoolSize = parseInt(process.env.MONGODB_MAX_POOL_SIZE || "150", 10);
  const minPoolSize = parseInt(process.env.MONGODB_MIN_POOL_SIZE || "20", 10);
  const maxIdleTimeMS = parseInt(process.env.MONGODB_MAX_IDLE_TIME_MS || "30000", 10);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: process.env.NODE_ENV !== "production",
    maxPoolSize,
    minPoolSize,
    maxIdleTimeMS,
  });
  
  logger.info(
    { 
      db: mongoose.connection.name,
      maxPoolSize,
      minPoolSize,
      maxIdleTimeMS,
    },
    "Mongo connected with connection pool configuration"
  );

  try {
    const { default: BatchDetail } = await import("../models/batch.detail.model.js");
    await Promise.allSettled([
      Payment.init(),
      Refund.init(),
      BatchDetail.init(),
    ]);
    logger.info("Models initialized (indexes ensured)");
  } catch (e) {
    logger.warn({ err: e.message }, "Model init failed");
  }
  return mongoose.connection;
}

// // If you want to force index sync at boot (helpful in dev/staging):
// await Promise.all([
//   (await import("../models/coa.model.js")).default.init(),
//   (await import("../models/glTransaction.model.js")).default.init(),
//   (await import("../models/materializedBalance.model.js")).default.init()
// ]);

export async function disconnectDB() {
  await disconnectProfileDB();
  await disconnectSubscriptionDB();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    logger.info("Mongo disconnected");
  }
}
