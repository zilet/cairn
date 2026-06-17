# Cairn REST API index

> Generated from `src/api.ts` by `scripts/gen-docs.mjs` — run `npm run docs:index` to refresh. Do not edit by hand.

All routes are mounted under **`/api`** (e.g. `GET /api/plan`). When `CAIRN_AUTH_TOKEN`
is set, every route except `GET /api/health` requires the token (`Authorization: Bearer …`,
`X-Cairn-Token: …`, or `?token=…`). See [DEPLOYMENT.md](DEPLOYMENT.md) and [SANDBOX.md](SANDBOX.md).

**154 routes** across 59 groups.

## `/activities`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/activities` |  |
| POST | `/api/activities` |  |
| GET | `/api/activities/:id` | Single activity row (frontend polls this to watch enrichment_status). |

## `/agent`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/agent/run` |  |

## `/agent-clis`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent-clis/update` |  |
| POST | `/api/agent-clis/update` |  |

## `/agent-jobs`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent-jobs` | Mirrors the chat-turns surface verbatim (the PWA's kind-agnostic job runner codes against this). The `done` event's `result` (and GET /:id's job.result) is byte-for-byte the body the corresponding op endpoint returned synchronously before this change — so the client's done-handler reuses its old rendering. Active (queued + running) jobs, oldest-first — the PWA reconstructs in-flight + queued ops from this on every (re)load (durable across restarts). |
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

## `/art`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/art` | Cache hit → the PNG, immutable-cached. Miss → 204 immediately and a background generation is queued (when a Gemini key is set and art_enabled); the client simply retries later. No key / disabled / known-failed also → 204. |
| GET | `/api/art/stats` | Artwork spend telemetry: estimated Gemini cost since art was last enabled, all-time totals, generations avoided via semantic reuse, and cache size. |
| POST | `/api/art/warm` | Warm the art cache: enqueue generation for everything the PWA will ask for (exercises, current meal plans, recent food notes/activities). Safe no-op when generation is unavailable — requestArt handles that per query. |

## `/bodyweight`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bodyweight` |  |
| POST | `/api/bodyweight` |  |

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
| DELETE | `/api/chat` | "Clear" archives rather than deletes (repo.clearChat → archiveChat): chat is part of the athlete's history/export, so nothing is hard-deleted anymore. |
| GET | `/api/chat` |  |
| POST | `/api/chat` | Chat is now a DURABLE, non-blocking turn (see src/chatTurns.ts): we persist the user message + a chat_turn and hand it to the serial worker, returning at once. The PWA streams progress over GET /api/chat/turns/:id/stream and rebuilds the in-flight + queued thread from GET /api/chat/turns on (re)load — so a follow-up queued mid-think, or a turn interrupted by navigation/reload/restart, survives. |
| POST | `/api/chat/reset` | "Fresh start": ARCHIVE the live conversation immediately (so the composer is usable at once — no blocking on the agent), then distill durable facts from the pre-archive history into memory in the BACKGROUND as a chat_distill job. The PWA settles a "✓ N remembered" pill when the job lands; a message typed during the distill just queues as a normal chat turn (archive-before-enqueue keeps the ordering). When bg_ops is OFF this falls back to the legacy blocking inline path. |
| GET | `/api/chat/search` | Read-only history: browse past conversations (archived by "fresh start") and search across everything. These never mutate — nothing is hard-deleted. |
| GET | `/api/chat/sessions` |  |
| GET | `/api/chat/sessions/:archivedAt` |  |
| GET | `/api/chat/turns` | Active (queued + running) turns, oldest-first — the PWA reconstructs the live in-flight + queued thread from this on every (re)load (durable across restarts). |
| GET | `/api/chat/turns/:id` | One turn's current state (poll fallback when SSE is unavailable). |
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

## `/context-events`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/context-events` |  |
| POST | `/api/context-events` |  |
| DELETE | `/api/context-events/:id` |  |
| PUT | `/api/context-events/:id` |  |

## `/directives`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/directives` | Active cross-domain directives (?all=1 includes resolved/dismissed). |
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
| GET | `/api/food-notes/:id` | Single food note row, hydrated (frontend polls this to watch enrichment_status). |

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

## `/health`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` |  |
| GET | `/api/health/markers` |  |
| GET | `/api/health/review` | Latest review or null — a soft lookup like /sessions?date= (200 + null on absence, never 404): "no review yet" is a normal state the PWA renders. |
| POST | `/api/health/review` | Run a fresh whole-picture health review via the shared agent rotation. Like the meal swap, ok:false at status 200 is the designed failure signal when the agent returns garbage (addHealthReview rejects the shape). |

## `/health-docs`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-docs` |  |
| POST | `/api/health-docs` |  |
| DELETE | `/api/health-docs/:id` |  |
| GET | `/api/health-docs/:id` | Single row (frontend polls this to watch enrichment_status). |
| PUT | `/api/health-docs/:id` |  |
| GET | `/api/health-docs/:id/file` | Stream the original file inline. Only ever image/* or application/pdf. |
| POST | `/api/health-docs/:id/reanalyze` | Re-run the agentic scan over a document's original file (e.g. after a bad parse). Only rows that own a binary can be re-analyzed; derived dated panels and client-recorded analyses have nothing to re-read. |

## `/health-export`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-export` | Structured, FHIR-inspired health summary (markers/observations over time + supplements + active directives) — a portable read-only slice to hand a physician or another tool. Optimal-zone framing, no scores. |

## `/health-metrics`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health-metrics` | Recent metrics for a source (default all sources) over the last N days. |
| POST | `/api/health-metrics` | The documented Apple Shortcuts automation POSTs here. The body is EITHER one row OR an array of rows (a Shortcut can batch a backfill of several days), so we normalize to a list and upsert each via UNIQUE(source,date) — fully idempotent: re-posting a day overwrites it. Each row carries an optional `source` (default 'apple') and a `date` (YYYY-MM-DD, required per row), plus any of steps/sleep_min/sleep_score/resting_hr/hrv_ms/active_calories and a free-form `raw` blob preserved verbatim for later. |

## `/injury-impacts`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/injury-impacts` | Structured injury timeline: for each active injury, the planned exercises it touches + calm swap suggestions. Deterministic read — suggestion, never a gate. |

## `/insights`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/insights` | The Brief surfaces ONE at a time when the app is opened. GET returns the live stream (new + seen, most recent first); dismissed insights stay in the DB and exports but are hidden here. |
| PUT | `/api/insights/:id` | Mark an insight seen/dismissed and/or record thumbs feedback. On feedback:'up' we ALSO write the insight text to memory so the relationship learns what kind of connection lands. 404 on unknown id (a real lookup, unlike the soft reads). |
| POST | `/api/insights/generate` | Run ONE agentic pass over the whole picture for a single genuine cross-domain connection, dedupe against what we've already said, and store it. Like the health review, ok:false at status 200 is the designed failure signal — the agent found nothing real (found:false) or returned an unusable shape. NO push notification ever fires; the result simply waits in-app. |

## `/last-set`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/last-set` |  |

## `/learnings`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/learnings` | The durable, plain-language learnings drawn from suggestion → actual reconciliation (e.g. "tolerates higher training frequency than the read assumed"). A quiet read, never a score or a gate — these only season the coach's defaults. Reads the existing 'learning' memory rows; nothing new stored. |

## `/markers`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/markers/priority` | Markers re-ranked by impact (distance from OPTIMAL, most-actionable first). Informational, not medical advice; the impact_score is an internal ordering signal only and is never rendered as a user-facing grade. |

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

## `/nutrition`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/nutrition/checkin` | Quiet adaptive-nutrition check-in: when the derived expenditure has drifted meaningfully off the goal, the agent drafts a calorie/macro target CHANGE as a DRAFT proposal to review — never auto-applied. Most weeks nothing has moved (change:false) and no proposal is created. ok:false (status 200) is the designed failure signal, mirroring the swap/recipe endpoints. |
| GET | `/api/nutrition/expenditure` | Derived real expenditure (MacroFactor-style), adherence-neutral. Read-only; powers the calm "Energy Balance" view. ?window= overrides the 21-day window. |

## `/onboard`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/onboard` | One free-text intro → understood + applied, then onboarded. Never bug-to-death: an empty text just marks onboarded. Always returns ok:true; degrades to the deterministic base (about_me + KB supplements) when no agent is reachable. |

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

## `/profile`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/profile` |  |
| PUT | `/api/profile` |  |
| POST | `/api/profile/grow-about-me` | Grow profile.about_me from typed memory + family + check-ins (augments, never overwrites blindly). changed:false is the calm, common answer. |

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

## `/recent-training`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/recent-training` | The unified "Lately" feed: finished strength sessions + cardio activities merged, newest-first, with the real Garmin start time + body-reaction detail folded in. |

## `/recovery`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/recovery` | Unified recovery view (Garmin + Apple/other merged) — graceful when empty. |

## `/research`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/research` | Read cached evidence (by ?topic= and/or ?marker=). Always available — reads the cache only, never the network — so it works even with research disabled. |
| POST | `/api/research` | Run a cited, web-grounded evidence pass for ONE question and cache it. Gated by settings.research_enabled: when off, serves only cached evidence and returns ok:false (the designed signal, at 200) — never reaches the network. Informational, not medical advice. |

## `/run-compliance`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/run-compliance` | Run compliance (closing the runner loop): prescribed plan cardio vs this week's logged efforts, in plain words ("32 of 40 km this week"). Never a 0-100 score. |

## `/session-suggest`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/session-suggest` | Build ONE session for today on demand ("ask it for a session right now"). A SUGGESTION the user can act on or ignore — NOT saved/applied as the plan. Like the meal-swap endpoint, ok:false at status 200 is the designed failure signal (the PWA api() helper reads the body regardless of status). |

## `/sessions`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sessions` |  |
| POST | `/api/sessions/:date/feedback` | Optional per-session autoregulation feedback (Phase 3B): 1-tap soreness / performance (1-5, clamped) and a free-text joint_pain area. Keyed by DATE (creates that date's session if needed); only provided fields are written. buildCoachPrompt reads these to bend volume / de-load a sore joint. |
| GET | `/api/sessions/:id` |  |
| POST | `/api/sessions/:id/finish` |  |
| PUT | `/api/sessions/:id/notes` | Edit a finished/past session's notes (history correction). |
| POST | `/api/sessions/:id/reopen` | Reopen a finished session to keep logging (clears finished_at). |
| DELETE | `/api/sessions/skip` |  |
| POST | `/api/sessions/skip` | Skip / unskip a planned exercise for one date's session ("not today"). An exercise with sets already logged that session refuses with 200 + ok:false — a designed state the PWA surfaces as a gentle toast, not an HTTP error. |

## `/sets`

| Method | Path | Notes |
|---|---|---|
| POST | `/api/sets` |  |
| DELETE | `/api/sets/:id` |  |
| PUT | `/api/sets/:id` | Edit a single logged set (history correction). Only provided fields are touched. |

## `/settings`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` |  |
| PUT | `/api/settings` |  |

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

## `/today-read`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/today-read` | The day intelligence read — the soul of the product. Judges what KIND of day today should be (train / easy / rest) as a calm SUGGESTION, never a gate. ALWAYS 200: the agentic read writes the human sentence, and if no agent is reachable (or it returns garbage) it falls back to the deterministic floor so the Brief always has something true to say. ?override= lets the launchpad chips reshape the read ("rough night" / "short on time" / "train anyway").  Fast path: the canonical (no-override) read is cached per day — written nightly by the scheduler and on any miss — so the morning open is instant and never waits on an agent subprocess. Overrides always recompute (they're transient). |
| POST | `/api/today-read/reshape` | Background the Brief OVERRIDE reshape ("rough night" / "short on time" / "train anyway") as a durable job, so a steer survives a tab switch / reload / restart like the other 7 ops. The canonical GET /api/today-read (and ?reset=1) stays synchronous (cached + deterministic floor); this POST is ONLY for the agentic override reshape. The job's `done` result is byte-for-byte what GET /api/today-read?override= returns, so the PWA reuses its Brief render. When bg_ops is OFF this computes inline and returns the legacy read body. |

## `/volume`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/volume` |  |

## `/week-ahead`

| Method | Path | Notes |
|---|---|---|
| GET | `/api/week-ahead` | The week ahead — a calm forward look (lift / run / mixed / rest across the next several days). Agentic with a deterministic plan-rotation floor, so it always returns a usable shape even with no agent. Cached per day+plan+goal. |

---

*The MCP surface mirrors most of these operations — see [MCP-TOOLS.md](MCP-TOOLS.md).*
