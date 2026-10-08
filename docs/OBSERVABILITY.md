# Cairn observability

Cairn's operator telemetry is local-first SQLite data, not engagement analytics.
It never sends diagnostics anywhere on its own — only a feedback message the owner
writes, with diagnostics they tick, leaves the instance (below) — and never stores
request/response bodies, prompts, chat/domain text, health values, credentials,
filesystem paths, or raw agent stdout/stderr. Every outbound connection an install makes
(not only these two) is listed in
[`HOSTING.md` → What leaves your install](HOSTING.md#what-leaves-your-install).

## Feedback and the usage ping

- **Send feedback** (Settings → Data or System; `POST /api/feedback` — a person's action, not an MCP tool)
  sends the kind, the message as typed, an optional contact, the version, the platform and a
  random install id. Only when "Include anonymous diagnostics" is ticked (default off) does it
  add the snapshot the sheet previews verbatim (`GET /api/feedback/preview`): version, build id,
  platform, update method, CPU arch, Node version, uptime and up to 40 coalesced issue rows from
  `diagnostic_events` — fingerprint, source, kind, level, route template, status, count, last
  seen; never the stored message. It is capped at 32 KB. It goes to the project's feedback service
  (`DEFAULT_FEEDBACK_URL`, `https://feedback.cairn.fit`) unless `CAIRN_FEEDBACK_URL` points elsewhere.
  With `CAIRN_FEEDBACK_URL=""`, nothing is sent: the browser opens a prefilled GitHub issue
  (contact left out, since an issue is public).
- **Usage ping** — off by default (`settings.usage_ping_enabled`). On, and only with a feedback
  service configured, at most once a week it sends exactly: the random install id, the Cairn
  version, the host platform, CPU architecture and Node version. Failures are silent and retried
  no sooner than a day later; it never sits in the boot path or inside a request. The test suite and
  the smoke server set `CAIRN_FEEDBACK_URL=""` and inject `fetch`, so neither ever sends.
- The install id is a random UUID created on first use (`app_state.instance_id`); it is not
  derived from anything about the owner or the machine.

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
current-build performance aggregates, and storage limits. The response preserves
all-build history while `current_build` isolates the running build's issue count,
groups, recent events, and slow requests so an older release cannot color current
deployment health. `GET /api/ready` adds
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
