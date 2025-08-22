import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const asList = (s, def = []) =>
  (s ? s.split(",").map(x => x.trim()).filter(Boolean) : def);

export const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/account-service?replicaSet=rs0",
  rabbitUrl: process.env.RABBIT_URL || "amqp://localhost:5672",
  rabbitExchange: process.env.RABBIT_EXCHANGE || "accounts.events",
  logLevel: process.env.LOG_LEVEL || "info",
  corsOrigins: asList(process.env.CORS_ORIGINS, ["http://localhost:3000"]),
  csp: {
    connectSrc: asList(process.env.CSP_CONNECT_SRC, ["'self'"]),
    imgSrc:     asList(process.env.CSP_IMG_SRC, ["'self'", "data:"]),
    scriptSrc:  asList(process.env.CSP_SCRIPT_SRC, ["'self'"]),
    styleSrc:   asList(process.env.CSP_STYLE_SRC, ["'self'", "'unsafe-inline'"])
  }
};
