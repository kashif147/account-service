// P5 S3 signed service authority - protocol primitives and verifier decisions (no network, no DB).
// The shared vectors (contracts/p5-service-signing.v1.json) are byte-identical in account-service,
// events-service and profile-service; the SHA-256 below is pinned in all three suites.
//
//   node --test --test-force-exit src/tests/serviceSigning.p5.test.mjs
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-svcsig-"));

export const SIGNING_VECTORS_SHA256 = "470d151d232a1acc00ae724afe05bc0986a0f5131fbc55861c3edd168383bf64";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/p5-service-signing.v1.json");
const RAW = fs.readFileSync(FIXTURE);
const V = JSON.parse(RAW.toString("utf8"));

const S = await import("../lib/serviceSigning.js");
const { createServiceAuthVerifier, evaluateServiceAuth } = await import("../middlewares/serviceAuth.middleware.js");
const mongoose = (await import("mongoose")).default;

const EV_SECRET = "TEST-ONLY-unit-events-secret-0123456789abcdef";
const EV_NEXT = "TEST-ONLY-unit-events-next-secret-0123456789ab";
const PR_SECRET = "TEST-ONLY-unit-profile-secret-0123456789abcdef";
const T = "aaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = 1793000100;

function env(extra = {}) {
  return {
    SVC_SIGNING_KEYS_EVENTS_SERVICE: `ev-1:${EV_SECRET},ev-2:${EV_NEXT}`,
    SVC_SIGNING_KEYS_PROFILE_SERVICE: `pr-1:${PR_SECRET}`,
    ...extra,
  };
}

function memoryNonceModel() {
  const seen = new Set();
  return {
    seen,
    async create({ caller, nonce }) {
      const k = `${caller}|${nonce}`;
      if (seen.has(k)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      seen.add(k);
    },
  };
}

const regBody = (over = {}) =>
  JSON.stringify({ binding: { domain: "registration", registrationId: "b".repeat(24), purpose: "eventRegistration" }, transition: "capture", reason: "approve", actorUserId: "c".repeat(24), ...over });
const appBody = () =>
  JSON.stringify({ binding: { domain: "application", applicationId: "d".repeat(24), purpose: "subscriptionFee" }, transition: "capture", reason: "approve", actorUserId: "c".repeat(24) });

let n = 0;
/** Builds a signed fake request; `tamper` mutates the transmitted request AFTER signing. */
function signedReq({ caller = "events-service", kid = "ev-1", secret = EV_SECRET, method = "POST", target = "/api/payments/intents/pi_1/capture", tenant = T, idem = "registration:capture:" + "b".repeat(24) + ":pi_1", body = regBody(), ts = String(NOW), nonce, aud } = {}, tamper = (r) => r) {
  const nonceV = nonce || crypto.randomBytes(18).toString("base64url") + String(n++).padStart(4, "0");
  const raw = Buffer.from(body, "utf8");
  const canonical = S.canonicalString({ caller, kid, method, target, tenant, idem, bodySha256: S.sha256Hex(raw), ts, nonce: nonceV, ...(aud ? { aud } : {}) });
  const req = {
    method,
    originalUrl: target,
    rawBody: raw,
    body: JSON.parse(body || "{}"),
    headers: {
      "x-internal-request": "true",
      "x-tenant-id": tenant,
      "idempotency-key": idem,
      "x-svc-version": "1",
      "x-svc-caller": caller,
      "x-svc-kid": kid,
      "x-svc-ts": ts,
      "x-svc-nonce": nonceV,
      "x-svc-sig": S.signCanonical(secret, canonical),
    },
  };
  return tamper(req);
}

const deps = (over = {}) => ({ env: env(), nowSeconds: () => NOW, NonceModel: memoryNonceModel(), ...over });

// mongoose.connection.readyState must be 1 for the nonce store; the unit tests use an in-memory
// model, so present a connected state for the duration of each evaluation.
function connected(fn) {
  return async (...a) => {
    const desc = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
    try {
      return await fn(...a);
    } finally {
      if (desc) Object.defineProperty(mongoose.connection, "readyState", desc);
      else delete mongoose.connection.readyState;
    }
  };
}

test("shared vectors: pinned file, and this implementation reproduces every canonical string and signature", () => {
  assert.equal(crypto.createHash("sha256").update(RAW).digest("hex"), SIGNING_VECTORS_SHA256);
  assert.equal(V.contract, "p5-svc-sig");
  assert.equal(V.version, 1);
  assert.equal(V.audience, "account-service");
  for (const v of V.vectors) {
    const { body, ...f } = v.input;
    const bodySha256 = S.sha256Hex(Buffer.from(body, "utf8"));
    assert.equal(bodySha256, v.expect.bodySha256, v.name);
    const canonical = S.canonicalString({ ...f, bodySha256 });
    assert.equal(canonical, v.expect.canonical, v.name);
    assert.equal(S.signCanonical(v.secret, canonical), v.expect.sig, v.name);
  }
});

test("canonicalization is unambiguous: length prefixes keep tenant=ab/idem='' apart from tenant=a/idem=b", () => {
  const a = V.vectors.find((v) => v.name.startsWith("length prefix A"));
  const b = V.vectors.find((v) => v.name.startsWith("length prefix B"));
  assert.notEqual(a.expect.canonical, b.expect.canonical);
  assert.notEqual(a.expect.sig, b.expect.sig);
  assert.match(a.expect.canonical, /^p5-svc-sig\/1\naud=15:account-service\n/);
  assert.match(S.canonicalString({ method: "post", target: "/x" }), /\nmethod=4:POST\n/);
});

test("parseKeyMap: current + next, drops short secrets, malformed kids and duplicates", () => {
  const m = S.parseKeyMap(`k1:${EV_SECRET}, k2:${EV_NEXT},bad kid:${EV_SECRET},k3:short,k1:${PR_SECRET},:${EV_SECRET}`);
  assert.deepEqual([...m.keys()], ["k1", "k2"]);
  assert.equal(m.get("k1"), EV_SECRET);
  assert.equal(S.parseKeyMap("").size, 0);
  assert.equal(S.keyMapEnvName("events-service"), "SVC_SIGNING_KEYS_EVENTS_SERVICE");
});

test("signaturesEqual always uses crypto.timingSafeEqual (equal and unequal lengths)", () => {
  const real = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...a) => { calls += 1; return real(...a); };
  try {
    assert.equal(S.signaturesEqual("abc", "abc"), true);
    assert.equal(S.signaturesEqual("abc", "abd"), false);
    assert.equal(S.signaturesEqual("abc", "abcd"), false);
    assert.equal(calls, 3);
  } finally {
    crypto.timingSafeEqual = real;
  }
});

test("valid events-service registration capture and profile-service application capture", connected(async () => {
  assert.equal((await evaluateServiceAuth(signedReq(), "capture", deps())).outcome, "valid");
  const r = signedReq({ caller: "profile-service", kid: "pr-1", secret: PR_SECRET, body: appBody(), idem: "application:capture:" + "d".repeat(24) + ":pi_1" });
  assert.equal((await evaluateServiceAuth(r, "capture", deps())).outcome, "valid");
}));

const TAMPER = [
  ["method", (r) => ({ ...r, method: "PUT" })],
  ["path", (r) => ({ ...r, originalUrl: "/api/payments/intents/pi_1/cancel" })],
  ["query added", (r) => ({ ...r, originalUrl: r.originalUrl + "?x=1" })],
  ["tenant header", (r) => ({ ...r, headers: { ...r.headers, "x-tenant-id": "f".repeat(24) } })],
  ["idempotency key", (r) => ({ ...r, headers: { ...r.headers, "idempotency-key": r.headers["idempotency-key"] + "x" } })],
  ["body content", (r) => ({ ...r, rawBody: Buffer.from(regBody({ reason: "reject" })) })],
  ["body whitespace only (raw bytes, not parsed JSON)", (r) => ({ ...r, rawBody: Buffer.from(r.rawBody.toString() + " ") })],
  ["timestamp", (r) => ({ ...r, headers: { ...r.headers, "x-svc-ts": String(NOW - 1) } })],
  ["nonce", (r) => ({ ...r, headers: { ...r.headers, "x-svc-nonce": r.headers["x-svc-nonce"].slice(1) + "A" } })],
  ["kid swapped to the caller's other valid key", (r) => ({ ...r, headers: { ...r.headers, "x-svc-kid": "ev-2" } })],
  ["signature", (r) => ({ ...r, headers: { ...r.headers, "x-svc-sig": "A" + r.headers["x-svc-sig"].slice(1) } })],
];
for (const [label, tamper] of TAMPER) {
  test(`tamper: ${label} -> SERVICE_AUTH_INVALID`, connected(async () => {
    const d = deps();
    const out = await evaluateServiceAuth(signedReq({}, tamper), "capture", d);
    assert.equal(out.outcome, "SERVICE_AUTH_INVALID");
    assert.equal(d.NonceModel.seen.size, 0, "an invalid signature never records its nonce");
  }));
}

test("audience: a signature made for another audience never verifies here", connected(async () => {
  const out = await evaluateServiceAuth(signedReq({ aud: "profile-service" }), "capture", deps());
  assert.equal(out.outcome, "SERVICE_AUTH_INVALID");
}));

test("skew: +/-61 s stale, +/-60 s accepted", connected(async () => {
  for (const [ts, want] of [[NOW - 61, "SERVICE_AUTH_STALE"], [NOW + 61, "SERVICE_AUTH_STALE"], [NOW - 60, "valid"], [NOW + 60, "valid"]]) {
    assert.equal((await evaluateServiceAuth(signedReq({ ts: String(ts) }), "capture", deps())).outcome, want, String(ts - NOW));
  }
}));

test("replay: the same nonce twice -> SERVICE_AUTH_REPLAY; a fresh nonce with the same business key is valid", connected(async () => {
  const d = deps();
  const r = signedReq({ nonce: "cmVwbGF5LW5vbmNlLTAwMDAwMDAx" });
  assert.equal((await evaluateServiceAuth(r, "capture", d)).outcome, "valid");
  assert.equal((await evaluateServiceAuth(r, "capture", d)).outcome, "SERVICE_AUTH_REPLAY");
  const retry = signedReq({ nonce: "cmVwbGF5LW5vbmNlLTAwMDAwMDAy" });
  assert.equal(retry.headers["idempotency-key"], r.headers["idempotency-key"]);
  assert.equal((await evaluateServiceAuth(retry, "capture", d)).outcome, "valid");
}));

test("replay store failure or disconnected store -> SERVICE_AUTH_STORE_UNAVAILABLE", async () => {
  const failing = { async create() { throw new Error("connection reset"); } };
  const out1 = await connected(() => evaluateServiceAuth(signedReq(), "capture", deps({ NonceModel: failing })))();
  assert.equal(out1.outcome, "SERVICE_AUTH_STORE_UNAVAILABLE");
  // readyState 0 (real, not connected in this unit test)
  const out2 = await evaluateServiceAuth(signedReq(), "capture", deps());
  assert.equal(out2.outcome, "SERVICE_AUTH_STORE_UNAVAILABLE");
});

test("allow-list: wrong caller for the domain / operation -> SERVICE_NOT_ALLOWED", connected(async () => {
  const pr = { caller: "profile-service", kid: "pr-1", secret: PR_SECRET };
  assert.equal((await evaluateServiceAuth(signedReq({ ...pr }), "capture", deps())).outcome, "SERVICE_NOT_ALLOWED", "profile on a registration");
  assert.equal((await evaluateServiceAuth(signedReq({ body: appBody() }), "capture", deps())).outcome, "SERVICE_NOT_ALLOWED", "events on an application");
  for (const op of ["manual_record", "manual_post", "manual_void"]) {
    assert.equal((await evaluateServiceAuth(signedReq({ ...pr }), op, deps())).outcome, "SERVICE_NOT_ALLOWED", `profile ${op}`);
    assert.equal((await evaluateServiceAuth(signedReq(), op, deps())).outcome, "valid", `events ${op}`);
  }
  assert.equal((await evaluateServiceAuth(signedReq({ body: JSON.stringify({ transition: "capture" }) }), "capture", deps())).outcome, "SERVICE_NOT_ALLOWED", "no domain");
}));

test("unknown caller / unconfigured caller / unknown kid / malformed headers / unsigned", connected(async () => {
  const notif = signedReq({ caller: "notification-service", kid: "n-1" });
  assert.equal((await evaluateServiceAuth(notif, "capture", deps({ env: env({ SVC_SIGNING_KEYS_NOTIFICATION_SERVICE: `n-1:${EV_SECRET}` }) }))).outcome, "SERVICE_AUTH_UNKNOWN_CALLER");
  assert.equal((await evaluateServiceAuth(signedReq(), "capture", deps({ env: {} }))).outcome, "SERVICE_AUTH_UNKNOWN_CALLER");
  assert.equal((await evaluateServiceAuth(signedReq({ kid: "ev-9" }), "capture", deps())).outcome, "SERVICE_AUTH_UNKNOWN_KID");
  assert.equal((await evaluateServiceAuth(signedReq({}, (r) => ({ ...r, headers: { ...r.headers, "x-svc-version": "2" } })), "capture", deps())).outcome, "SERVICE_AUTH_MALFORMED");
  assert.equal((await evaluateServiceAuth({ method: "POST", originalUrl: "/x", headers: {}, body: {} }, "capture", deps())).outcome, "SERVICE_AUTH_REQUIRED");
}));

test("rotation: current and next kid both verify; after the old kid is removed it is UNKNOWN_KID", connected(async () => {
  assert.equal((await evaluateServiceAuth(signedReq({ kid: "ev-1", secret: EV_SECRET }), "capture", deps())).outcome, "valid");
  assert.equal((await evaluateServiceAuth(signedReq({ kid: "ev-2", secret: EV_NEXT }), "capture", deps())).outcome, "valid");
  const after = deps({ env: env({ SVC_SIGNING_KEYS_EVENTS_SERVICE: `ev-2:${EV_NEXT}` }) });
  assert.equal((await evaluateServiceAuth(signedReq({ kid: "ev-1", secret: EV_SECRET }), "capture", after)).outcome, "SERVICE_AUTH_UNKNOWN_KID");
}));

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function captureLogger() {
  const lines = [];
  const rec = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return { lines, info: rec("info"), warn: rec("warn"), error: rec("error") };
}

async function runMiddleware(mode, req, over = {}) {
  const prev = process.env.PAYMENT_SERVICE_AUTH_MODE;
  if (mode == null) delete process.env.PAYMENT_SERVICE_AUTH_MODE; else process.env.PAYMENT_SERVICE_AUTH_MODE = mode;
  const log = captureLogger();
  const mw = createServiceAuthVerifier("capture", { ...deps(), logger: log, ...over });
  const res = fakeRes();
  let nexted = false;
  try {
    await connected(() => mw(req, res, () => { nexted = true; }))();
  } finally {
    if (prev == null) delete process.env.PAYMENT_SERVICE_AUTH_MODE; else process.env.PAYMENT_SERVICE_AUTH_MODE = prev;
  }
  return { res, nexted, log };
}

test("mode off (default): not evaluated, always next(), nothing logged", async () => {
  const bad = signedReq({}, (r) => ({ ...r, headers: { ...r.headers, "x-svc-sig": "A".repeat(43) } }));
  const { nexted, log } = await runMiddleware(null, bad);
  assert.equal(nexted, true);
  assert.equal(log.lines.length, 0);
});

test("mode report: never rejects (invalid, replay, unsigned, store down) and logs outcome codes only", async () => {
  const cases = [
    signedReq({}, (r) => ({ ...r, headers: { ...r.headers, "x-svc-sig": "A".repeat(43) } })),
    { method: "POST", originalUrl: "/x", headers: { "x-internal-request": "true" }, body: {} },
  ];
  for (const req of cases) {
    const { nexted, res, log } = await runMiddleware("report", req);
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 200);
    assert.equal(log.lines.length, 1);
  }
  const down = await runMiddleware("report", signedReq(), { NonceModel: { async create() { throw new Error("down"); } } });
  assert.equal(down.nexted, true);
  assert.equal(down.log.lines[0].meta.outcome, "SERVICE_AUTH_STORE_UNAVAILABLE");
});

test("mode enforce: valid passes with req.serviceCaller; each failure maps to its status and does not reach next()", async () => {
  const ok = signedReq();
  const v = await runMiddleware("enforce", ok);
  assert.equal(v.nexted, true);
  assert.deepEqual(ok.serviceCaller, { caller: "events-service", kid: "ev-1" });
  const want = [
    [signedReq({}, (r) => ({ ...r, rawBody: Buffer.from("{}") })), 401, "SERVICE_AUTH_INVALID"],
    [signedReq({ ts: String(NOW - 120) }), 401, "SERVICE_AUTH_STALE"],
    [signedReq({ caller: "profile-service", kid: "pr-1", secret: PR_SECRET }), 403, "SERVICE_NOT_ALLOWED"],
    [{ method: "POST", originalUrl: "/x", headers: { "x-internal-request": "true" }, body: {} }, 401, "SERVICE_AUTH_REQUIRED"],
  ];
  for (const [req, status, code] of want) {
    const r = await runMiddleware("enforce", req);
    assert.equal(r.nexted, false, code);
    assert.equal(r.res.statusCode, status, code);
    assert.equal(r.res.body.code, code);
  }
  const d = deps();
  const once = signedReq({ nonce: "ZW5mb3JjZS1yZXBsYXktMDAwMDAx" });
  await runMiddleware("enforce", once, { NonceModel: d.NonceModel });
  const again = await runMiddleware("enforce", once, { NonceModel: d.NonceModel });
  assert.equal(again.res.statusCode, 409);
  assert.equal(again.res.body.code, "SERVICE_AUTH_REPLAY");
  const down = await runMiddleware("enforce", signedReq(), { NonceModel: { async create() { throw new Error("down"); } } });
  assert.equal(down.res.statusCode, 503);
  assert.equal(down.res.body.code, "SERVICE_AUTH_STORE_UNAVAILABLE");
  // An unsigned USER-path request (no x-internal-request) is left to the existing chain here.
  const user = await runMiddleware("enforce", { method: "POST", originalUrl: "/x", headers: { authorization: "Bearer x" }, body: {} });
  assert.equal(user.nexted, true);
});

test("log redaction: no secret, signature, nonce, body or header values in any log line", async () => {
  const req = signedReq({ nonce: "cmVkYWN0aW9uLW5vbmNlLTAwMDAx" });
  const sig = req.headers["x-svc-sig"];
  const all = [];
  for (const mode of ["report", "enforce"]) {
    all.push(...(await runMiddleware(mode, req)).log.lines);
    all.push(...(await runMiddleware(mode, signedReq({}, (r) => ({ ...r, headers: { ...r.headers, "x-svc-sig": "B".repeat(43) } })))).log.lines);
  }
  const text = JSON.stringify(all);
  for (const forbidden of [EV_SECRET, EV_NEXT, PR_SECRET, sig, "B".repeat(43), "cmVkYWN0aW9uLW5vbmNlLTAwMDAx", "registrationId", "actorUserId", T]) {
    assert.ok(!text.includes(forbidden), `log must not contain ${forbidden.slice(0, 12)}...`);
  }
  for (const l of all) assert.deepEqual(Object.keys(l.meta).sort(), ["caller", "internalPath", "kid", "mode", "operation", "outcome"]);
});
