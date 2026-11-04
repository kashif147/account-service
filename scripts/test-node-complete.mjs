#!/usr/bin/env node
// Runs the node:test suite (every src/tests file that imports "node:test") WITHOUT
// --test-force-exit, and fails unless every test that ran was also reported.
//
//   npm run test:node                         # whole node:test suite
//   npm run test:node -- src/tests/x.test.js  # selected files
//   node scripts/test-node-complete.mjs --analyze <runDir>   # re-check a kept run directory
//
// Why not --test-force-exit: it makes each test child call process.exit() as soon as its last
// test ends. On macOS stdout to a pipe is asynchronous, so results still queued behind a chatty
// file's logs were dropped and the run still exited 0 with tests silently missing. Here children
// exit naturally (scripts/test/node-test-setup.mjs stops the app-level timers/connections that
// used to keep them alive), so every queued write is flushed before exit.
//
// Completeness evidence, independent of the exit code:
//   - ledger  (written synchronously inside each test child by node-test-setup.mjs):
//             every test start/end and a per-file "done" marker;
//   - events  (written by the parent through node-test-events-reporter.mjs to a file):
//             every result the parent actually received.
// The run FAILS (exit 2) if any discovered file has no ledger or no done marker, if any test
// started but did not end, if any ended test is missing from the reported results, if any test
// was cancelled, if a teardown step failed, or if the wall-clock limit was hit. Test failures
// alone exit 1.
//
// Env: NODE_TEST_TIMEOUT_MS  per-test timeout (default 120000; the slowest test is ~17s under
//                            full-suite load, most are <8s)
//      NODE_TEST_WALL_MS     whole-run wall-clock limit (default 900000); on expiry the run's
//                            process group is killed and the run fails
//      NODE_TEST_RUN_DIR     keep ledger/events/summary here (default: a fresh temp dir)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = path.join(ROOT, "scripts/test/node-test-setup.mjs");
const REPORTER = path.join(ROOT, "scripts/test/node-test-events-reporter.mjs");
const NODE_TEST_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)["']node:test["']/;

export function discoverNodeTestFiles(dir = path.join(ROOT, "src/tests")) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...discoverNodeTestFiles(p));
    else if (/\.test\.(?:js|mjs|cjs)$/.test(ent.name) && NODE_TEST_IMPORT.test(fs.readFileSync(p, "utf8"))) out.push(p);
  }
  return out.sort();
}

const readJsonl = (p) =>
  fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return { k: "corrupt", raw: l.slice(0, 200) }; }
      })
    : [];

const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

export function analyze(runDir, files, run = {}) {
  const ledgerDir = path.join(runDir, "ledger");
  const ledger = fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readJsonl(path.join(ledgerDir, f)))
    : [];
  const events = readJsonl(path.join(runDir, "events.jsonl"));
  const per = new Map();
  const key = (loc, name) => `${loc}\0${name}`;
  const get = (file) => {
    if (!per.has(file)) per.set(file, { loads: 0, started: new Map(), ended: new Map(), done: [], pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0, reportedTests: 0 });
    return per.get(file);
  };
  for (const f of files) get(f);
  for (const r of ledger) {
    if (!r.file) continue;
    const s = get(r.file);
    if (r.k === "load") s.loads++;
    else if (r.k === "start") bump(s.started, key(r.file, r.name));
    else if (r.k === "end") bump(s.ended, key(r.file, r.name));
    else if (r.k === "done") s.done.push(r);
  }
  // Reported results are pooled by (file, name). A test declared inside a shared helper module
  // (e.g. src/tests/helpers/*.cjs) is reported with the helper's path, while the ledger records it
  // under the entry file that ran it, so those go to a by-name pool used as a fallback.
  const reportedPool = new Map();
  const helperPool = new Map();
  for (const e of events) {
    if (!e.file || e.suite) continue;
    if (!files.includes(e.file) && !per.has(e.file)) {
      bump(helperPool, e.name);
      continue;
    }
    bump(reportedPool, key(e.file, e.name));
    const s = get(e.file);
    s.reportedTests++;
    if (e.failureType === "cancelledByParent" || e.failureType === "testTimeoutFailure") s.cancelled++;
    else if (e.skip) s.skip++;
    else if (e.todo) s.todo++;
    else if (e.k === "pass") s.pass++;
    else s.fail++;
  }

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const rows = [];
  const problems = [];
  const totals = { files: files.length, discovered: 0, completed: 0, reported: 0, matched: 0, pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0, missing: 0 };
  for (const [file, s] of [...per.entries()].sort()) {
    const rel = path.relative(ROOT, file);
    const started = sum(s.started);
    const completed = sum(s.ended);
    const missing = [];
    let matched = 0;
    for (const [k, n] of s.ended) {
      const name = k.split("\0")[1];
      const avail = reportedPool.get(k) || 0;
      const got = Math.min(n, avail);
      reportedPool.set(k, avail - got);
      const helperAvail = helperPool.get(name) || 0;
      const viaHelper = Math.min(n - got, helperAvail);
      helperPool.set(name, helperAvail - viaHelper);
      s.reportedTests += viaHelper;
      matched += got + viaHelper;
      for (let i = got + viaHelper; i < n; i++) missing.push(name);
    }
    const fileProblems = [];
    if (s.loads === 0) fileProblems.push("no ledger: the test child never loaded the setup preload");
    if (s.loads > 1) fileProblems.push(`loaded ${s.loads} times`);
    if (s.loads > 0 && s.done.length === 0) fileProblems.push("no done marker: crashed, killed or exited before its root after hook");
    if (started > completed) fileProblems.push(`${started - completed} test(s) started but never ended`);
    if (missing.length) fileProblems.push(`${missing.length} test(s) ran but were not reported: ${missing.slice(0, 8).map((n) => JSON.stringify(n)).join(", ")}${missing.length > 8 ? ", ..." : ""}`);
    if (s.cancelled) fileProblems.push(`${s.cancelled} test(s) cancelled`);
    for (const d of s.done) for (const te of d.teardownErrors || []) fileProblems.push(`teardown failed: ${te}`);
    if (s.loads > 0 && started === 0 && s.reportedTests === 0) fileProblems.push("no tests ran");
    rows.push({ file: rel, started, completed, reported: s.reportedTests, matched, pass: s.pass, fail: s.fail, skip: s.skip, cancelled: s.cancelled, missing, problems: fileProblems });
    for (const p of fileProblems) problems.push(`${rel}: ${p}`);
    totals.discovered += started;
    totals.completed += completed;
    totals.reported += s.reportedTests;
    totals.matched += matched;
    totals.pass += s.pass;
    totals.fail += s.fail;
    totals.skip += s.skip;
    totals.todo += s.todo;
    totals.cancelled += s.cancelled;
    totals.missing += missing.length;
  }
  // Outcome totals over every reported result (helper-declared tests included).
  for (const f of ["pass", "fail", "skip", "todo", "cancelled"]) totals[f] = 0;
  for (const e of events) {
    if (!e.file || e.suite) continue;
    if (e.failureType === "cancelledByParent" || e.failureType === "testTimeoutFailure") totals.cancelled++;
    else if (e.skip) totals.skip++;
    else if (e.todo) totals.todo++;
    else if (e.k === "pass") totals.pass++;
    else totals.fail++;
  }
  if (totals.cancelled && !problems.some((p) => p.includes("cancelled"))) problems.push(`${totals.cancelled} test(s) cancelled`);
  if (run.timedOut) problems.push(`wall-clock limit hit after ${run.wallMs}ms; run killed (a test child kept running: an open handle after its tests ended, or a hung hook)`);
  if (totals.matched < totals.discovered) problems.push(`reported ${totals.matched} of ${totals.discovered} tests that started`);
  const complete = problems.length === 0;
  const summary = { complete, totals, run, problems, rows };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

function printSummary(s, runDir) {
  const t = s.totals;
  const lines = [
    "",
    "== node:test completeness ==",
    `files ${t.files}  started ${t.discovered}  ended ${t.completed}  reported ${t.reported}  matched ${t.matched}  missing ${t.missing}`,
    `pass ${t.pass}  fail ${t.fail}  skipped ${t.skip}  todo ${t.todo}  cancelled ${t.cancelled}  runner exit ${s.run.exitCode ?? "-"}${s.run.signal ? ` (${s.run.signal})` : ""}`,
  ];
  if (s.problems.length) lines.push("INCOMPLETE:", ...s.problems.map((p) => `  - ${p}`));
  lines.push(`verdict: ${!s.complete ? "INCOMPLETE" : t.fail || s.run.exitCode ? "FAIL" : "PASS"}  (details: ${path.join(runDir, "summary.json")})`, "");
  process.stdout.write(lines.join("\n"));
}

async function main(argv) {
  if (argv[0] === "--analyze") {
    const runDir = path.resolve(argv[1]);
    const meta = fs.existsSync(path.join(runDir, "run.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) : {};
    const s = analyze(runDir, meta.files || discoverNodeTestFiles(), meta.run || {});
    printSummary(s, runDir);
    return s.complete ? (s.totals.fail ? 1 : 0) : 2;
  }

  const files = argv.length ? argv.map((f) => path.resolve(f)) : discoverNodeTestFiles();
  const timeoutMs = Number(process.env.NODE_TEST_TIMEOUT_MS) || 120000;
  const wallMs = Number(process.env.NODE_TEST_WALL_MS) || 900000;
  const runDir = process.env.NODE_TEST_RUN_DIR
    ? path.resolve(process.env.NODE_TEST_RUN_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), "account-node-test-"));
  fs.mkdirSync(path.join(runDir, "ledger"), { recursive: true });

  const args = [
    "--import", SETUP,
    "--test",
    `--test-timeout=${timeoutMs}`,
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${path.join(runDir, "events.jsonl")}`,
    ...files,
  ];
  const t0 = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    detached: true, // own process group, so a wall-clock kill also takes the test children and their mongods
    env: { ...process.env, NODE_TEST_LEDGER_DIR: path.join(runDir, "ledger") },
  });
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
  let timedOut = false;
  const wall = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, wallMs);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 5000).unref(); });
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, s) => resolve({ code: c, signal: s })));
  clearTimeout(wall);
  const run = { exitCode: code, signal, timedOut, wallMs, timeoutMs, durationMs: Date.now() - t0 };
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ files, run }, null, 2));
  const s = analyze(runDir, files, run);
  printSummary(s, runDir);
  if (!s.complete) return 2;
  return s.totals.fail || code !== 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
