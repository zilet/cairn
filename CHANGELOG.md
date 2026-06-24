# Changelog

All notable changes to Cairn are documented here. The project follows [Semantic
Versioning](https://semver.org/) for tagged releases.

## [Unreleased]

_Nothing yet._

## [0.6.0] — 2026-06-24

The biggest release since the open-source launch: Cairn stops feeling like a set of tabs you
operate and becomes **one invisible coach that speaks through Today**. It reads your whole day,
knows who you are, follows your own device's clock, evolves your training plan over time, and
connects every lab finding to the meals and the training it should change. A run of schema
migrations (**v38–v43**) and dozens of new surfaces — all holding the constitution: calm, no
scores, pull-never-push, you-drive, nothing auto-applies. No manual upgrade step; migrations run
on boot. PWA cache `cairn-v140`.

### Added

**The unified coach — Today as one voice**
- **Honest "done" day-read** — a day you genuinely trained reads *TRAINED TODAY*, never "EASY DAY";
  the agent voices it as a fact it can't downgrade.
- **Post-session debrief** — after you train, the Brief reads you back: today's top set, the next
  session, a real protein gap — woven into a warm read-back, not a form.
- **Day-ahead forward line** — a quiet "↗ Next: …" under the Brief shows tomorrow's focus and muscle
  groups, attached on every read (survives caching), so the Program tab is never required reading.
- **One coach voice on the Today rail** — a single "✦ Also worth a look" masthead and one shared card
  frame (accent spine + radius), so the arbitrated cards read as one continued voice, not loose features.
- **The adjustments digest reads like a coach** — leads with earned overloads and frames missing-pattern
  gaps gently ("add a little core", never "no X programmed").

**Goal beyond weight loss (migration v41)**
- **Goal modes — lose / maintain / gain** — the goal is first-class: a maintaining athlete anchors to
  real TDEE (no forced deficit), a building athlete gets a conservative lean surplus, and the
  getting-lean/deficit framing is conditioned out of every plan / meal / chat prompt so you're never
  pushed into a cut you didn't ask for. Lose/Maintain/Gain selector in Me → Profile.
- **Daily fuel review + edit** — a calm "today's fuel" glance on Today taps through to an editable day
  review in Plan → Meals (correct a macro, rename, fix a meal slot). Capture stays in Chat; the review
  is never a logging form.

**Era 2 — the calm daily driver**
- **The Today salience arbiter** — one deterministic ranking pass over the whole Today surface: the
  Brief is always the hero, the top couple of cards render inline, the rest collapse behind one quiet
  "N more". An empty-data card self-omits — a quiet day is just the Brief. (The fuel card surfaces only
  when there's food to *evaluate*, so Today never nudges you to log.)
- **Reachable cited evidence** — a curated, offline trusted-guidelines pack (AHA/ACC, Endocrine Society,
  KDIGO…) keyed to the connected-brain markers, so the brain can cite its directives with no web access.
  `GET /api/guidelines` + MCP `get_guidelines`.
- **Photo → macros** — a plate photo in Chat creates an instant food note, then a vision agent estimates
  editable, confidence-banded macros that upgrade it in place. Degrades cleanly with no vision agent.
- **"Since you last looked"** — one calm line for the single most notable change (a merged lab, a resolved
  directive, a PR, an applied plan) since you last opened Today. Never a streak or counter; silent on a
  first open.
- **Gentle "is this still your goal?"** — a rare (~90-day), dismissible check-in card; confirm or change
  restarts the clock, and a new user is never nagged.
- **The learned timeline** — a pull-only Me → Health → Learned read that projects your load-bearing
  memories, outcome learnings, and connected-brain directives. Explains, never grades.
  `GET /api/learned-timeline` + MCP mirror.

**A device-following clock (migrations v42 / v43)**
- **Time-of-day-aware coaching** — Cairn's whole clock now follows your *device* instead of the
  server/UTC, via an IANA zone the PWA sends and the chat worker re-establishes. An evening log lands on
  the right day at home *and* while traveling, and the agentic brain knows whether it's your morning or
  your night ("RIGHT NOW: …" in the prompts). Logs stay UTC instants — only the framing moves.

**The knows-me coach**
- **Grounded, personalized "knows-me" coaching** — responses are grounded in who you actually are
  (memory, about-me, history), so the coach reads less like a generic model and more like someone who's
  been coaching you for months.

**Elite strength planning (migration v40)**
- **Exercise canonicalization** — a 13-group canonical muscle taxonomy that adds first-class core /
  forearms / mobility, deterministic classification, duplicate-movement dedup, and per-group weekly-set
  bands (plain words, never a score).
- **Auto-progression engine** — reads your last logged top set + RIR and proposes the next session's
  target (overload / hold / deload / vary — conservatively clamped, injury-aware), surfaced on Today's
  lift card with "apply to my plan".
- **The logged-lifts → plan loop closes** — program state (per-lift trend, plateau/stall, volume
  landmarks, mesocycle) feeds the coach; a "what changed & why" digest surfaces on Today and Progress →
  Program.

**Adaptive program intelligence (migration v38)**
- **The plan evolves** — a deterministic program-state engine under an agentic plan-evolution loop that
  progresses what's working, deloads/rotates what's stalled, and periodizes toward an active mesocycle
  block, plus a movement-variation library for plateau breaks. Drafted through propose → apply, never
  auto-applied. `POST /api/program/evolve` + MCP mirror.
- **Intensity-aware Brief** — only genuinely-loading days count toward earned rest; a recovery day breaks
  the streak; off-plan sessions get content-true titles; the Lately feed expands strength rows to their
  movement breakdown.

**The connected brain goes deeper**
- **Whole-picture synthesis** — a prioritization layer collapses the directive flood into a handful of
  tiered, connected priorities, and an agentic pass writes the whole-picture story (the headline, the 2–3
  priorities and how they connect, the single highest-leverage move). `GET /api/health/focus`,
  `GET /api/health/synthesis` + MCP mirrors.
- **Marker canonicalization** — different labs name the same analyte differently ("Vitamin D" /
  "25-OH Vitamin D"), splitting one series in two; a deterministic KB plus an agentic reconciler now merge
  them (never conflating clinically-distinct measures), so every connected-brain surface aligns
  automatically.
- **Stale acute-marker decay** — an aging hs-CRP/ESR-class finding drops out of the daily "honor these"
  block to an informational "recheck" note instead of capping training every morning (chronic markers like
  ApoB never decay).

**Doctor-ready export (migration v39)**
- **Clinical report** — a self-contained, print-to-PDF clinical document: findings to discuss, markers
  grouped into panels with the latest value + lab flag + optimal target + full dated history, a DEXA
  section, supplements, and a "Copy for MyChart" plain-text twin. Stamped with your name (`profile.name`,
  migration v39). `GET /api/health-report(.txt)` + MCP `get_health_report`, surfaced as "Export for my
  doctor".

**Distribution & onboarding**
- **Secure self-host phone path** — `scripts/setup-phone.sh` auto-detects your private `https://…ts.net`
  URL via Tailscale Serve; a fail-closed `CAIRN_REQUIRE_AUTH` boot guard refuses to start an exposed
  instance without a token; a one-click "Open in GitHub Codespaces" front door; a "Phone & PWA access"
  Settings card.
- **Offline seed-art pack** — pre-baked studio illustrations ship in the repo so a fresh seed and the demo
  render real photos with no Gemini key (`npm run seed:art:build` to rebuild).

### Changed
- **Today is agenda-driven** — the rail is produced by the salience arbiter, reusing the rich existing
  cards and falling back to the fixed rail if the route is absent. Plus interactive progress charts,
  cardio-prose labels, and an "add to home screen" install coach.
- **Generated reference indexes regenerated** for the new surfaces: `docs/API.md` (**195 routes**) and
  `docs/MCP-TOOLS.md` (**162 tools**).

### Fixed
- **Auto-progression "apply to my plan" now applies** — the change carries `day_number`/reps/reason (the
  missing `day_number` was the "No plan day NaN" / "Couldn't apply" failure) and dedups drafts per day.
- A planned **run is skippable** on Today exactly like a lift ("not today"); a synced run overrides a stale
  skip.
- `latestSleep`'s 30-day HRV baseline dedups to one row per date, so two wearables feeding the same nights
  no longer double-weight the recovery norm.

### Notes
- The schema spans migrations **v38–v43**; they run automatically on boot. Back up before deploying schema
  changes — down-migrations are not supported (see `docs/OPERATIONS.md`).

## [0.5.1] — 2026-06-18

**Pasted lab panels now capture every marker.** A comprehensive panel (e.g. a Function Health export
with 100+ markers) was being analyzed down to ~40 — the analyzer dropped the "boring" in-range long
tail. This release makes health-record analysis complete and faithful: it transcribes the whole
panel, prefers the strongest model, and self-corrects a short read. No schema change — a drop-in upgrade.

### Fixed
- **Every marker is captured now.** A 100+ marker paste was curated down to the "decision-useful" ~40
  — the full CBC differential, electrolytes, the entire urinalysis, the omega/fatty-acid
  sub-fractions, and the sex/thyroid hormone panel were silently dropped. The analyzer now
  transcribes the complete panel verbatim, in-range markers included. (Re-analyzing a real Function
  Health paste went from **44 → 128** markers.)
- A silent **100-marker cap** that would clip a comprehensive panel even on a perfect read — raised
  to 250, comfortably clearing any real-world panel.

### Changed
- **Health-record analysis now prefers the best model.** Lab / DEXA ingestion runs **Claude-first**
  (then Codex), instead of the load-spreading round-robin rotation — faithful transcription matters
  more than spreading load for a one-off panel. An explicit per-task `health` agent route still wins.
- The extraction prompt now demands a complete, verbatim transcription — no curation, every
  in-range/normal marker included, the long-tail categories named explicitly — plus a self-reported
  marker count per panel. (It previously said "prefer real, decision-useful markers", which was the
  curation bug.) The same "no curation" guidance was added to the chat `log_health` path.

### Added
- **Self-correcting completeness check.** For a pasted-text panel, Cairn estimates how many results
  the source lists and, if the extraction comes back grossly short, re-runs the analysis once
  (Claude-first, with an explicit "you missed many" nudge) and keeps whichever read captured more.

## [0.5.0] — 2026-06-18

**Connect a coaching CLI without touching a terminal.** This release makes the agent layer
first-class and honest: sign in from inside the app, see which CLIs are connected and what model each
runs, and trust that only working agents are used. No schema change — a drop-in upgrade.

### Added
- **In-app agent login** — open **Settings → Agents → Connect** and a real terminal opens right in
  the browser to walk you through that CLI's sign-in (Claude Code / Codex / Antigravity / Grok). The
  server runs the login as itself, so the credential lands where the agent reads it — no
  `docker exec`, no `-u app` to remember. A PTY bridge over a WebSocket, with no native build step.
- **Honest rotation** — an installed-but-not-logged-in CLI is automatically kept **out** of the
  coaching rotation, so a half-configured host degrades cleanly instead of failing requests. Each
  card shows a clear **✓ Connected / Connect → / Installed / Not installed** state.
- **Version & current-model visibility** — every agent card shows the installed CLI version and the
  model it's currently using (read for free where the CLI exposes it; codex from its config).
  Transparency only — defaults are kept, nothing is pinned. `GET /api/agents/:name/info` + `/models`
  (+ MCP `get_agent_info` / `list_agent_models`)
- **Reorganized Settings** — a calm segmented sub-nav (**Agents / Sources / Automation / Data**) that
  never drops an unsaved edit when you switch sections.

### Changed
- The **agent-health card speaks plain words** ("reliable" / "mostly clean" / "often retries")
  instead of a percentage — no numeric scores, per the constitution.
- A pinned per-task agent now goes through the same retry + circuit-breaker + telemetry path as the
  auto rotation.
- Docs lead with in-app **Connect** as the easy path (`docker exec` as the fallback); the generated
  API/MCP reference and `SECURITY.md` cover the new surface. PWA cache `cairn-v89`.

### Fixed
- Grok now shows **✓ Connected** after an in-app device-auth login (it was stuck on "Installed").
- The login modal keeps a failed or interrupted login readable (Close + **Try again**) instead of
  vanishing after a second, traps focus, and fits small phone screens.
- The Settings save bar no longer false-flags "Unsaved changes" on a fresh load.
- The Settings sub-nav highlights the selected section correctly; off-plan exercise cards persist
  after the first logged set.

### Security
- The in-app login bridge is gated by the same `CAIRN_AUTH_TOKEN` and optional per-IP rate limit as
  the rest of the API, the login command is chosen server-side from an allowlist (never the browser),
  and the login subprocess is scrubbed of Cairn's own secrets (`CAIRN_AUTH_TOKEN`, `GARMIN_PASSWORD`)
  before it runs. An active login is also torn down cleanly on server shutdown.

## [0.4.0] — 2026-06-17

The first release with **endurance & running as a first-class discipline** — Cairn now coaches
lifting, running, or a hybrid of both — folded together with the open-source launch hardening that
landed since 0.3.0.

### Added
- **Endurance & running, first-class** — set your **primary discipline** (strength / endurance /
  hybrid) and an **endurance goal**: a dated **race** Cairn periodizes a conservative ramp + taper
  toward, or a **standing** readiness target with no date ("stay 10k-ready" — maintain, don't peak).
  The Brief, the plan, the coaching read, and the meals all speak to what you're actually training
  for (migrations **v35** / **v37**). `GET /api/endurance-goal` + MCP `get/set_endurance_goal`
- **Plan → Endurance race-coach** — a dedicated tab with a race-countdown / standing-goal banner,
  the current phase (base → build → sharpen → taper), and this week's run shaping
- **Applyable run prescriptions** — the coach hands back the week's runs (easy / tempo / intervals /
  long, each with distance, duration, and target zone) as a draft you approve; applying attaches
  each run to its day **surgically**, leaving strength work intact (`repo.setWeeklyRuns`)
- **The runner loop closes** — a synced Garmin run reconciles against the run that was prescribed:
  Today shows "**N of M km this week**" compliance in plain words (never a percentage), a prescribed
  run that already synced flips to a calm done card ("✓ Easy run — 8.2 km · synced from Garmin ·
  mostly Z2"), and next week adapts **conservatively** to actual mileage (fell short → hold, never
  make up missed volume). `GET /api/run-compliance`, `GET /api/cardio` (+ MCP mirrors)
- **Day-type-aware Today** — the day reads **TODAY · A RUN**, **TODAY · LIFT + RUN**, or a lift day,
  with cardio floated to the top on run days, plus a quiet Garmin **sync-trust** line ("synced 2h
  ago · Sync now")
- **Endurance progress & PRs** — Progress → Endurance shows weekly mileage, moving time, longest
  run, time-in-zone, and pace trend, plus endurance PRs; VO2max, resting HR, and HRV join the
  connected brain as optimal-zone markers (never a 0–100 score). `GET /api/endurance-prs` + MCP mirror
- **Agentic "How to do it"** — tap any exercise for a generated, plain-language explanation of how
  to perform it well, alongside its est-1RM trend and history
- **The week ahead on Today** — a calm forward look at the next few days, so today's read sits in context
- **Connected-brain visibility** — cached research evidence is now discoverable: a "see the evidence (N)"
  count on directives, a calm Settings toggle to enable research, and a quiet "What Cairn has noticed" card
  surfacing the durable suggestion→outcome learnings. `GET /api/evidence/summary`, `GET /api/learnings`
  (+ MCP mirrors). Pull-never-push, no scores
- **Structured injury impacts** — an active injury now links to the exercises it loads, with calm swap
  suggestions (deterministic; suggestion-not-gate). `GET /api/injury-impacts` + MCP `get_injury_impacts`,
  surfaced in Me→Life
- **Structured health export** — `GET /api/health-export` + MCP `get_health_export`: a portable,
  FHIR-inspired markers/observations summary in optimal-zone framing (no scores), to hand a physician or
  another tool; "Export health summary" in Me→Health
- **Garmin reconcile-now** — a calm Today card when the watch logged a strength session Cairn hasn't
  linked yet; one tap reconciles it. `GET /api/garmin/unreconciled` + MCP `list_unreconciled_garmin_strength`
- **Per-task agent routing** — optionally pin a task to a specific agent (chat → one, meal drafts →
  another) in Settings (migration **v34**); "Auto" everywhere keeps today's rotation
- **Linter, smoke test & positioning** — `biome` wired (`npm run lint` / `npm run format`, no tree-wide
  reformat); `npm run smoke` boots the server and exercises key flows over HTTP (kept out of the offline
  `npm test`); `docs/WHY-CAIRN.md` (vs MacroFactor / Oura / "ChatGPT + a spreadsheet")
- **Polish** — empty/degraded-state audit (incl. a markers-loader fix so it never sticks on a placeholder
  when offline), calm motion on the new cards, and a `seed:demo` refresh that populates the new surfaces.
  PWA cache `cairn-v68`
- **Weekly read card on Today** — the standing `weekly_read` ("how the week went + the one change")
  now surfaces as its own calm, editorial card under the Brief: a sage "THE WEEK · Jun 15–21" masthead,
  the read in Fraunces display, and the keystone `next_step` set apart as a terracotta "One change"
  well. It has a dedicated slot so a newer connection insight never buries it; the one-at-a-time
  connection insight sits below as the smaller aside (one `/api/insights` fetch split into both).
  Pull-never-push, with a weekend-gated client fallback to the proactive scheduler
- `docs/QUICKSTART.md` — five-minute getting-started path
- `docs/DEPLOYMENT.md` — Tailscale, HTTPS PWA, Pi, and backup guidance
- `CODE_OF_CONDUCT.md` and GitHub issue/PR templates
- **Family-aware meals + allergy/diet hard-exclusions** — structured allergies + dietary
  restrictions on the athlete and each family member (migration **v33**); meal/swap/recipe
  prompts hard-exclude declared allergens (safety) and add optional kid-friendly household mods
- **One-command quickstart** — `./quickstart.sh` (Docker-or-Node) + `scripts/quickstart-rpi.sh`
- **Cloud sandbox** — portable `.devcontainer/` + `docs/SANDBOX.md` (Daytona / Codespaces / Gitpod)
- **iCal plan export** — `GET /api/plan.ics` + MCP `get_plan_ics`; subscribe-able weekly plan (pull-not-push)
- **Last-night sleep/HRV in the Brief** — `repo.latestSleep()` names last night's architecture in plain words
- **Optional rate limiting** — per-IP fixed-window cap on `/api` + `/mcp`, gated on `CAIRN_AUTH_TOKEN`
  (`CAIRN_RATE_LIMIT` / `CAIRN_RATE_WINDOW_MS`)
- **Reference indexes** — generated `docs/API.md` (147 routes) + `docs/MCP-TOOLS.md` (121 tools) via
  `npm run docs:index`
- **Apple Health / Oura / Whoop** — `docs/APPLE_HEALTH.md` Shortcut guide for `/api/health-metrics`
- **Backup template** — `scripts/backup-example.sh` (cron-friendly, rotates exports + DB snapshots)
- **Supplement understanding** (not a daily log) — say it once in plain words ("creatine daily, omega-3,
  some D, whey occasionally"); a deterministic KB approximates name/dose/cadence + the markers each touches
  and the connected brain folds it into meals/training/marker reads. Chat `log_supplement`, `/api/supplements`,
  MCP tools, and a "What you're taking" card in Me→Health
- **Frictionless onboarding** — first run is one optional free-text intro (or Skip) → `/api/onboard`
  understands + applies profile/about-me/supplements/injuries/memories in one pass; no question barrage

### Changed
- **Information architecture & desktop** — the elite-launch IA restructure plus a responsive
  **two-column desktop layout**, so the phone-first PWA uses the wider screen on a laptop
- **Proposals UX** — applying a training proposal now retires its sibling open drafts (server-side
  `superseded`, distinct from a user discard), older Coach items fold behind a "Show earlier"
  disclosure, an applied proposal shows a clear "✓ Applied to your plan" confirmation, and
  plan-proposal drafting runs through an elite async loader instead of blocking
- **Modular frontend & data layer** — the two largest files were split for maintainability,
  behavior-preserving: `public/app.js` (~10k lines) → ten ordered modules under `public/js/`
  (`01-core` … `10-boot`), loaded as classic scripts that share one global scope (no bundler;
  the split concatenates byte-identical to the original); `src/repo.ts` (~7k lines, 251 exports)
  → 14 domain modules under `src/repo/` behind a re-export **barrel**, so external `./repo.js`
  imports are unchanged. Verified by `tsc` + 185 tests + 21 smoke assertions + an in-browser
  pass over every tab. PWA cache `cairn-v70`
- `package.json` — removed `private: true` for public OSS signal
- `CLAUDE.md` — schema version (v34), new surfaces, and service-worker version kept current
- **E1 closed by design** — in-app food-photo logging already lives in Chat (camera → `/api/chat` →
  the agent reads the plate, emits `log_food`, note written with the photo attached) and is
  **deliberately scoped there**: photo/voice capture is occasional and as-needed, not spread across
  surfaces; food shown elsewhere is **inspiration, not a "log this" button**
- Removed the orphaned `maybeBuildStarterPlan` (dead since the onboarding rewrote first-run as one
  free-text intro); doc-drift fixes

### Fixed
- **Onboarding** — first-run is a calmer hybrid: a few quick taps (age, training days/week, a
  goal) plus one optional free-text note, composed into a single intro through the agentic
  `/api/onboard` (nothing is lost without an agent — the endpoint keeps a deterministic base).
  Replaces a single free-text box whose welcome line rendered as a shouty wall of tracked
  ALL-CAPS (a full sentence in the `.modal-sub` kicker style)

### Notes
- **Agent CLIs are not version-pinned.** The container installs the latest Claude / Codex /
  Antigravity / Grok CLIs at image-build time (`cairn-update-agent-clis`), and the app can
  self-update them at runtime. Chat token-streaming is verified for Claude and Grok (Grok 0.2.51);
  Codex delivers only a complete `item.completed` (no token deltas) and Antigravity has no headless
  streaming flag, so both stay one-shot. Pin via the Dockerfile `INSTALL_*` build args if you need a
  reproducible CLI set.

## [0.3.0] — 2026-06-16

### Added
- **Today "Lately" feed** — strength sessions and cardio activities merged, newest-first;
  Garmin-linked rows carry HR zones, effort, and body-reaction detail
- **Chat history overlay** — scrollable read-only past conversations; left-aligned bubbles
- **Streaming chat** — token streaming for Claude and Grok headless CLIs; durable
  `chat_turns` queue survives reload/restart
- **Workout lifecycle** — finished-session done card, tap-to-edit history, `reopenSession`,
  `updateSet`, `deleteExercise` guards
- **Trust layer** — apply-path clamp guardrails, evidence surface, agent health telemetry
- **Connected brain** — marker trends/forecasting, directive feedback memory, proactive
  scheduler (pull-never-push)
- **120-test** offline harness covering constitution-critical cores

### Changed
- Service worker auto-activates on deploy (`skipWaiting` + one-shot reload)
- PWA cache `cairn-v61`

### Fixed
- Chat strips agent tool-narration before the reply marker reaches the bubble
- Segmented sub-nav scrolls when pills overflow (no clipped "Calendar" tab)

[Unreleased]: https://github.com/zilet/cairn/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/zilet/cairn/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/zilet/cairn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/zilet/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zilet/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zilet/cairn/releases/tag/v0.3.0
