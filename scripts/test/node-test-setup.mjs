// Shared preload for the node:test suite (loaded with --import by scripts/test-node-complete.mjs).
//
// It replaces --test-force-exit. Force-exit called process.exit() in each test child as soon as
// its last test ended; on macOS stdout to a pipe is asynchronous, so result messages still queued
// behind a chatty file's logs were discarded and tests vanished with exit code 0. Without
// force-exit a child exits naturally once its event loop is empty, which only happens after every
// queued write has been flushed. This file makes that natural exit possible and records evidence:
//
// 1. Teardown (NODE_TEST_TEARDOWN != "0"): stops the app-level resources that otherwise keep a
//    child alive after its tests finish. Each is stopped only if its module was actually loaded
//    by the test file, so files that never import the app are not affected:
//      - src/services/batch.processing.cron.service.js   setInterval started by src/app.js import
//      - src/services/directDebitPrepare.cron.service.js setInterval started by src/app.js import
//      - @projectShell/rabbitmq-middleware (ESM)          connection opened lazily by a publish
//        (reconnect is disabled first: the middleware schedules a reconnect on every close)
//
// 2. Ledger (NODE_TEST_LEDGER_DIR set): synchronously appends one JSON line per test start/end
//    and a final "done" line per file, written in the child itself. Synchronous writes survive
//    any process.exit, so the ledger is the record of what actually ran, independent of what
//    reached the parent reporter.
//
// 3. RabbitMQ isolation (always on; see scripts/test/rabbit-test-target.mjs):
//    - refuses to load (the file fails before any test) if RABBIT_URL / RABBITMQ_URL is not a
//      loopback amqp(s) URL; pins RABBIT_URL to a closed loopback port when neither is set;
//    - blocks connectionManager.connect() on both the ESM and CJS middleware instances, so no
//      code path (publish, publishConfirmed, consumers) can open a broker connection;
//    - installs the suite's existing no-op stub as the default `publisher.publish`
//      ({ success: true, eventId: "test" }). Files that assert on publishing already replace it
//      with their own recorder at import, after this preload, so theirs wins.
//
// Inert in the `node --test` parent process (which inherits --import): NODE_TEST_CONTEXT is only
// set in test children.
import { createRequire, registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { PINNED_TEST_RABBIT_URL, RABBIT_URL_VARS, rabbitEnvMessage, rabbitEnvProblems } from "./rabbit-test-target.mjs";

if (process.env.NODE_TEST_CONTEXT) {
  const { after, beforeEach, afterEach } = await import("node:test");

  const loaded = new Set();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context);
      loaded.add(r.url);
      return r;
    },
  });

  const ledgerDir = process.env.NODE_TEST_LEDGER_DIR;
  const file = process.argv[1];
  const ledger = ledgerDir ? path.join(ledgerDir, `${process.pid}.jsonl`) : null;
  const write = (rec) => {
    if (ledger) appendFileSync(ledger, JSON.stringify({ file, ...rec }) + "\n");
  };
  let started = 0;
  let completed = 0;

  write({ k: "load" });
  beforeEach((t) => {
    started++;
    write({ k: "start", name: t.name });
  });
  afterEach((t) => {
    completed++;
    write({ k: "end", name: t.name });
  });

  const srcUrl = (rel) => new URL(`../../src/${rel}`, import.meta.url).href;
  const BATCH_CRON = srcUrl("services/batch.processing.cron.service.js");
  const DD_CRON = srcUrl("services/directDebitPrepare.cron.service.js");
  let RABBIT_ESM = null;
  try {
    RABBIT_ESM = import.meta.resolve("@projectShell/rabbitmq-middleware");
  } catch {
    /* not installed: nothing to close */
  }

  const rabbitProblems = rabbitEnvProblems(process.env);
  if (rabbitProblems.length) throw new Error(rabbitEnvMessage(rabbitProblems));
  if (!RABBIT_URL_VARS.some((n) => process.env[n])) process.env.RABBIT_URL = PINNED_TEST_RABBIT_URL;
  const isolate = (m) => {
    if (!m?.connectionManager || !m?.publisher) return;
    m.connectionManager.maxReconnectAttempts = 0;
    m.connectionManager.connect = async () => {
      throw new Error("RabbitMQ is disabled in the account-service node:test suite (scripts/test/node-test-setup.mjs)");
    };
    m.publisher.publish = async () => ({ success: true, eventId: "test" });
  };
  if (RABBIT_ESM) isolate(await import(RABBIT_ESM));
  try {
    isolate(createRequire(import.meta.url)("@projectShell/rabbitmq-middleware"));
  } catch {
    /* CJS entry not installed */
  }

  after(async () => {
    const teardownErrors = [];
    if (process.env.NODE_TEST_TEARDOWN !== "0") {
      const step = async (name, fn) => {
        try {
          await fn();
        } catch (err) {
          teardownErrors.push(`${name}: ${err?.message || err}`);
        }
      };
      if (loaded.has(BATCH_CRON)) {
        await step("batchCron", async () => (await import(BATCH_CRON)).stopBatchProcessingCron());
      }
      if (loaded.has(DD_CRON)) {
        await step("ddPrepareCron", async () => (await import(DD_CRON)).stopDirectDebitPrepareCron());
      }
      if (RABBIT_ESM && loaded.has(RABBIT_ESM)) {
        await step("rabbitmq", async () => {
          const m = await import(RABBIT_ESM);
          if (m.connectionManager) m.connectionManager.maxReconnectAttempts = 0;
          if (m.connectionManager?.connection) await m.shutdown();
        });
      }
    }
    write({ k: "done", started, completed, teardownErrors });
  });
}
