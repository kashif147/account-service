// P5 signed service authority - protocol "p5-svc-sig" version 1, SIGNER side for account-service
// calls TO profile-service (audience "profile-service", caller "account-service").
//
// The reverse direction of the S3 boundary (events/profile sign -> account verifies). Same
// canonicalization, byte for byte, as the reviewed primitive (account-service
// src/lib/serviceSigning.js on the S3 branch, events-service / profile-service signer copies);
// kept as a self-contained copy here because that module is not on this branch's base. Once both
// are merged this file should import canonicalString/signCanonical from lib/serviceSigning.js.
// contracts/p5-service-signing.application-refund-state.v1.json is byte-identical in
// profile-service (verifier) and pinned by SHA-256 in both suites; its first vector reproduces
// p5-service-signing.v1.json's first vector.
//
// Canonical string: "p5-svc-sig/1" then aud, caller, kid, method (UPPERCASE), target (exact path +
// raw query as sent), tenant (x-tenant-id), idem (Idempotency-Key; empty for a GET read), body
// (hex sha256 of the exact body bytes; empty for a GET), ts, nonce - each `<name>=<utf8 byte
// length>:<value>`, joined with "\n". sig = base64url(HMAC-SHA256(secret, canonical)), no padding.
//
// Config (this service's own runtime env file only; never JWT_SECRET, never a shared env file):
//   PROFILE_SIGNING_KID     key id, [A-Za-z0-9._-]{1,64}
//   PROFILE_SIGNING_SECRET  >= 32 chars; an INDEPENDENT key (not either S3 key)
// Not configured or invalid -> signingConfig() returns null and the caller must not send the
// request (it never sends an unsigned one). Never logs the secret, signature or nonce.
import crypto from "node:crypto";

export const PROTOCOL = "p5-svc-sig";
export const VERSION = "1";
export const AUDIENCE = "profile-service";
export const CALLER = "account-service";
export const MIN_SECRET_LENGTH = 32;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex");
}

function field(name, value) {
  const v = value == null ? "" : String(value);
  return `${name}=${Buffer.byteLength(v, "utf8")}:${v}`;
}

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

/** { kid, secret } when PROFILE_SIGNING_* is configured and valid, else null. */
export function signingConfig(env = process.env) {
  const kid = String(env.PROFILE_SIGNING_KID || "").trim();
  const secret = String(env.PROFILE_SIGNING_SECRET || "");
  if (!KID_RE.test(kid) || secret.length < MIN_SECRET_LENGTH) return null;
  return { kid, secret };
}

/** Exact path + raw query string of the URL actually requested. */
export function targetOf(url) {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Signature headers for one body-less request (GET), or null when signing is not configured. */
export function signatureHeaders({ method, url, tenant, env = process.env, now = Date.now(), nonce } = {}) {
  const cfg = signingConfig(env);
  if (!cfg) return null;
  const ts = String(Math.floor(now / 1000));
  const nonceV = nonce || crypto.randomBytes(18).toString("base64url");
  const canonical = canonicalString({
    caller: CALLER,
    kid: cfg.kid,
    method,
    target: targetOf(url),
    tenant,
    idem: "",
    bodySha256: sha256Hex(Buffer.alloc(0)),
    ts,
    nonce: nonceV,
  });
  return {
    "x-svc-version": VERSION,
    "x-svc-caller": CALLER,
    "x-svc-kid": cfg.kid,
    "x-svc-ts": ts,
    "x-svc-nonce": nonceV,
    "x-svc-sig": signCanonical(cfg.secret, canonical),
  };
}
