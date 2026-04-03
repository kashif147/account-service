# Batch details (BatchDetail)

Batch detail APIs and background processing live in **account-service** (moved from profile-service).

## HTTP (via gateway)

- `POST /account-service/api/batch-details` — multipart create (or legacy `POST /profile-service/api/batch-details` → proxied to account-service)
- `POST /account-service/api/create-batch` — alias (or legacy `/profile-service/api/create-batch`)
- `GET /account-service/api/batch-details`, `GET .../:id`, resolve-exception, add-profile, process — same paths under `/account-service/api/batch-details/...`

## Data migration

If `batchdetails` still lives in the profile-service database, copy that collection into the account-service Mongo database (same `_id` values) before cutover, or point `MONGODB_URI` at a database that already contains `batchdetails`.

## Environment

- **Primary DB** (`MONGODB_URI`): stores `batchdetails` collection.
- **Profile read DB** (`PROFILE_MONGODB_URI` or `PROFILE_SERVICE_MONGO_URI`): same Mongo as profile-service for `Profile` lookups during Excel matching.
- **Azure**: `AZURE_STORAGE_*` for batch file blobs (`batch-details/...` prefix).
- **RabbitMQ**: `RABBIT_URL`; exchange `batch.events`, queue `accounts.batch.process`, routing keys `batch.process.requested` / `batch.process.completed`.
- **Chunk size**: `PROCESS_BATCH_CHUNK_SIZE` (default 250).

## Auth

Gateway JWT + policy: `accounts.journals` `read` / `create` as on journal routes; CRM-only checks match previous behavior.
