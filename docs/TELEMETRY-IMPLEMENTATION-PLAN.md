# Diagnostic telemetry implementation plan

This document freezes the contract for the parallel telemetry wave. Sol owns
integration and review. Terra owns the server/durable diagnostics track. Luna
owns the browser/API-client track. Neither worker merges, deploys, bumps the
service-worker cache, or edits the other track's files.

## Product boundary

Cairn remains local-first and calm. Diagnostic capture is operator telemetry,
not engagement analytics and never a score about the person. Capture must be
best-effort and must never break the operation being observed.

Never persist request/response bodies, prompt or chat text, health values,
credentials, auth tokens, query-string values, uploaded filenames, or raw agent
output. Store normalized route/operation names and bounded sanitized metadata.

## Frozen client-ingest contract

`POST /api/telemetry/client`

- Protected by Cairn's existing auth and rate-limit middleware.
- Accepts `{ events: ClientDiagnosticEvent[] }` with 1-20 events and a bounded
  request body.
- Returns HTTP 204 on accepted best-effort ingestion.
- The client sends this endpoint with a direct guarded `fetch`, never through
  the shared `api()` helper, so telemetry cannot recursively report itself.

Each event may contain only:

- `kind`: `api_failure | render_error | unhandled_error | unhandled_rejection`
- `level`: `warning | error`
- `message`: sanitized and bounded
- `stack`: optional, sanitized and bounded
- `route`: optional normalized API path with query values removed
- `method`: optional HTTP method
- `status`: optional HTTP status
- `duration_ms`: optional non-negative duration
- `request_id`: optional server correlation identifier
- `tab`: optional bounded client tab name
- `online`: optional boolean
- `release`: optional bounded Cairn version
- `fingerprint`: stable bounded client-side dedupe key

The server assigns `source=client`, timestamps events, re-sanitizes every field,
and ignores unknown fields.

## Shared HTTP behavior

- Every `/api` request receives an `X-Request-ID` response header.
- Server-side failures and slow requests are recorded without bodies or query
  values.
- The global API error handler returns
  `{ "error": "internal error", "request_id": "..." }` for unexpected 500s.
- The existing designed `200 + {ok:false}` application contracts remain valid;
  they are not converted into HTTP transport failures.
- Browser `api()` rejects non-2xx responses other than the existing 401 auth
  flow, rejects invalid JSON, and caches only successful GETs.
- Only network/timeout failures set the offline indicator. A reachable 4xx/5xx
  response must not claim Cairn is offline.

## Durable operator model

Use a compact `diagnostic_events` table with bounded fields for source, kind,
level, operation/route, status, duration, request id, fingerprint, message,
stack, metadata, release, and timestamp. As a brand-new table it belongs in
`src/db.ts` via `CREATE TABLE IF NOT EXISTS` and needs no migration entry. Writes
are failure-safe. Query-time rollups provide totals, grouping by
kind/source/route, recent events, and slow requests. Raw event retention is
bounded (30 days) and pruning is best-effort.

Expose:

- `GET /api/diagnostics?recent=N&days=N`, returning `window_days`, `total`,
  `by_source`, `by_kind`, `by_route`, grouped `issues`, `recent`, and `slow`
- a compact Settings -> Agents operator card reusing existing diagnostic-card
  visual patterns; no athlete-facing alarm or modal.

## Readiness and process behavior

- Keep `/api/health` as lightweight liveness.
- Add `/api/ready` that verifies SQLite is readable and reports queue backlog.
- Record process and scheduler failures through the same failure-safe diagnostic
  sink where practical.
- An uncaught exception should be recorded/logged, then terminate with failure so
  Docker can restart the durable single-process service; do not continue in an
  unknown state.

## Integration-only responsibilities

Sol owns the final contract reconciliation, API/client contract typing,
generated docs, one service-worker cache bump, cross-track tests, full gates,
and merging the validated branch into local `main` without disturbing pre-existing
checkout edits.

## Completion audit

Status: implemented and integrated locally.

- Terra delivered the durable server/request/readiness/process track with
  deterministic privacy and aggregation coverage.
- Luna delivered the browser API/error-boundary/outbox/Settings track with
  deterministic classification, sanitization, and nonrecursive delivery tests.
- Sol independently reviewed both diffs, required privacy hardening, caught and
  fixed the cross-track `/api` route-namespace mismatch, reconciled shared client
  contracts, regenerated endpoint docs, added built-server HTTP coverage, and
  performed the single service-worker cache bump.
- `npm run verify` passed on the integrated tree (289 test files).
- Built server smoke passed 74 assertions, including request correlation,
  readiness, telemetry ingestion, grouping, and auth behavior.
- Browser smoke passed 17 routes and 13 real workflows without runtime errors.
- The release gate exposed a real same-member edit/delete race; Luna added
  per-member mutation serialization plus duplicate-delete protection and a
  deferred-response regression. The final rebased `npm run release:check` passed
  end to end on local `main` commit `c214a2a0` plus the telemetry wave.
- No Pi deployment or public release was requested or performed in this wave.
