# Database concurrency and background cron jobs

## Concurrency limiter

`src/config/globalLimiter.js` exports a `p-limit` instance (`globalDBLimiter`) shared across all DB
operations — default 120 concurrent ops (80% of the 150-connection MongoDB pool,
`GLOBAL_DB_OPERATIONS_LIMIT` env var to override). Wrap any heavy DB operation in `withGlobalLimit(fn)`
rather than calling it unguarded — this matters most for batch operations (application approvals up
to 500, payment batch processing up to 5000), where an unwrapped loop can exhaust the pool.

## Cron jobs

Started on app boot in `src/app.js`, stopped on `SIGTERM`/`SIGINT`:

- `batch.processing.cron.service.js` — processes queued batch payment/membership-status jobs
  (`batch.process.job.service.js`, `batch.payment.process.service.js`,
  `batch.membershipStatus.service.js`).
- `directDebitPrepare.cron.service.js` — prepares eligible SEPA Direct Debit runs
  (`directDebitEligibility.service.js`).

Both are in-process `setTimeout`-style loops with no leader election — if this service ever runs as
more than one instance, both jobs would run redundantly on every instance rather than coordinating.
