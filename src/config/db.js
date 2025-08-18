import mongoose from "mongoose";
import logger from "./logger.js";
import { config } from "./index.js";

export async function connectDB(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000,
autoIndex: process.env.NODE_ENV !== "production" });
  logger.info({ db: mongoose.connection.name }, "Mongo connected");
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



