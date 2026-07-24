# Idempotency

In-memory cache (5-minute TTL), applied via the `idempotency()` middleware using the
`Idempotency-Key` header (8–128 chars).

Two separate header names carry idempotency data through this codebase — check which one a given
code path actually reads before assuming the other one applies:

- `context`/`forwardedInternalContext` middleware reads `x-idempotency-key` into `req.ctx`.
- The `idempotency()` middleware reads `Idempotency-Key` (no `x-` prefix, different casing).

Sending the wrong header name for a given endpoint means idempotency silently doesn't apply — there
is no error, the request just gets processed as if no key were sent.
