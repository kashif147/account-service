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
npm run test:rabbitmq    # Manual RabbitMQ event testing via scripts/

# Data / maintenance scripts (see scripts/)
node scripts/rebuild-materialized-balances.js
node scripts/migrate-money-to-cents.js
node scripts/relink-refund-gl-for-application.js
node scripts/seed-events-income-coa.js / seed-cpd-events-income-coa.js
node scripts/seed-grid-system-default-template.js

# Production
npm start                # node bin/account-service.js
```

Tests live in `src/tests/` and match `**/*.test.js`. There is no lint script configured despite
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
