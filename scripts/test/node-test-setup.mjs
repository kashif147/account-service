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
// Inert in the `node --test` parent process (which inherits --import): NODE_TEST_CONTEXT is only
// set in test children.
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
import path from "node:path";

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
