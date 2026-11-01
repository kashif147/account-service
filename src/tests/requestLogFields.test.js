// The per-request log never carries headers (bearer tokens, Stripe signature, identity), query or body.
// Run: node --test src/tests/requestLogFields.test.js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { Writable } from "node:stream";
import pino from "pino";
import pinoHttp from "pino-http";
import { safeRequestLogFields, safeResponseLogFields } from "../helpers/requestLogFields.js";

const SECRETS = ["Bearer eyJhbGciOiJIUzI1NiJ9.SECRETPAYLOAD.SIG", "t=1793487888,v1=deadbeefsignature", "someone@example.org", "SESSIONCOOKIE", "QUERYSECRET"];

test("serializers keep only id, method, path (no query), remoteAddress and status", () => {
  assert.deepEqual(
    safeRequestLogFields({ id: 7, method: "POST", url: "/api/webhook/stripe?x=QUERYSECRET", remoteAddress: "10.0.0.1", headers: { authorization: SECRETS[0] }, query: { x: 1 }, params: { a: 1 } }),
    { id: 7, method: "POST", path: "/api/webhook/stripe", remoteAddress: "10.0.0.1" },
  );
  assert.deepEqual(safeResponseLogFields({ statusCode: 200, headers: { "set-cookie": "SESSIONCOOKIE" } }), { statusCode: 200 });
});

test("a real pino-http request log with these serializers contains none of the sensitive values", async () => {
  const lines = [];
  const sink = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  const mw = pinoHttp({ logger: pino(sink), serializers: { req: safeRequestLogFields, res: safeResponseLogFields } });
  const { EventEmitter } = await import("node:events");
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url: "/api/webhook/stripe?x=QUERYSECRET", socket: { remoteAddress: "10.0.0.1" }, connection: { remoteAddress: "10.0.0.1" },
    headers: { authorization: SECRETS[0], "stripe-signature": SECRETS[1], "x-user-email": SECRETS[2], cookie: SECRETS[3] },
  });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, getHeaders: () => ({ "set-cookie": SECRETS[3] }), setHeader() {}, getHeader() {} });
  mw(req, res, () => {});
  res.emit("finish");
  await new Promise((r) => setImmediate(r));
  const out = lines.join("");
  assert.match(out, /request (completed|aborted)/); // the fake response lacks writableEnded; the fields are what matter
  assert.match(out, /"path":"\/api\/webhook\/stripe"/);
  for (const s of SECRETS) assert.ok(!out.includes(s), `logged: ${s.slice(0, 12)}`);
  assert.ok(!/"headers"/.test(out));
});

test("app.js wires the safe serializers into pino-http", () => {
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /serializers: \{ req: safeRequestLogFields, res: safeResponseLogFields \}/);
});
