import { createLogger } from "@projectShell/logging-lib";

export default createLogger(process.env.SERVICE_NAME || "account-service");
