import pino from "pino";
import { config } from "./index.js";

export default pino({
  level: config.logLevel,
  transport: config.env === "development"
    ? { target: "pino-pretty", options: { singleLine: true } }
    : undefined
});
