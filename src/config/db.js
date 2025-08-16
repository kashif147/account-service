import mongoose from "mongoose";
import logger from "./logger.js";
import { config } from "./index.js";

export async function connectDB(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000,
autoIndex: process.env.NODE_ENV !== "production" });
  logger.info({ db: mongoose.connection.name }, "Mongo connected");
  return mongoose.connection;
}

export async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    logger.info("Mongo disconnected");
  }
}
