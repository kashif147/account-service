# Direct Debit run — Prepare as a background job

Prepare can build thousands of items, so it runs asynchronously after the HTTP
response is flushed (mirrors the Standing Order / Deduction batch pattern).
Users see "Prepare started" immediately and a notification when the job
finishes.

## HTTP

- `POST /api/direct-debit-runs/:id/prepare` — **202 Accepted**. Returns the
  updated `run` document and `prepareJob` snapshot. Idempotent for the same
  run: if `prepareJob.status` is already `queued` or `running` the API
  responds with `409 Conflict`.
- `GET /api/direct-debit-runs/:id/prepare-status` — lightweight poll for
  job state (used by the frontend while prepare is in flight).

## Run document — `prepareJob` field

```json
{
  "prepareJob": {
    "status": "queued | running | completed | failed | idle",
    "queuedAt": "ISO",
    "startedAt": "ISO",
    "completedAt": "ISO",
    "requestedBy": "<userId>",
    "errorMessage": null,
    "attempts": 1,
    "progress": {
      "processed": 1234,
      "total": 1234,
      "phase": "loading | writing_items | completed | failed"
    }
  }
}
```

`progress.processed/total` are populated after eligibility build, so the UI
shows a meaningful percentage during the item-insert phase.

## Worker

- `setImmediate` fires `executePrepareJob` after the HTTP response is sent,
  so the request thread is freed immediately.
- The worker rebuilds `req` from a **forward-header snapshot** captured at
  queue time (`captureForwardHeaders`) so upstream HTTP calls to
  `profile-service` and `subscription-service` carry the same CRM JWT.
- Item inserts are chunked (`DD_PREPARE_INSERT_CHUNK_SIZE`, default 500).
  Each chunk emits a `batch.process.progress.v1` event with the running
  totals.

## Notifications

Reuses the existing `batch.events` routing keys so notification-service
fans out the same toast/socket events:

| Routing key                      | When                          | Socket event                |
| -------------------------------- | ----------------------------- | --------------------------- |
| `batch.process.queued.v1`        | Job moves to `queued`         | toast: "Prepare started"    |
| `batch.process.progress.v1`      | Per chunk                     | `batchProcessProgress`      |
| `batch.process.completed.v1`     | Terminal (completed / failed) | `ddPrepareCompleted` toast  |

Payloads include `kind: "DD_PREPARE"`, `runId`, `runNo`, and
`included` / `excluded` totals, so the frontend can route the toast and
trigger a list refresh.

## Cron sweeper

`directDebitPrepare.cron.service.js` polls every minute (default) and
marks any `queued`/`running` job past `DD_PREPARE_STUCK_AFTER_MS`
(default 10 min) as `failed`, publishing `batch.process.completed.v1`
with `status: failed`. This recovers from process crashes mid-job.

## Environment

```bash
DD_PREPARE_INSERT_CHUNK_SIZE=500        # item insert chunk
DD_PREPARE_STUCK_AFTER_MS=600000        # sweeper timeout (10 min)
DD_PREPARE_CRON_INTERVAL_MS=60000       # sweeper interval (1 min)
REACT_APP_DD_PREPARE_POLL_MS=3000       # frontend poll cadence
```

No new RabbitMQ infrastructure is required — events flow on the existing
`batch.events` topic exchange, and notification-service already binds the
three routing keys we use.

## Frontend

- **Prepare** button shows "Preparing…" and is disabled while
  `prepareJob.status` is `queued`/`running`.
- **Validate** and **Approve** are also disabled while prepare is in flight.
- An info banner shows progress (`processed / total`) and tells the user
  they can leave the page.
- On completion the page polls once more, refreshes items, and shows
  "Prepare complete — you can validate the run". On failure it shows the
  error message and an Audit log entry.
