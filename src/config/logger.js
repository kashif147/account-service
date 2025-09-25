import pino from "pino";

export default pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    (process.env.NODE_ENV || "development") === "development"
      ? { target: "pino-pretty", options: { singleLine: true } }
      : undefined,
});
