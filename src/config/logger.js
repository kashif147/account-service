import pino from "pino";
import pretty from "pino-pretty";

const stream =
  process.env.NODE_ENV === "production"
    ? undefined
    : pretty({
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      });

const logger = pino({}, stream);

export default logger;
