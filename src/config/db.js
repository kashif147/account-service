import mongoose from "mongoose";
import logger from "./logger.js";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";

export async function connectDB(
  uri = process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/account-service"
) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: process.env.NODE_ENV !== "production",
  });
  logger.info({ db: mongoose.connection.name }, "Mongo connected");

  try {
    await Promise.allSettled([Payment.init(), Refund.init()]);
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
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    logger.info("Mongo disconnected");
  }
}
