# CLAUDE.md

## What this service is

`account-service` owns finance/GL for the platform: double-entry accounting, Stripe payments, SEPA
Direct Debit, credit notes, reconciliation, and batch payment processing. Runtime is Node.js ES
modules (`"type": "module"` — all imports need `.js` extensions). Entry point: `bin/account-service.js`
→ `src/app.js`, which sets up Express and also starts the batch-processing and direct-debit-prepare
cron jobs at module load time, wiring `SIGTERM`/`SIGINT` to stop them and shut down the event system.

The two things most worth knowing before making a change: the request pipeline mounts the Stripe
webhook route *before* the JSON body parser to preserve the raw signature buffer (see
`request-pipeline.md`), and there's no single global auth middleware for `/api/*` — identity and
authorization are two separate layers applied per-route (see `auth-and-authorization.md`).

## Commands

```bash
# Development
npm run dev              # nodemon with auto-reload on src/ and bin/ changes
npm run start:dev        # NODE_ENV=development (no auto-reload)
npm run start:staging    # NODE_ENV=staging

# Testing
npm run unittest         # Run all Jest tests (requires --experimental-vm-modules)
npm run unittest -- --testPathPattern=payments  # Run a single test file by pattern
npm run test:node        # Run every node:test file, with the completeness check (see below)
npm run test:node -- src/tests/payerBinding.p5.test.mjs   # selected node:test files
npm run test:rabbitmq    # Manual RabbitMQ event testing via scripts/

# Data / maintenance scripts (see scripts/)
node scripts/rebuild-materialized-balances.js --tenant <id> [--apply]   # per tenant, dry-run by default
node scripts/provision-tenant-coa.js --tenant=<id> [--apply]           # clone CoA template for a tenant
node scripts/migrations/ledger-tenancy.js [--report|--backfill|--create-indexes|--drop-legacy-indexes] [--apply]
node scripts/migrate-money-to-cents.js
node scripts/relink-refund-gl-for-application.js
node scripts/seed-events-income-coa.js / seed-cpd-events-income-coa.js --tenant=<id>

# Production
npm start                # node bin/account-service.js
```

Tests live in `src/tests/` and match `**/*.test.js`. Some files use Node's built-in runner
(`import test from "node:test"`: `phase2bStream2.*`, `tenantContext.adoption`,
`testPublishEventRemoved`, `ledgerTenancy`, and the P5 route matrix
`portalObjectAuthz.p5.http.test.mjs` and the payer-binding matrix `payerBinding.p5.test.mjs`, the attempts listing `paymentAttempts.p5.test.mjs` —
`.mjs` so jest's `*.test.js` match skips them) and must be run with
`npm run test:node [-- <file>...]` (jest cannot load them); the rest are jest.
That runner (`scripts/test-node-complete.mjs`) does **not** use `--test-force-exit`: force-exit made
each test child `process.exit()` as soon as its last test ended, and on macOS the results still
queued in the stdout pipe behind a chatty file's logs were dropped, so tests vanished with exit 0.
Instead the shared preload `scripts/test/node-test-setup.mjs` stops what `src/app.js` starts at
import (the batch and direct-debit-prepare cron intervals) and closes a lazily opened
rabbitmq-middleware connection, so children exit naturally. It also writes a per-test ledger from
inside each child, which the runner compares with what the parent actually reported: any test that
ran but was not reported, any cancelled test, any file without its done marker, or a wall-clock
overrun fails the run (exit 2) even if `node --test` exited 0. A bare `node --test <file>` of an
app-importing file (without the preload or force-exit) hangs after its tests on those cron
intervals; use the npm script. The node:test suite never contacts a broker. The runner refuses to start (exit 2) if `RABBIT_URL` or
`RABBITMQ_URL` is set to anything other than a loopback amqp(s) URL. When both are unset it pins
`RABBIT_URL` to a closed loopback port, so the middleware's `amqp://localhost:5672` default is never
used. The preload also blocks the middleware's `connect()` on the ESM and CJS instances and sets
`publisher.publish` to the suite's usual no-op stub. A file that asserts on publishing installs its
own recorder, which replaces that stub (see `scripts/test/rabbit-test-target.mjs`). If a new
test leaves another handle open, close it in that test's `after` (or add it to the preload) —
don't bring back `--test-force-exit`. The per-file header comments still saying
`node --test --test-force-exit` predate this runner.
`ledgerTenancy.test.js` is the GL Tenant A/B suite: it starts a throwaway `mongod` from PATH
(or uses `LEDGER_TEST_MONGO_URI`) and skips when neither is available. There is no lint script configured despite
`eslint` being a devDependency — don't assume `npm run lint` exists.

**Jest config is `jest.config.cjs`, not `.js`** — it must stay CommonJS. This service is
`"type": "module"`, and the installed `jest@25.5.4` crashes at startup
(`TypeError: Cannot add property rootDir, object is not extensible` in `jest-config`) if the
config file is `jest.config.js` and gets loaded as an ES module. Renaming it to `.cjs` fixes that
specific crash — don't rename it back to `.js`.

**15 of 20 test suites still fail even with that fix**, all with the same shape:
`ENOENT: no such file or directory, open 'fs'` (or `'async_hooks'`, etc.) from inside a
dependency's own `require("node:fs")` call (seen via `mongoose` and, transitively, `supertest` →
`superagent` → `formidable`). This jest version's module resolver (`jest-resolve@25.5.1`, an
exact version `jest@25.5.4` itself depends on — not a stray/mismatched install) doesn't handle
the `node:`-scheme prefix for core modules under `--experimental-vm-modules`. A `moduleNameMapper`
entry mapping `^node:(.*)$` → `$1` was tried and confirmed to make **no difference** (identical
15-failed/5-passed result with or without it) — don't re-attempt that as a fix. The 5 suites that
don't import `mongoose` or `supertest` (24 tests) run and pass fine. A real fix needs either a
Jest major-version upgrade (bigger, riskier change — get sign-off first, this touches every test
file) or pinning `supertest`/`mongoose` to versions old enough to avoid `node:`-prefixed
`require()` calls (fragile, moving target). Not attempted in this session.

## Request pipeline and route structure
@.claude/rules/request-pipeline.md

## Authentication / authorization
@.claude/rules/auth-and-authorization.md

## Idempotency
@.claude/rules/idempotency.md

## RabbitMQ / Event system
@.claude/rules/rabbitmq-events.md

## Database concurrency and background cron jobs
@.claude/rules/background-jobs.md

## Finance domain (GL, SEPA Direct Debit, reconciliation, key models)
@.claude/rules/finance-domain.md

## Environment variables and shared packages
@.claude/rules/environment-variables.md

## Related skills

Check for a matching skill before implementing from scratch: `membership-finance-processing`
(finance policy/refactor rules), `aib-sepa-pain-files` (SEPA PAIN.008/PAIN.002),
`cross-service-auth` (forwarding JWT/gateway headers instead of API keys), `no-cross-db-mongo`
(never connect to another service's MongoDB directly — use its HTTP API).
