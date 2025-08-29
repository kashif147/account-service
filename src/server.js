import { config } from "./config/index.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { connectRabbit, closeRabbit } from "./config/rabbit.js";
import logger from "./config/logger.js";
import app from "./app.js";


let server;

async function start() {
  await connectDB(config.mongoUri);
  await connectRabbit();

  server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "API listening");
  });
}

async function shutdown(signal) {
  try {
    logger.info({ signal }, "Shutting down");
    if (server) {
      await new Promise((res) => server.close(res));
    }
    await Promise.allSettled([closeRabbit(), disconnectDB()]);
    process.exit(0);
  } catch (e) {
    logger.error(e, "Shutdown error");
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  logger.error(err, "Unhandled rejection");
  shutdown("unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error(err, "Uncaught exception");
  shutdown("uncaughtException");
});

start().catch((err) => {
  logger.error({ err, stack: err.stack }, "Failed to start");
  process.exit(1);
});
