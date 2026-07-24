# Environment variables

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` / `MONGO_URI` | MongoDB connection string |
| `RABBIT_URL` / `RABBITMQ_URL` | RabbitMQ connection URL (optional — service starts without it) |
| `JWT_SECRET` / `ACCESS_TOKEN_SECRET` | Secret for legacy `Authorization: Bearer` JWT verification |
| `POLICY_SERVICE_URL` | RBAC policy-service base URL used by `defaultPolicyMiddleware` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe API + webhook signature verification |
| `PORTAL_BASE_URL` | Base URL for Stripe checkout success/cancel redirects |
| `PROFILE_SERVICE_URL`, `SUBSCRIPTION_SERVICE_URL` | Upstream service URLs for `profileUpstream.client.js` etc. |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONTAINER` | Azure Blob storage for `azure.blob.service.js` |
| `MONGODB_MAX_POOL_SIZE` / `MONGODB_MIN_POOL_SIZE` / `MONGODB_MAX_IDLE_TIME_MS` | Mongo pool sizing (defaults: 150 / 20 / 30000) |
| `GLOBAL_DB_OPERATIONS_LIMIT` | Global p-limit concurrency (default: 120, see `background-jobs.md`) |
| `APPLICATION_EVENTS_PREFETCH` / `MEMBERSHIP_EVENTS_PREFETCH` | RabbitMQ prefetch (default: 50 each) |
| `TRUST_PROXY` | Set to `"0"` to disable `trust proxy` (enabled by default for Azure/reverse-proxy deployments) |

Uses `dotenv-flow` — create `.env.development`, `.env.staging`, `.env.production` per environment;
each is loaded automatically based on `NODE_ENV`.

## Shared packages (GitHub dependencies)

- `@membership/policy-middleware` — `kashif147/policy-middleware#gateway`
- `@membership/shared-constants` — `kashif147/membership-shared-constants#v1.0.0`
- `@projectShell/logging-lib` — `kashif147/logging-lib#main`
- `@projectShell/rabbitmq-middleware` — `kashif147/rabbitmq-middleware#main`

After changing any of these in `package.json`, run `npm install` to re-fetch from GitHub — a version
bump alone in `package.json` without reinstalling leaves the old code in `node_modules`.
