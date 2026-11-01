// pino-http serializers for the per-request "request completed" log: explicit safe fields only.
// Never headers (Authorization bearer tokens, stripe-signature, cookies, x-user-* identity), the
// query string, params or body.

/** @param {object} req pino-std-serializers request ({id, method, url, remoteAddress, ...}) */
export function safeRequestLogFields(req) {
  const url = typeof req?.url === "string" ? req.url : "";
  return {
    id: req?.id,
    method: req?.method,
    path: url.split("?")[0],
    remoteAddress: req?.remoteAddress,
  };
}

/** @param {object} res pino-std-serializers response ({statusCode, headers}) */
export function safeResponseLogFields(res) {
  return { statusCode: res?.statusCode };
}
