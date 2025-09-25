import helmet from "helmet";

export function securityHeaders(req, res, next) {
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "connect-src": [
          "'self'",
          ...(process.env.CSP_CONNECT_SRC || "'self'")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ],
        "img-src": [
          ...(process.env.CSP_IMG_SRC || "'self',data:")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ],
        "script-src": [
          ...(process.env.CSP_SCRIPT_SRC || "'self'")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ],
        "style-src": [
          ...(process.env.CSP_STYLE_SRC || "'self','unsafe-inline'")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
  })(req, res, next);
}
