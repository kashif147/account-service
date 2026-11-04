// P5 S3 signed service authority - protocol "p5-svc-sig" version 1 (verifier side).
//
// A caller service (events-service, profile-service) signs each bound payment command with its OWN
// credential; account-service verifies it before the five payment-mutation routes. This module is
// the canonicalization + HMAC primitive only; the request checks live in
// middlewares/serviceAuth.middleware.js. events-service and profile-service carry a CommonJS copy
// of the same algorithm; contracts/p5-service-signing.v1.json (byte-identical in all three repos,
// SHA-256 pinned in each test suite) holds the shared test vectors.
//
// Canonical string (UTF-8), one field per line, fixed order, every value LENGTH-PREFIXED so no
// value can be split or merged into a neighbour (no escaping rules, no ambiguity):
//
//   p5-svc-sig/1
//   aud=<len>:account-service
//   caller=<len>:<caller id>
//   kid=<len>:<key id>
//   method=<len>:<UPPERCASE method>
//   target=<len>:<exact request path + raw query string, as sent on the wire>
//   tenant=<len>:<x-tenant-id>
//   idem=<len>:<Idempotency-Key>
//   body=<len>:<lowercase hex sha256 of the EXACT transmitted body bytes>
//   ts=<len>:<unix seconds>
//   nonce=<len>:<nonce>
//
// <len> is the UTF-8 byte length of the value in decimal. Lines are joined with "\n", no trailing
// newline. Signature = base64url(HMAC-SHA256(secret, canonical)), no padding.
//
// Headers: x-svc-version (1), x-svc-caller, x-svc-kid, x-svc-ts, x-svc-nonce, x-svc-sig.
// The audience is fixed ("account-service") and is not a header: a signature made for another
// audience never verifies here.
import crypto from "node:crypto";

export const PROTOCOL = "p5-svc-sig";
export const VERSION = "1";
export const AUDIENCE = "account-service";
export const MAX_SKEW_SECONDS = 60;
export const MIN_SECRET_LENGTH = 32;

export const HEADERS = Object.freeze({
  version: "x-svc-version",
  caller: "x-svc-caller",
  kid: "x-svc-kid",
  ts: "x-svc-ts",
  nonce: "x-svc-nonce",
  sig: "x-svc-sig",
});

const CALLER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const TS_RE = /^[0-9]{1,12}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/; // 32-byte HMAC-SHA256, base64url, no padding

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex");
}

function field(name, value) {
  const v = value == null ? "" : String(value);
  return `${name}=${Buffer.byteLength(v, "utf8")}:${v}`;
}

/** The exact canonical string for one request (see header comment). */
export function canonicalString({ caller, kid, method, target, tenant, idem, bodySha256, ts, nonce, aud = AUDIENCE }) {
  return [
    `${PROTOCOL}/${VERSION}`,
    field("aud", aud),
    field("caller", caller),
    field("kid", kid),
    field("method", String(method || "").toUpperCase()),
    field("target", target),
    field("tenant", tenant),
    field("idem", idem),
    field("body", bodySha256),
    field("ts", ts),
    field("nonce", nonce),
  ].join("\n");
}

export function signCanonical(secret, canonical) {
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("base64url");
}

/** Constant-time signature comparison; unequal lengths still run one timingSafeEqual. */
export function signaturesEqual(expected, given) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(given || ""), "utf8");
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Parses a caller key map "kid:secret[,kid:secret]" (current + next during rotation).
 * Secrets shorter than MIN_SECRET_LENGTH, malformed kids and duplicates are dropped, so a weak or
 * broken entry can never verify. Returns Map<kid, secret>.
 */
export function parseKeyMap(raw) {
  const out = new Map();
  for (const part of String(raw || "").split(",")) {
    const entry = part.trim();
    const i = entry.indexOf(":");
    if (i <= 0) continue;
    const kid = entry.slice(0, i);
    const secret = entry.slice(i + 1);
    if (!KID_RE.test(kid) || secret.length < MIN_SECRET_LENGTH || out.has(kid)) continue;
    out.set(kid, secret);
  }
  return out;
}

/** Env var holding a caller's key map on account-service: SVC_SIGNING_KEYS_<CALLER>. */
export function keyMapEnvName(caller) {
  return `SVC_SIGNING_KEYS_${String(caller).toUpperCase().replace(/-/g, "_")}`;
}

/** Header-shape validation (before any secret is touched). Returns a reason code or null. */
export function headerShapeError(h) {
  if (h.version !== VERSION) return "VERSION";
  if (!CALLER_RE.test(h.caller || "")) return "CALLER_FORMAT";
  if (!KID_RE.test(h.kid || "")) return "KID_FORMAT";
  if (!TS_RE.test(h.ts || "")) return "TS_FORMAT";
  if (!NONCE_RE.test(h.nonce || "")) return "NONCE_FORMAT";
  if (!SIG_RE.test(h.sig || "")) return "SIG_FORMAT";
  return null;
}

export function withinSkew(ts, nowSeconds, maxSkew = MAX_SKEW_SECONDS) {
  const t = Number(ts);
  return Number.isSafeInteger(t) && Math.abs(nowSeconds - t) <= maxSkew;
}
