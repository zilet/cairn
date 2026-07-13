# Cairn REST API index

> Generated from `src/api.ts` and `src/routes/*` by `scripts/gen-docs.mjs` — run `npm run docs:index` to refresh. Do not edit by hand.

All routes are mounted under **`/api`** (e.g. `GET /api/plan`). When `CAIRN_AUTH_TOKEN`
is set, every route except `GET /api/health` requires the token (`Authorization: Bearer …`,
`X-Cairn-Token: …`, or `?token=…`). See [DEPLOYMENT.md](DEPLOYMENT.md) and [SANDBOX.md](SANDBOX.md).

**255 routes** across 95 groups.

## `/activities`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/activities` |  |
| POST | `/api/activities` |  |
| GET | `/api/activities/:id` | Single activity row (poll fallback for watching enrichment_status). |
| GET | `/api/activities/:id/stream` | Live enrichment status for one activity (Server-Sent Events) — the SSE-first path the PWA uses instead of polling; snapshot then transitions, close on terminal. EventSource can't set headers, so the PWA reaches this with ?token=. |

## `/agent`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/agent/run` | Draft a plan proposal from a free-text instruction (the Coach tab's DRAFT PLAN UPDATE + the Plan → Endurance "shape your running" composer). A durable background job by default — the PWA streams the evolving caption + reconnects across reloads, exactly like session-suggest / meal-plan; when bg ops are off it runs inline and returns the legacy body unchanged. draftCoachProposal owns the agent run + proposal persistence so both paths return byte-for-byte the same body. |

## `/agent-clis`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/agent-clis/:name/install` |  |
| GET | `/api/agent-clis/update` |  |
| POST | `/api/agent-clis/update` | Backward-compatible bulk update: refresh only CLIs the user already installed; never turns a lean image back into an all-provider image. |

## `/agent-jobs`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent-jobs` | Durable agent jobs are the backgrounded heavy agentic ops. This mirrors the chat-turns surface: the PWA's kind-agnostic job runner can restore in-flight and queued work after reloads. Active (queued + running) jobs, oldest-first. |
| GET | `/api/agent-jobs/:id` | One job's current state (poll fallback when SSE is unavailable). A `done` job includes job.result = the ref-hydrated contract body. |
| POST | `/api/agent-jobs/:id/cancel` | Stop a queued or running job (drops it / SIGKILLs the live subprocess). |
| GET | `/api/agent-jobs/:id/stream` | Live progress for one job (Server-Sent Events). An immediate `snapshot` (so a late subscriber / poll-fallback sees current state, with the result if already terminal), then every phase + the terminal event from the worker bus, then close. EventSource can't set headers, so the PWA reaches this with ?token=. |

## `/agent-stats`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent-stats` | Agent-run telemetry: ok-rate, per-agent reliability + median latency, and the recent raw attempts. An operator/health view — NOT a user-facing score. Optional ?recent=N (last N attempts) and ?days=N (window the roll-up). |

## `/agents`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/agents` |  |
| GET | `/api/agents/:name/info` | Per-agent read-only visibility (subprocess probes — fetched lazily, not on every Settings open). Both return ok:false at HTTP 200, mirroring the rest of Cairn's designed failure signals. |
| GET | `/api/agents/:name/models` |  |

## `/art`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/art` | Cache hit -> the cached image, immutable-cached. Miss -> 204 immediately and a background generation is queued when generation is available; the client simply retries later. No key / disabled / known-failed also returns 204. |
| GET | `/api/art/manifest` | Which PWA art queries already have a cached image, as "kind\|q" tokens. Not cached because readiness changes as the background queue produces images. |
| GET | `/api/art/stats` | Artwork spend telemetry: estimated Gemini cost since art was last enabled, all-time totals, generations avoided via semantic reuse, and cache size. |
| POST | `/api/art/warm` | Warm the art cache: enqueue generation for everything the PWA will ask for. Safe no-op when generation is unavailable. |

## `/blood-pressure`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/blood-pressure` | A BP reading is point-in-time, not a profile field: home cuffs, MyChart vitals and clinic readings all land as dated observations that also project into the marker history as Systolic BP / Diastolic BP / Pulse. |
| POST | `/api/blood-pressure` |  |
| DELETE | `/api/blood-pressure/:id` |  |

## `/body-metrics`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/body-metrics` | The measurements list + latest reading + derived indicators + per-site trends, in one composed payload the PWA renders directly. `?days=` bounds the window; `?unit=cm` re-expresses circumferences + trends in centimeters (storage stays in). |
| POST | `/api/body-metrics` | Log a measuring session. Body carries any subset of the sites (inches by default; pass unit:"cm" to log centimeters), plus an optional note/source and — for convenience — height_in (routed to the profile so BMI / body-fat light up from the same call; it follows the same unit). Impossible values are rejected; unusual-but-possible values return a warning and remain loggable. |
| DELETE | `/api/body-metrics/:id` |  |
| GET | `/api/body-metrics/:id` | Single-row read — 200 + null on absence (the PWA api() helper resolves to the body regardless of status, so a 404 error-object would read as a truthy hit). |
| PUT | `/api/body-metrics/:id` |  |
| POST | `/api/body-metrics/log` | Agentic capture parity with the chat `log_measurement` action, exposed on REST too: "waist 34, chest 42" style free-field body → one clean logged session. |
| GET | `/api/body-metrics/trends` | Per-site least-squares trends (plain-language + sparkline points), null-safe. |

## `/bodyweight`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bodyweight` |  |
| POST | `/api/bodyweight` |  |

## `/brain`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/brain/decisions` |  |
| POST | `/api/brain/decisions/:id/revert` |  |

## `/brain-diagnostics`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/brain-diagnostics` |  |

## `/calendar`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/calendar` |  |

## `/cardio`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/cardio` | The day's logged cardio efforts (hydrated with Garmin zones/pace). [] when none. |

## `/chat`

| Method | Path | Notes |
|---|---|---|
| DELETE | `/api/chat` | "Clear" archives rather than deletes (repo.clearChat -> archiveChat): chat is part of the user's history/export, so nothing is hard-deleted anymore. |
| GET | `/api/chat` |  |
| POST | `/api/chat` | Chat is now a DURABLE, non-blocking turn (see src/chatTurns.ts): we persist the user message + a chat_turn and hand it to the serial worker, returning at once. The PWA streams progress over GET /api/chat/turns/:id/stream and rebuilds the in-flight + queued thread from GET /api/chat/turns on (re)load — so a follow-up queued mid-think, or a turn interrupted by navigation/reload/restart, survives. |
| POST | `/api/chat/reset` | "Fresh start": ARCHIVE the live conversation immediately (so the composer is usable at once — no blocking on the agent), then distill durable facts from the pre-archive history into memory in the BACKGROUND as a chat_distill job. The PWA settles a "remembered" pill when the job lands; a message typed during the distill just queues as a normal chat turn (archive-before-enqueue keeps the ordering). This always queues: resetting chat never waits on a coaching CLI. |
| GET | `/api/chat/search` | Read-only history: browse past conversations (archived by "fresh start") and search across everything. These never mutate — nothing is hard-deleted. |
| GET | `/api/chat/sessions` |  |
| GET | `/api/chat/sessions/:sessionId` |  |
| GET | `/api/chat/turns` | Active (queued + running) turns, oldest-first — the PWA reconstructs the live in-flight + queued thread from this on every (re)load (durable across restarts). |
| GET | `/api/chat/turns/:id` | One turn's current state (poll fallback when SSE is unavailable). Carries the reply prose streamed so far so a poll-driven client fills the bubble live too. |
| POST | `/api/chat/turns/:id/cancel` | Stop a queued or running turn (drops it / SIGKILLs the live subprocess). |
| GET | `/api/chat/turns/:id/stream` | Live progress for one turn (Server-Sent Events). Sends an immediate snapshot (so a late subscriber / poll-fallback sees current state), then forwards every phase + the terminal event from the worker bus, then closes. A keepalive comment holds the connection through proxies. EventSource can't set headers, so the PWA reaches this with ?token= (withToken) when auth is on. |

## `/chat-images`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/chat-images/:name` | Serve a chat-attached photo back to the PWA. Filename is locked to the UUID.ext shape we generate below, so no traversal / no serving arbitrary files. |

## `/checkins`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/checkins` |  |
| POST | `/api/checkins` | All fields optional; mood/energy/sleep_feel/soreness are clamped to 1-5 in the repo. GET /checkins?date= returns the latest for that date (or null); GET /checkins (no date) lists recent. |

## `/coach`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/coach/mealplan` | Draft a goal-aware weekly meal plan, then run a bounded self-critique verify pass against the lean-safe / longevity floors before persisting (see coachOps.draftMealPlan). The persisted plan is the verified draft; `verified` carries the "checked against your floors" signal. Verify fails open. |

## `/coaching-focus`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/coaching-focus` | THE CONDUCTOR: one sequenced whole-picture focus (lead + parallel + later + connections + a batched retest) across training, running, DEXA, health, nutrition and recovery. Pull/on-demand; the surface leads with this instead of a card flood. |

## `/context-effect`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/context-effect` |  |

## `/context-events`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/context-events` |  |
| POST | `/api/context-events` |  |
| DELETE | `/api/context-events/:id` |  |
| PUT | `/api/context-events/:id` |  |
| POST | `/api/context-events/:id/resolve` | Close a context event as healed/over (one-tap resolve) without hard-deleting it — it stays on the timeline and in exports but stops gating the day-read/conductor. |

## `/dexa-targeting`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dexa-targeting` | DEXA-driven targeting: the body scan's regional read → concrete training + nutrition targets, each with a "path to your next scan". {available:false} w/o DEXA. |

## `/diagnostics`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/diagnostics` | Local operator issue pulse: current-build browser/API/MCP/process/scheduler and worker failures, release-scoped history plus a marked current-build subset, product latency, separately counted internal telemetry, and enforceable caps. |

## `/directives`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/directives` | Active cross-domain directives (?all=1 includes resolved/dismissed). Each row carries a freshness verdict (acute / age_days / stale) anchored to the marker's real reading date, so the PWA can stop surfacing a stale acute finding (e.g. a 2-week-old hs-CRP) as a current training/nutrition shaper while chronic findings stay put. |
| PUT | `/api/directives/:id` | User-controlled status flip (the review side of propose-review-apply). This is feedback memory, not just a hide: resolved/dismissed directives suppress equivalent future advice until the relevant marker changes enough. Nothing auto-applies. 400 on a bad status, 404 on an unknown id. |
| POST | `/api/directives/derive` | Re-run the deterministic propagation engine over the latest markers. |

## `/endurance-goal`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/endurance-goal` | The endurance OBJECTIVE (v37), computed (race timing/phase derived). null = unset. SET it via PUT /api/profile { endurance_goal: {…} } (or null to clear). |

## `/endurance-prs`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/endurance-prs` | Endurance PRs (v35): best efforts from the logged cardio (longest distance / duration + fastest pace at standard distances). ?type=run\|ride filters. Plain numbers, never a score. The strength analogue is the est-1RM in /progress. |

## `/evidence`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/evidence` | Make a directive's citation INSPECTABLE: the cited evidence behind ONE marker, projected to the verifiable fields { claim, source_title, source_url, body, confidence, retrieved_at }. Reads the cache only (never the network), so it works with research disabled; evidence:[] when research never ran for it. |
| GET | `/api/evidence/summary` | Make cached evidence DISCOVERABLE (F1): the per-marker counts so a directive / marker view can show "see the evidence (N)" without an N-fetch fan-out, plus a total and whether research is on. Reads the cache only (never the network). |

## `/exercise`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/exercise/:name` |  |
| GET | `/api/exercise/:name/explanation` |  |
| POST | `/api/exercise/:name/explanation` |  |

## `/exercises`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/exercises` |  |
| POST | `/api/exercises` | Upsert by name: creates the exercise (with mode/muscle_group) or updates the provided fields on an existing one. Returns the exercise row. |
| PUT | `/api/exercises/:id` |  |
| DELETE | `/api/exercises/:name` | Delete an exercise by name. Returns 200 with ok:false (not an HTTP error) when it's still referenced by a plan or logged sets — a designed, recoverable state the PWA surfaces as a gentle reason, mirroring the swap/skip failure signal. |
| GET | `/api/exercises/aliases` | Exercise-name reconciliation (movement de-duplication) — the canon counterpart to /markers/reconcile. GET lists the learned variant→canonical aliases; POST runs the agentic reconciler over the distinct exercise names, tidying descriptive/duplicate titles ("DB bench"/"Dumbbell bench press") into clean reusable canonical names and profiling muscle groups. The deterministic exercise-canon normalizer is always on; this learns the long tail. Synchronous like the marker reconcile — ok:false at 200 is the designed failure signal. Never changes logged numbers — only the series merge. |
| POST | `/api/exercises/merge` | Merge duplicate exercises explicitly: repoint logged sets + plan items from `from` into `into`, then remove the now-empty `from` exercise. ok:false when `into` does not exist (guard; nothing is changed). |
| POST | `/api/exercises/reconcile-groups` | Reconcile exercise muscle groups using the deterministic canonicalizer. Useful after importing/creating older exercises with blank or legacy groups. |
| POST | `/api/exercises/reconcile-names` |  |

## `/export`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/export` |  |
| GET | `/api/export/db` |  |

## `/family`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/family` |  |
| POST | `/api/family` |  |
| DELETE | `/api/family/:id` |  |
| PUT | `/api/family/:id` |  |

## `/food-notes`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/food-notes` |  |
| POST | `/api/food-notes` |  |
| DELETE | `/api/food-notes/:id` |  |
| GET | `/api/food-notes/:id` | Single food note row, hydrated (poll fallback for watching enrichment_status). |
| PUT | `/api/food-notes/:id` | Manual correction of a logged food note (fix a macro, rename it, change the meal slot, "I changed my mind"). Stamps enrichment terminal so it isn't re-clobbered. 404 on unknown id. |
| GET | `/api/food-notes/:id/stream` | Live enrichment status for one food note (Server-Sent Events) — the SSE-first path the PWA uses instead of polling; snapshot then transitions, close on terminal. EventSource can't set headers, so the PWA reaches this with ?token=. |

## `/frequent-foods`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/frequent-foods` | One-tap "frequents": the foods most often logged near a time of day (±2h), most-frequent first (max 8), with macros carried from the latest occurrence when present. ?hour= overrides the server clock (the PWA passes the device hour so frequents match the user's local time-of-day, not UTC). |

## `/garmin`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/garmin/activities` |  |
| POST | `/api/garmin/activities` |  |
| GET | `/api/garmin/daily` |  |
| POST | `/api/garmin/daily` |  |
| POST | `/api/garmin/reconcile` | Reconcile synced Garmin strength activities into the day's Cairn session: the deterministic physiology merge runs now; the agentic narrative/extrapolation is queued on the serial enrichment queue. {date} for one day, else {days} window. |
| GET | `/api/garmin/sources` |  |
| POST | `/api/garmin/sources` |  |
| GET | `/api/garmin/summary` |  |
| POST | `/api/garmin/sync` |  |
| GET | `/api/garmin/unreconciled` | Synced Garmin strength activities not yet linked to a Cairn session — the watch logged a lift Cairn doesn't know about. Drives the calm "reconcile?" Today card; [] when Garmin isn't configured (no rows). Reconciling (POST /garmin/reconcile) clears the list. |

## `/goal`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/goal` |  |

## `/goal-checkin`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/goal-checkin/confirm` | Gentle goal check-in (you-drive): confirm restarts the ~3-month stable clock; dismiss starts the cooldown. Neither changes the goal — that's the profile flow. |
| POST | `/api/goal-checkin/dismiss` |  |

## `/guidelines`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/guidelines` | Trusted clinical-guideline statements (offline pack) for a marker, or the whole set. |

## `/health`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness only: process identity plus exact build provenance. It deliberately does not probe optional coaching CLIs or other external providers. |
| GET | `/api/health/doctor-loop` | Doctor-loop read: missing-workup recommendations plus lab/DEXA retest attention rows derived through the adaptive attention engine. Informational, not medical advice. |
| GET | `/api/health/doctor-packet` | Export-ready doctor packet: current prioritized health focus, active directives, doctor-loop retest/missing-workup plan, PREVENT cardiovascular-risk read, and latest intervention-outcome annotations. Informational, not medical advice. |
| GET | `/api/health/focus` | The elite-coach synthesis layer: the deterministic TIERED focus (priorities, not a flat directive flood) + the latest cached agentic health-story narrative. Both informational, no scores. The narrative is regenerated via POST below. |
| GET | `/api/health/markers` |  |
| GET | `/api/health/outcomes` | Intervention -> outcome annotations: compare follow-up marker readings against the directive/intervention anchor that created the follow-up. Directional only: this never claims causation and never auto-resolves or escalates a directive. |
| POST | `/api/health/outcomes/record` | Explicitly persist the outcome read into the quiet insight stream + learning memory. Kept POST-only so a read of the page/tool cannot create memories. |
| GET | `/api/health/review` | Latest review or null — a soft lookup like /sessions?date= (200 + null on absence, never 404): "no review yet" is a normal state the PWA renders. |
| POST | `/api/health/review` | Run a fresh whole-picture health review via the shared agent rotation. Like the meal swap, ok:false at status 200 is the designed failure signal when the agent returns garbage (addHealthReview rejects the shape). |
| GET | `/api/health/risk` |  |
| GET | `/api/health/standing` | Pull-based health standing: a descriptive, visual-friendly orientation read. Percentiles are real reference comparisons where a trustworthy curve exists (e.g. VO2max / body composition), and the "signal age" is a plain-language synthesis, not a 0-100 score or medical diagnosis. |
| GET | `/api/health/synthesis` | The cached synthesis carries a `stale` flag so the PWA can offer a calm "refresh this read" affordance when newer labs/training have drifted past it. |
| POST | `/api/health/synthesis` |  |

## `/health-docs`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-docs` |  |
| POST | `/api/health-docs` |  |
| DELETE | `/api/health-docs/:id` |  |
| GET | `/api/health-docs/:id` | Single row (poll fallback for watching enrichment_status). |
| PUT | `/api/health-docs/:id` |  |
| POST | `/api/health-docs/:id/confirm` | Confirm a pending_confirm lab paste — the chat propose→apply gate for a bulk panel. When a transcriber is reachable it flips the draft into the completeness-first, Claude-first health ingest (the same path the paste box uses); otherwise it commits the chat agent's inline markers directly. Nothing writes to Health until this fires. |
| GET | `/api/health-docs/:id/file` | Stream the original file. Only raster images / PDF are served inline. |
| POST | `/api/health-docs/:id/reanalyze` | Re-run the agentic scan over a document's original file. |
| GET | `/api/health-docs/:id/stream` | Live enrichment status for one health document (Server-Sent Events) — the SSE-first path the PWA uses instead of polling; snapshot then transitions, close on terminal. getHealthDocument returns the PUBLIC shape (never the raw file_path). EventSource can't set headers, so the PWA reaches this with ?token=. |

## `/health-export`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-export` | Structured, FHIR-inspired health summary (markers/observations over time + non-marker clinical facts + supplements + active directives) — a portable read-only slice to hand a physician or another tool. Optimal-zone framing, no scores. |

## `/health-metrics`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-metrics` | Recent metrics for a source (default all sources) over the last N days. |
| POST | `/api/health-metrics` | Ingest one row or a batch of source-agnostic daily metrics (Apple Health via Shortcuts). |

## `/health-report`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-report` | Clinician-facing health report — a doctor-ready, print-to-PDF HTML document (grouped panels + dated progress + a "findings to discuss" lead + DEXA body comp). The PWA opens it in a new tab (?token=); the page itself has a "Save as PDF" button. `?name=` stamps the patient name (also editable on the page). `.txt` is the plain-text twin for pasting into a MyChart message body. Optimal-zone framing, no scores — same boundary discipline as /health-export. |

## `/health-report.txt`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-report.txt` |  |

## `/injury-impacts`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/injury-impacts` | Structured injury timeline: for each active injury, the planned exercises it touches + calm swap suggestions. Deterministic read: suggestion, never a gate. |

## `/insights`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/insights` | The Brief surfaces ONE at a time when the app is opened. GET returns the live stream (new + seen, most recent first); dismissed insights stay in the DB and exports but are hidden here. |
| PUT | `/api/insights/:id` | Mark an insight seen/dismissed and/or record thumbs feedback. On feedback:'up' we ALSO write the insight text to memory so the relationship learns what kind of connection lands. 404 on unknown id (a real lookup, unlike the soft reads). |
| POST | `/api/insights/generate` | Run ONE agentic pass over the whole picture for a single genuine cross-domain connection, dedupe against what we've already said, and store it. Like the health review, ok:false at status 200 is the designed failure signal: the agent found nothing real (found:false) or returned an unusable shape. NO push notification ever fires; the result simply waits in-app. |

## `/last-set`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/last-set` |  |

## `/learned-timeline`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/learned-timeline` | The legible "what Cairn has learned about you" timeline (pull-only; no scores). |

## `/learnings`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/learnings` | The durable, plain-language learnings drawn from suggestion -> actual reconciliation (e.g. "tolerates higher training frequency than the read assumed"). A quiet read, never a score or a gate — these only season the coach's defaults. Reads the existing 'learning' memory rows; nothing new stored. |

## `/markers`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/markers/aliases` | Marker-name canonicalization (analyte de-duplication). GET lists the learned variant->canonical aliases; POST runs the agentic reconciler over the distinct marker names and persists genuine same-analyte merges (the deterministic normalizer + KB are always on; this learns the long tail). Synchronous like the meal swap: one agent call; ok:false at 200 is the designed failure signal. |
| GET | `/api/markers/priority` | Markers re-ranked by impact (distance from OPTIMAL, most-actionable first). Informational, not medical advice; the impact_score is an internal ordering signal only and is never rendered as a user-facing grade. |
| POST | `/api/markers/reconcile` |  |

## `/meal-plans`

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/meal-plans/:id/days` | Replace a plan's days array (manual meal reorder/edit). Preserves every other parsed_json key (daily_kcal, shopping, notes, ...). |
| POST | `/api/meal-plans/:id/recipe` | Agentic recipe for ONE planned meal, cached on the meal inside parsed_json. Cached recipe → instant { ok, recipe, cached:true } unless force. Like the swap endpoint, ok:false at status 200 is the designed failure signal. |
| POST | `/api/meal-plans/:id/swap` | Agentic swap of ONE meal in a drafted plan, honoring an optional free-text hint ("let's go with fish"). ok:false (status 200) is the designed failure signal when the agent returns garbage — the PWA api() helper reads the body regardless of status. |

## `/mealplans`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/mealplans` |  |
| POST | `/api/mealplans/:id/:status` |  |

## `/memory`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/memory` | ?all=1 includes superseded rows (history) for the curation UI; default hides them. |
| POST | `/api/memory` |  |
| DELETE | `/api/memory/:id` |  |
| PUT | `/api/memory/:id` |  |
| POST | `/api/memory/:id/supersede` | Supersede (mark, never hard-delete): optionally provide a replacement content (a new row is created) or replacement_id (point at an existing row). |
| POST | `/api/memory/consolidate` | Quiet memory consolidation: merge near-duplicates, supersede contradictions, promote recurring observations. Marks, never hard-deletes. On demand here; also scheduled nightly. Designed ok:false at 200 when the agent returns nothing usable. |

## `/muscle-load`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/muscle-load` | Acute per-muscle freshness over the last ~2 days — recent strength sets AND endurance sessions folded onto the regions they fatigue (a long ride loads the legs). Lets the Train overview say "recovering from yesterday's ride" instead of "undertrained" on a group that's simply resting. Plain words, no scores. |

## `/muscle-trajectory`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/muscle-trajectory` | Per-canonical-muscle-group advance/stall trajectory + the cadenced strength test-week read. Plain words, no scores; quiet to {available:false}/{due:false}. |

## `/next-step`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/next-step` |  |
| POST | `/api/next-step/done` | done / snooze are the calm "did it" / "not today" feedback: a skipped step doesn't return tomorrow (constitution: pull, never push; the user drives). |
| POST | `/api/next-step/snooze` |  |

## `/nutrition`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/nutrition/checkin` | Quiet adaptive-nutrition check-in: medium/high outcome confidence may support a bounded change; low confidence is hold-only except for a server-verified protective fuel raise from fresh hybrid/fatigue evidence. The agent proposes and the server autonomy policy either schedules it for the next food-day boundary or holds it under explicit review posture. Most weeks nothing has moved (change:false) and no proposal is created. ok:false (status 200) is the designed failure signal, mirroring the swap/recipe endpoints. |
| GET | `/api/nutrition/day` | A calm review of ONE day's logged food (v41): the entries (each editable), the running totals, and — only when a real target exists (a loss/gain goal, or the maintenance anchor) — a gentle "remaining". ?date=YYYY-MM-DD overrides today. |
| GET | `/api/nutrition/expenditure` | Best-effort chosen expenditure with explicit outcome/prior anchors. Read-only; powers the calm "Energy Balance" view. ?window= is safely clamped by the domain. |
| POST | `/api/nutrition/fueling-feedback` | Save today's (or ?date=) one-tap fueling read. Adherence-neutral; energy/hunger are the 1-3 running-low/steady/plenty scale, coerced/clamped at the trust boundary. Returns the saved row. Body: { date?, energy, hunger?, note? }. |
| GET | `/api/nutrition/fueling-followup` | Fueling follow-through. After a nutrition-target change applies, Today quietly offers a one-tap "how's fueling feeling?" read on days the athlete logs food, only inside the change's 7-day window. Read-only due-check + recent reads; `due:false` is the calm common answer, returned at status 200 like the other nutrition reads (never a 404). |
| GET | `/api/nutrition/goal-pace` | Goal-pace series behind the motivational weight-progress chart: the canonical weigh-in points, the recent-trend line (with a short forward projection), and the straight line to the goal. Read-only, null-safe; ?days= clamps to 14–365. |

## `/onboard`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/onboard` | One free-text intro -> understood + applied, then onboarded. Never bug-to-death: an empty text just marks onboarded. Always returns ok:true; degrades to the deterministic base (about_me + KB supplements) when no agent is reachable. |

## `/performance`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/performance` | The TRAINING-INTELLIGENCE / performance read — the athletic counterpart to /api/health/standing. Benchmarks where the user actually STANDS (each lift's capacity vs sex/age strength standards + VO2max norms), the strength imbalances, the single biggest lever, lifts worth re-testing, a variety nudge, and a holistic balance line. Derived live each call; percentile/level reference reads, no scores. |

## `/plan`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/plan` |  |
| PUT | `/api/plan` |  |
| GET | `/api/plan.ics` | Subscribe-able iCal of the training template — pull-not-push. Each plan day is a weekly-recurring all-day event (Day 1 → Monday by default; ?start=0..6 to shift, JS weekday where 0=Sun). Subscribe in Apple/Google Calendar via   webcal://<host>/api/plan.ics   (append ?token=… when CAIRN_AUTH_TOKEN is set, since a calendar client can't send a custom header). Registered before /plan/:day; the literal ".ics" path never matches the :day param. |
| DELETE | `/api/plan/:day` |  |
| GET | `/api/plan/:day` |  |
| PUT | `/api/plan/:day` |  |
| PUT | `/api/plan/:day/target` |  |
| GET | `/api/plan/recovery-status` | The recovery-week story for the Plan surface: a waiting draft ('drafted'), the applied lighter week in flight ('applied', ~a week from the apply stamp), or null. The Plan tab's banner reads this so a reshaped week announces itself — heads-up + what changed — instead of arriving silently. |
| GET | `/api/plan/upcoming` | A calm forward look for the Plan surface: the training/recovery changes the brain will land soon (a recovery week landing Monday, a bounded target change), so a reshaped week announces itself instead of arriving silently. Deduped against the recovery banner's draft; null when nothing is waiting. |

## `/profile`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/profile` |  |
| PUT | `/api/profile` |  |
| POST | `/api/profile/grow-about-me` | Grow profile.about_me from typed memory + family + check-ins (augments, never overwrites blindly). changed:false is the calm, common answer. |

## `/program`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/program/adjustments` | The handful of concrete adaptations due right now — lifts to push/hold/deload, groups that are due, missing-pattern gaps. Plain words, most-actionable first. |
| GET | `/api/program/balance` | Volume balance per canonical muscle group over the last N weeks (default 2). Plain words: which groups are due, which are over, and an adherence-skew summary. No scores — band labels (low/productive/high) are the output. |
| GET | `/api/program/blocks` | Periodization blocks (the mesocycle model the coach periodizes toward). |
| POST | `/api/program/blocks` |  |
| PUT | `/api/program/blocks/:id` |  |
| POST | `/api/program/blocks/:id/advance` |  |
| POST | `/api/program/blocks/:id/complete` |  |
| GET | `/api/program/blocks/active` |  |
| POST | `/api/program/blocks/ensure` | Ensure ONE active periodization block exists (auto-create a sensible default aligned to the user's goal when none is running; idempotent — never resets an in-progress block). Keeps periodization live without waiting for the scheduler's weekly slot. |
| GET | `/api/program/equipment` | The persisted equipment/preference profile (free text) that RANKS variation suggestions by what the user can actually load. GET reads it (+ the parsed equipment types); PUT replaces it (null/'' clears). A plain profile field. |
| PUT | `/api/program/equipment` |  |
| POST | `/api/program/evolve` | Adaptive program evolution: read the program-state, draft a plan EVOLUTION (progress / deload / rotate-a-variation / periodize), then route it through the autonomy layer. Under lead_mode='lead' a bounded, reversible evolution quiet-applies at its natural boundary and a structural restructure announces first (one-tap Undo, surprise budget honored); under 'review_everything' it parks as a DRAFT proposal for review — same propose→apply path as /agent/run. The `autonomy` field says which. |
| GET | `/api/program/playbook` | The deterministic TRAINING PLAYBOOK — plateau-type plays (strength/endurance/ mono-stimulus/hybrid-interference) + an adherence-fit restructure read, each with plain-language adaptations the evolve-program loop can focus on. Suggestion only: never mutates the plan, never a score. Quiet ("no signal strong enough") at steady state. ?date= / ?window= optional. |
| GET | `/api/program/progression` | Per-lift next-session prescription for every strength item on a plan day. ?day=N selects the day; omit to default to the plan day today's read points at (the "upcoming session" the Brief already suggests). Returns [] when the day has no strength items or does not exist. |
| POST | `/api/program/progression/apply` | Build a DRAFT plan proposal from the current day's per-lift prescriptions, then route it through the autonomy layer (buildProgressionWithAutonomy, shared with MCP so the two never drift). Under lead_mode='lead' a bounded target nudge quiet-applies at its natural boundary with a decision + one-tap Undo; under 'review_everything' the draft stays a plain reviewable draft (autonomy tier 'ask'). A "hold" (incl. an autoregulation-braked hold) is still dropped; a "vary" becomes a real {swap:{from,to}} change. Returns { ok:true, proposal, autonomy } or { ok:false, error } at 200 (the designed-failure signal — nothing wrong at the HTTP level, just nothing to do). |
| POST | `/api/program/run-plan/apply` | Build this week's deterministic run mix and route it through the same autonomy policy as strength progression. Lead mode lands the bounded update at its natural boundary with Undo; review posture keeps a draft. Strength work stays intact. |
| POST | `/api/program/swap` | Draft a single-exercise SWAP (rotate `from` out for `to` on a day) as a DRAFT proposal via the propose→apply path — behind Today's "rotate one in" chips. Never auto-applied. Returns the designed { ok:false, error } at 200 on bad input. |
| POST | `/api/program/swap/apply` | Swap AND apply in one tap — the in-session "rotate one in" chip. Unlike /program/swap (draft → review in Coach), this lands the swap in the plan immediately so the athlete can log against the new movement now; the plan adapts as they go. Returns { ok:true, swapped } or the designed { ok:false, error } at 200. |
| GET | `/api/program/variations` | Exercise variations / alternatives (the plateau-break + "make it interesting" library). ?exercise= required; ?mode=alternatives with bodyweight=1 / avoid= for swaps. |

## `/program-state`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/program-state` | Adaptive program state: per-lift trend + plateau/stall, volume landmarks, mesocycle position, endurance trends — the deterministic read the evolve-program proposal builds on. Informational (no score, no gate). |

## `/progress`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/progress/:exercise` |  |

## `/proposals`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/proposals` |  |
| POST | `/api/proposals/:id/apply` |  |
| POST | `/api/proposals/:id/discard` |  |
| POST | `/api/proposals/:id/lead` |  |

## `/reaction-model`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/reaction-model` | All read-only, plain words, no scores: the personal coaching team, surfaced for the PWA. |

## `/ready`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/ready` | Readiness is stronger than liveness: prove SQLite is readable and expose only compact durable queue counts/ages/failures plus scheduler freshness and build provenance. Optional coaching providers never gate readiness. |

## `/recent-training`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/recent-training` | The unified "Lately" feed: finished strength sessions + cardio activities merged, newest-first, with the real Garmin start time + body-reaction detail folded in. |

## `/recovery`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/recovery` | Unified recovery view (Garmin + Apple/other merged) — graceful when empty. |
| GET | `/api/recovery/baseline` | Personal-baseline recovery bands: today's HRV / resting HR / sleep vs the athlete's own last-28-day range, each a plain-language phrase (no score). A dimension without enough history is simply absent; `{ dimensions: [] }` when there's nothing to say. Drives the quiet band rows under the Today wearable card. |

## `/research`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/research` | Read cached evidence (by ?topic= and/or ?marker=). Always available: reads the cache only, never the network, so it works even with research disabled. |
| POST | `/api/research` | Run a cited, web-grounded evidence pass for ONE question and cache it. Gated by settings.research_enabled: when off, serves only cached evidence and returns ok:false (the designed signal, at 200): never reaches the network. Informational, not medical advice. |

## `/run-compliance`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/run-compliance` | Run compliance (closing the runner loop): prescribed plan cardio vs this week's logged efforts, in plain words ("32 of 40 km this week"). Never a 0-100 score. |

## `/run-plan`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/run-plan` | The RUNNING brain: this week's deterministic periodized run mix (N easy Z2 + 1 long + 1 rotated quality, each with a bpm-bearing zone + interval structure) and the user's real HR-zone bpm bands. The endurance counterpart to /performance. Both degrade to {available:false} for a non-runner / no zones. |

## `/run-zones`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/run-zones` |  |

## `/session-suggest`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/session-suggest` | Build ONE session for today on demand ("ask it for a session right now"). A SUGGESTION the user can act on or ignore — NOT saved/applied as the plan. Like the meal-swap endpoint, ok:false at status 200 is the designed failure signal (the PWA api() helper reads the body regardless of status). |

## `/sessions`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sessions` |  |
| POST | `/api/sessions/:date/feedback` | Optional per-session feedback — the human side of autoregulation. A missing session for the date is a normal "not yet" state, so this returns null rather than throwing. Values are clamped in the repo. |
| GET | `/api/sessions/:id` |  |
| POST | `/api/sessions/:id/finish` |  |
| GET | `/api/sessions/:id/highlights` | Motivational progress for one session: PRs set, per-exercise comparison to last session, and a small trailing-7-day rollup. Soft read — an unknown session is a normal "no highlights" state, so return 200 + null (the /sessions?date= convention), not 404. Factual, never a score. |
| PUT | `/api/sessions/:id/notes` | Edit a finished/past session's notes (history correction). |
| POST | `/api/sessions/:id/reopen` | Reopen a finished session to keep logging (clears finished_at). |
| DELETE | `/api/sessions/skip` |  |
| POST | `/api/sessions/skip` | Mark a planned exercise as intentionally skipped for today (or a passed date). Designed 200 + ok:false when there is no matching open session / plan item. |

## `/sets`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/sets` |  |
| DELETE | `/api/sets/:id` |  |
| PUT | `/api/sets/:id` |  |

## `/settings`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` | Settings + agent metadata. route_tasks is server-owned UI metadata for the Settings routing controls, so frontend task labels cannot drift from the backend allowlist. |
| PUT | `/api/settings` |  |

## `/since-last`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/since-last` | The "since you last looked" continuity line standalone (or null). |

## `/stats`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/stats` |  |

## `/suggestions`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/suggestions` |  |
| POST | `/api/suggestions/reconcile` | Reconcile past suggestions to what actually happened, writing durable learnings. Deterministic, no agent. Also scheduled quietly. |

## `/supplements`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/supplements` | Me -> Health "What you're taking". ?all=1 includes stopped ones (active=0). |
| POST | `/api/supplements` | Add one already-structured supplement (dedup by canonical name). |
| DELETE | `/api/supplements/:id` |  |
| PUT | `/api/supplements/:id` |  |
| POST | `/api/supplements/understand` | The headline: free text -> understood + approximated + stored. Returns the items. |

## `/symptom-links`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/symptom-links` | Symptom <-> marker connections: a symptom the user logged (in a life event or a check-in note) co-occurring with a genuinely out-of-optimal marker: a quiet "worth mentioning to your clinician" read. Informational, never diagnostic; [] when nothing co-occurs. The connected brain reaching ACROSS the logs. |

## `/telemetry`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/telemetry/client` | Best-effort browser error/API-failure ingestion. Accepts only the bounded, privacy-scrubbed client diagnostic contract. The server derives fingerprint, route family, tab and build identity; it never trusts those client values. |

## `/test-week`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/test-week` |  |

## `/today`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/today` | Cold-start aggregate for the Today screen. This is deliberately only the independent low-risk reads the client previously fetched separately; route semantics for /plan, /sessions?date=, /stats, /profile, and /exercises stay unchanged and the client still primes their individual SWR keys. |

## `/today-agenda`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/today-agenda` | The Today salience arbiter: ONE ranking + budget pass over the whole Today surface, so only the 1-2 things that matter most today render inline and the rest collapse behind a quiet "more". Marking "seen" at the end (debounced) powers the "since you last looked" continuity line. |
| POST | `/api/today-agenda/ack` | Presentation acknowledgement only: this retires the current semantic revision from Today without resolving or dismissing the underlying health directives. Materially new evidence creates a new revision and may surface again. |

## `/today-read`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/today-read` | The day intelligence read — the soul of the product. Judges what KIND of day today should be (train / easy / rest) as a calm SUGGESTION, never a gate. ALWAYS 200: the agentic read writes the human sentence, and if no agent is reachable (or it returns garbage) it falls back to the deterministic floor so the Brief always has something true to say. ?override= lets the launchpad chips reshape the read ("rough night" / "short on time" / "train anyway").  Fast path: the canonical (no-override) read is cached per day — written nightly by the scheduler and on any miss — so the morning open is instant and never waits on an agent subprocess. Overrides always recompute (they're transient). |
| POST | `/api/today-read/reshape` | Background the Brief OVERRIDE reshape ("rough night" / "short on time" / "train anyway") as a durable job, so a steer survives a tab switch / reload / restart like the other 7 ops. The canonical GET /api/today-read (and ?reset=1) stays synchronous (cached + deterministic floor); this POST is ONLY for the agentic override reshape. The job's `done` result is byte-for-byte what GET /api/today-read?override= returns, so the PWA reuses its Brief render. This always queues: a user-facing request never waits on a coaching CLI. |

## `/training-load`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/training-load` | This week's training load vs the athlete's own trailing typical (weekly set count over the prior 8 weeks) — a plain-language band, "running hot" only when genuinely above typical. `{ band: null }` until there's enough history. Drives the quiet load-band row in the Train overview header. |

## `/trajectory`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trajectory` |  |

## `/update-check`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/update-check` |  |

## `/update-status`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/update-status` | Cached release status; the scheduler refreshes it and POST performs an explicit operator-pulled check. |

## `/version`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/version` | Semantic version plus exact build SHA/build id for deploy correlation. |

## `/volume`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/volume` |  |

## `/week-ahead`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/week-ahead` | The week ahead — a calm forward look (lift / run / mixed / rest across the next several days). Agentic with a deterministic plan-rotation floor, so it always returns a usable shape even with no agent. Cached per day+plan+goal. |

## `/week-wins`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/week-wins` | The week's motivational rollup (new bests, days trained, hard sets, filled volume, weight-trend pace) ending at ?date= (default today). Evidence of forward motion, in plain words — never a 0-100 score. |

## `/whole-person-trajectory`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/whole-person-trajectory` |  |

---

*The MCP surface mirrors most of these operations — see [MCP-TOOLS.md](MCP-TOOLS.md).*
