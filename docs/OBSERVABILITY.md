# Cairn observability

Cairn's operator telemetry is local-first SQLite data, not engagement analytics.
It never sends diagnostics to a third party and never stores request/response
bodies, prompts, chat/domain text, health values, credentials, filesystem paths,
or raw agent stdout/stderr.

## Durable signals

- `diagnostic_events`: coalesced final failures and slow requests. Identical
  component/kind/error-class fingerprints within the same build merge for five
  minutes. Raw rows are retained for 30 days and capped at 20,000.
- `agent_runs`: one classified, build-scoped attempt per coaching CLI invocation. Error detail
  is taxonomy-only (`invalid_json`, `timeout`, `auth_required`, etc.); raw CLI
  output is never accepted by the write path. Rows are retained for 30 days and
  capped at 20,000.
- `request_metric_buckets`: hourly, build-scoped API/MCP counters over Express
  route templates or registered MCP operations,
  status class, and latency buckets. This provides throughput plus approximate
p50/p95 without retaining successful request rows. Browser-reported concrete
paths are collapsed to a closed API route family; server-side paths use matched
templates. SSE lifetime is excluded, while health/readiness probes are counted
separately from product throughput. Buckets are retained for 30
  days and capped at 50,000.

`GET /api/diagnostics` and MCP `get_diagnostics` return the build identity,
release-scoped grouped issues, recent sanitized events, slow operations,
current-build performance aggregates, and storage limits. `GET /api/ready` adds
queue age, recent terminal failures, and
scheduler-heartbeat freshness. Optional coaching agents never gate readiness.

## Build identity

Health, readiness, diagnostics, and MCP advertise the semantic version separately
from `build_sha`. Release images receive the exact Git SHA from GitHub Actions.
For a source Docker deployment, run:

```bash
CAIRN_BUILD_SHA="$(git rev-parse HEAD)" docker compose up -d --build
```

If neither the environment nor a local Git checkout can provide a validated SHA,
Cairn reports `source-unidentified`; it never invents a revision.

## Smoke-process containment

The smoke harness marks child servers with `CAIRN_SMOKE_MODE=1` and a throwaway
`cairn-smoke-*` database. Those servers self-terminate after a bounded maximum
runtime even if the parent test process is killed. The harness also cleans all
active children on SIGINT/SIGTERM. The lifetime switch is ignored unless both the
explicit smoke flag and throwaway-path guard are present, so production is
unaffected.
