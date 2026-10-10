# Idempotency

In-memory cache (5-minute TTL), applied via the `idempotency()` middleware using the
`Idempotency-Key` header (8–128 chars). The cache key is the trusted tenant + user + method/route +
`Idempotency-Key` (never the raw client key alone), only 2xx responses are cached (replayed with
their original status), and nothing is cached when the request has no trusted tenant — so the
middleware must stay mounted after the auth middleware. There is no HTTP endpoint to clear it.

Two separate header names carry idempotency data through this codebase — check which one a given
code path actually reads before assuming the other one applies:

- `context`/`forwardedInternalContext` middleware reads `x-idempotency-key` into `req.ctx`.
- The `idempotency()` middleware reads `Idempotency-Key` (no `x-` prefix, different casing).

Sending the wrong header name for a given endpoint means idempotency silently doesn't apply — there
is no error, the request just gets processed as if no key were sent.
