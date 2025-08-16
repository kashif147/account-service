import helmet from "helmet";
import { config } from "./index.js";

export function securityHeaders(req, res, next) {
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "connect-src": ["'self'", ...config.csp.connectSrc],
        "img-src": [...config.csp.imgSrc],
        "script-src": [...config.csp.scriptSrc],
        "style-src": [...config.csp.styleSrc]
      }
    },
    crossOriginEmbedderPolicy: false
  })(req, res, next);
}
