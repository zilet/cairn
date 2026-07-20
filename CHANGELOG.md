# Changelog

All notable changes to Cairn are documented here. The project follows [Semantic
Versioning](https://semver.org/) for tagged releases.

## [Unreleased]

### Added

- **Durable daily sessions** — accepting a suggested or chosen session now creates
  a full, versioned snapshot that survives reloads and keeps custom work distinct
  from weekly-plan templates. The Today flow restores that session, preserves its
  prescription, and explains when a different replacement is no longer safe after
  meaningful work has started.

## [1.4.0] — 2026-07-19

Cairn can now keep medical imaging with the written findings that give it
meaning. Bring in JPEG, PNG, PDF, or MyChart findings and organize them by
body region and marker; import DICOM Part-10 files or ZIP archives into a
durable, recoverable study library. The viewer is deliberately non-diagnostic:
it helps you navigate supported classic monochrome images, while the written
report remains authoritative. PWA cache `cairn-v510`.

### Added

- **Imaging alongside findings** — JPEG, PNG, PDF, and MyChart findings can be
  associated with clinically organized body-region and marker groups.
- **Durable DICOM import** — direct Part-10 and ZIP import with resumable jobs,
  recovery after interruption, Study/Series/Instance indexing, and safeguards
  against UID and patient-identity conflicts.
- **A bounded, non-diagnostic viewer** — supported classic monochrome studies
  offer window/level, frame, and instance navigation; unsupported objects say
  clearly why they cannot be shown.
- **Careful image assistance** — AI use is limited to representative PNGs, and
  any image observations remain explicitly unconfirmed; written reports are
  the clinical authority.
- **Privacy-first imaging controls** — authentication and no-store responses,
  privacy-redacted public and export surfaces, crash-safe deletion/quarantine,
  and read-only MCP imaging tools. Raw imaging files are PHI.

### Notes

- Imaging schema updates run automatically on boot. The current migration is
  **v67** (`dicom-private-identity-hardening`); down-migrations remain
  unsupported.

## [1.3.0] — 2026-07-17

Endurance becomes a first-class citizen alongside the barbell: runs and hikes
shape recovery, rest, fueling, and the week, and the coaching brain learns how
the athlete responds to mileage the same way it learns lifts. Training identity
got sharper — one lift is one row everywhere — and the daily surfaces read
faster: a muscle-first Train tab, a week-in-review that reads in seconds, and a
workout moment with a pre-session primer. PWA cache `cairn-v506`.

### Added

- **Endurance, first-class** — runs and hikes participate in recovery, rest-day
  logic, fueling guidance, and the week view; a hybrid week sequences the
  runner and the lifter so the two don't compete on the same day.
- **The brain learns endurance** — run-volume expectations in the decision
  ledger, VO2max and easy-pace response patterns, and a hold/ease-only learned
  run-volume step.
- **Cut-quality read** — whether a cut is preserving muscle: weight trending
  down while strength holds, read calmly from Energy Balance.
- **Exercise identity** — one lift, one row, everywhere: plural and possessive
  variants fold into a single identity, with one-tap merge suggestions for
  near-duplicates and a curated lift read replacing the uncapped scroll.
- **Support-work intelligence** — a lagging lift proposes building its weak
  link, not just more of itself.
- **The workout moment** — a pre-session primer, felt freshness, and
  finish-moment feedback folded into the done card.
- **Week-in-review and the road ahead** — a latest-state, grouped weekly card
  that reads in seconds, plus one dated forward timeline of what's coming.
- **Next checkup** — the doctor loop surfaced: ordered future labs and
  follow-through tracked to completion.
- **The team's week** — a digest of the coaching brain's specialist voices with
  visible evaluations.

### Changed

- **Train leads with muscle groups** — the journey story folds beneath a
  muscle-first overview.
- **The weekly read persists compactly** — acknowledging it is not dismissing
  it; the read stays quietly available.
- **A resumed PWA checks for updates actively** — an installed client catches
  up on next open instead of sitting stale.
- **A sturdier brain under the hood** — metabolic control loop, autonomy
  atomicity, and scheduler durability; meal quality and constraint freshness
  enforced on nutrition writes.

### Fixed

- **iOS agent-login paste** — a native paste box under the login terminal; iOS
  never offers its paste menu on xterm's hidden textarea, so OAuth codes were
  impossible to enter from a phone.
- **"Hold this" sticks** — holds persist and review holds retire on every
  terminal transition; routine progressions no longer consume the surprise
  budget, and budget holds wait quietly instead of interrupting Today.
- **Chat verifies plan writes before confirming** — no confident confirmations
  over failed writes; newly created sessions finish reliably.
- **Cross-domain marker asks dedupe** — the same lab request no longer arrives
  from two domains at once.

### Notes

- Migration **v66** (`exercise-key-plural-fold`) singularizes exercise-key
  tokens so plural variants fold into one identity; down-migrations remain
  unsupported.

## [1.2.0] — 2026-07-14

Cairn's daily loop is calmer and more trustworthy: the Brief explains the
signals behind its read, recovery and training load use personal baselines, and
nutrition changes carry through to the plan instead of stopping at advice.
Capture is more durable offline, Garmin strength imports reconcile safely, and
Apple Health gains secure, revocable, least-privilege Shortcut pairing
groundwork. PWA cache `cairn-v492`.

### Added

- **A clearer daily read** — the Brief leads with the win, names the few signals
  that shaped the day, and frames gaps as calm context rather than a verdict.
- **Personal recovery and load context** — wearable recovery and training-load
  bands learn the athlete's own baseline, with sparse-data fallbacks that stay
  useful without pretending to know more than the history supports.
- **Nutrition follow-through** — accepted energy-target changes can refresh the
  downstream meal plan through the existing autonomy and undo ledger; Energy
  Balance now leads with plain-language direction and visible confidence.
- **Apple Health pairing groundwork** — an authenticated owner can create a
  short-lived, single-use pairing code, exchange it for a hashed, revocable
  token scoped only to daily-metric ingestion, and manage connections through
  REST and Settings. Pairing management is intentionally owner-only REST, not
  an MCP capability.

### Changed

- **Background coaching follows local time** — scheduling, freshness, seed
  dates, and draft-adoption grace windows use the configured local day while
  retaining UTC timestamps for durable ordering.
- **Adaptation survives interrupted stewardship** — eligible orphaned drafts
  can re-enter the server-owned autonomy path after a bounded grace period,
  preserving vetoes, natural boundaries, and Undo.
- **Energy estimates are more robust** — expenditure reads weigh the whole
  available picture, degrade honestly when inputs are thin, and avoid letting
  one anomalous signal dominate a recommendation.

### Fixed

- **Offline logs are recoverable** — failed outbox rows can be retried or
  removed, so a stale “Needs attention” toast no longer remains over the app.
- **Garmin strength imports are atomic** — detected sets reconcile as one
  transaction, respect hand-entered work, and cannot leave partial sessions
  behind when an import fails.
- **Small-screen polish and determinism** — wrapped pills no longer clip, tape
  inputs prefill from the latest measurement, and local-date tests no longer
  flake around midnight UTC.

### Notes

- Migration **v65** adds nullable source-agnostic daily-metric fields for total
  calories, distance, exercise minutes, stand hours, SpO2, and VO2max. Fresh
  Apple Health pairing/connection tables are created idempotently with
  `CREATE TABLE IF NOT EXISTS`; down-migrations remain unsupported.
- Cairn does **not** ship a validated Apple Shortcut artifact by default. Guided
  iPhone installation remains opt-in and unvalidated until an operator
  configures a trusted Shortcut URL; the documented manual-builder path remains
  the fallback.

## [1.1.1] — 2026-07-12

Cairn can now support a household safely by running one isolated released
instance per person on the same private Docker host. Each member gets their own
database, uploads, tokens, connector secrets, provider login home, tools, and
Tailscale HTTPS origin; Cairn remains intentionally single-user per process.
No schema migration is required. PWA cache `cairn-v473`.

### Added

- **Household deployment guide** — a production-oriented Compose/Tailscale path
  for adding partners or family members without sharing clinical data or credentials.
- **Clean personal bootstrap** — `CAIRN_BLANK_PROFILE=1` seeds only a neutral
  exercise catalog, with no example plan, measurements, or training history.
- **Explicit onboarding sex** — first-run setup captures the value used for
  sex-specific health ranges instead of silently defaulting a blank profile to male.

### Changed

- **Reusable release Compose** — container name, loopback bind, and host port are
  configurable while existing single-instance defaults remain unchanged.
- **Reliable release updates** — in-app and public instructions refresh the
  release Compose file before pulling, because tagged release assets pin exact images.
- **Release security parity** — fail-closed auth and Settings-secret encryption
  variables now pass through the published Compose file.

## [1.1.0] — 2026-07-11

Cairn's background expert team becomes more trustworthy and less chore-like. Intelligence outputs
are now accepted by meaning, not merely by valid JSON; failed providers repair, rotate, and fall
back calmly. Plan and Meals show the current plan, upcoming changes, and recent changes instead of
making Drafts the normal workflow. The Docker image is leaner, with coaching providers installed on
demand into a persistent tools volume. No schema migration is required. PWA cache `cairn-v472`.

### Added

- **Visible future adaptation** — Plan, Meals, and Today surface scheduled changes before they land,
  with Hold, Why, and Undo near the change rather than a separate Drafts inbox.
- **On-demand coaching CLI installation** — install only the provider you use from Settings; pinned
  identities/checksums and a persistent `cairn-tools` volume keep upgrades reproducible.

### Changed

- **Semantic intelligence contracts** — each operation validates the shape and meaning it needs,
  attempts one bounded repair, then rotates to another provider before using deterministic or stale
  fallback content.
- **Food intent stays clean** — ordinary food events no longer become durable meal preferences that
  distort later planning.
- **Autonomy language is consistent** — public docs and program-evolution prompts now match the
  server-owned policy: bounded reversible changes can land at natural boundaries, structural changes
  announce first, and clinical or goal-identity decisions always ask.

### Fixed

- **Stop remains Stop** — cancellation now propagates through verification and week-ahead fallback,
  preventing canceled work from being persisted later.
- **Calm degradation** — invalid agent responses no longer create empty drafts or misleading Today
  reads, and failure telemetry retains the rejected contract for diagnosis.

## [0.8.0] — 2026-07-04

The body surfaces get an **elite figure**: the crude ellipse packs are replaced by one
authored anatomical drawing (male/female from a shared skeleton) shared across Train and
Stand. PWA cache `cairn-v427`.

### Added

- **Elite body figures** — a vendored, dependency-free `public/cairn-body-figure.js`
  (`window.CairnBodyFigure`) replaces the crude ellipse packs with one authored
  anatomical drawing (male/female from a shared skeleton). It powers **Train ›
  Muscle balance** (front/back muscle map with band tone overlays and a due-only
  pulse; tap a muscle to jump to its row) and the **Stand › Where you stand** figure
  — a fixed reference silhouette whose tappable measurement callouts read each site
  against a reference physique scaled to your height (waist ≤ half height, shoulder
  ≈ 1.4–1.6× reference waist, arm ≈ calf, weight from FFMI), with a selected-site
  detail panel and an under/reference/over read. Both surfaces degrade gracefully to
  the prior figures if the library is absent. PWA cache `cairn-v427`.

## [0.7.0] — 2026-06-27

Cairn's coaching brain now has a **conductor**: one sequenced, whole-athlete focus that
arbitrates training, running, DEXA, labs, nutrition and recovery instead of flooding the
app and prompts with competing cards. This release also adds the deterministic running
engine, richer DEXA and muscle-group reads, stronger HealthOS validation, in-app update
detection, and the first data-triggered plan-evolution cadence. Migrations **v44-v47** run
automatically on boot. PWA cache `cairn-v166`.

### Added

- **Whole-athlete coaching focus** — new `GET /api/coaching-focus` + MCP
  `get_coaching_focus` return one lead lever, 1-2 parallel levers, explicit deferrals,
  cross-domain connections, and one batched re-test checkpoint. The same read is rendered
  first in plan prompts and surfaced as the lead card/thread in the PWA.
- **Running brain** — new run zones, weekly periodized run plan, run variety read,
  endurance re-test prompts, and a draft-only apply path:
  `GET /api/run-plan`, `/run-zones`, `POST /api/program/run-plan/apply`, plus MCP
  mirrors. Prescriptions carry real bpm zone bands and structured intervals.
- **DEXA targeting** — DEXA regional data now drives concrete training/nutrition targets
  with a plain "path to your next scan"; low BMD and visceral-fat signals stay
  clinician-framed and informational.
- **Muscle-group trajectory + test week** — per-canonical-group advancing/stalling reads,
  plateau variation menus, and a cadenced strength test-week invitation with benchmark
  lifts to re-test.
- **HealthOS hardening** — blood-pressure capture/read, symptom-to-marker connections,
  transient-marker handling, numeric plausibility clamps, non-clinical marker filtering,
  and conventional clinical marker ordering for the app and doctor report.
- **Training-intelligence standing** — Progress now benchmarks strength capacity against
  sex/age standards, reads VO2max for age, flags imbalances, names the lever, and folds
  DEXA/endurance re-tests into the performance read.
- **Garmin richness** — daily and activity sync populate more runner metrics, stress,
  body-battery-style fields where the device provides them, race predictions, training
  load balance, HR extremes, and richer activity detail.
- **Self-hosted update detection** — Settings → Data now shows the running Cairn version,
  latest release status, a What's-new link, and copy-paste update commands. The Docker
  image bakes `CAIRN_VERSION` from the release tag.
- **Data-triggered plan evolution** — the scheduler can draft an early plan evolution
  when logged data materially shifts (stalled lift, under-trained weak point, test week
  due), with cooldown/signature dedupe so it drafts once per real shift.

### Changed

- **Me opens to Standing** — the review-first Me surface now leads with "Where to focus",
  then the where-you-stand health read. Health is the lab-data home with Read / Markers /
  Records / Share / Learned; the old Brain view is folded into Health → Read.
- **Progress and Endurance are quieter** — conductor-led views keep the main action visible
  and collapse deeper benchmark detail behind a single "The full read" disclosure.
- **Today speaks with fewer competing banners** — the conductor thread subsumes the old
  health lever/goal-line pile when it has a trustworthy lead.
- **Doctor-facing marker review is easier to scan** — clinical panels now follow a
  conventional lab-review order, electrolyte ordering is explicit, and doctor export
  actions stay reachable.
- **Release workflow** — the tag-driven image workflow now bakes the exact tag into the
  image so update checks report the running version correctly.

### Fixed

- Run-plan proposals now persist structured interval prescriptions through the normal
  plan apply path without touching strength work.
- Plateau variation menus render real exercise names instead of leaking `[object Object]`.
- Urine dipstick markers group as urinalysis instead of being mis-filed under serum
  glucose/bilirubin/blood-cell groups.
- Eyeglass-prescription fields extracted from eye documents no longer show up as lab
  markers.
- The standalone health/performance lever is suppressed when the conductor already owns
  the focus, so the same advice does not repeat in three places.

### Notes

- Schema migrations **v44-v47** are additive and run automatically. Back up before
  deploying schema changes; down-migrations are not supported.

## [0.6.1] — 2026-06-24

Maintenance release for the early clinician/export follow-up after 0.6.0.

### Changed

- Improved the Health panel information architecture and clinician report readability.
- Clinically ordered health markers and kept report export actions sticky.

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

[Unreleased]: https://github.com/zilet/cairn/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/zilet/cairn/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/zilet/cairn/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/zilet/cairn/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/zilet/cairn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/zilet/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zilet/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zilet/cairn/releases/tag/v0.3.0
