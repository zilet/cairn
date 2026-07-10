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
stack, metadata, release, and timestamp. Writes are failure-safe. Query-time
rollups provide totals, grouping by kind/source/route, recent events, and slow
requests. Raw event retention is bounded (30 days) and pruning is best-effort.

Expose:

- `GET /api/diagnostics?recent=N&days=N`
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

