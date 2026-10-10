// Phase 2B0 — POST /test/publish-event is removed.
//
// It was mounted outside /api with no authentication and no NODE_ENV gate, and published any
// caller-chosen eventType with caller-chosen data and metadata (including tenantId) to RabbitMQ
// (e.g. applications.review.processed.v1 promotes a user to Member). Reachable on the published
// service port. No replacement; the normal publisher (src/rabbitMQ/events.js) is unchanged.
//
// account-service is ESM and jest@25 here is unreliable, so this runs under node:test:
//   node --test --test-force-exit src/tests/testPublishEventRemoved.test.js
// Imports the real app (src/app.js does not connect to Mongo or RabbitMQ; bin/ does). It does
// start the batch/direct-debit cron timers at import, so --test-force-exit is required or the
// run never exits.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "as-testpublish-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { default: app } = await import("../app.js");

async function withServer(fn) {
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("A POST /test/publish-event returns 404 and publishes nothing (even with tenant metadata)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/test/publish-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "applications.review.processed.v1",
        data: { applicationId: "a1", applicationStatus: "APPROVED" },
        metadata: { tenantId: "tenant-B" },
      }),
    });
    assert.strictEqual(res.status, 404);
    const body = await res.text();
    assert.doesNotMatch(body, /"published"/);
  });
});

test("B no route for /test/publish-event remains on the app router", () => {
  const stack = app._router?.stack || app.router?.stack || [];
  const paths = stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.length > 0, "expected app-level routes to be inspectable");
  assert.ok(!paths.includes("/test/publish-event"));
});

test("C app.js no longer contains a caller-driven publishDomainEvent; the normal publisher is intact", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.doesNotMatch(src, /\/test\/publish-event/);
  assert.doesNotMatch(src, /test-endpoint/);
  assert.doesNotMatch(src, /req\.body[\s\S]{0,200}publishDomainEvent\(eventType/);

  const events = await import("../rabbitMQ/events.js");
  assert.strictEqual(typeof events.publishDomainEvent, "function");
});

test("D unrelated app-level routes are unchanged", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.strictEqual(health.status, 200);
    const root = await fetch(`${base}/`);
    assert.strictEqual(root.status, 200);
  });
});
