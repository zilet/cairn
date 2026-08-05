# Cairn architecture & migration history

The append-only, per-round changelog of Cairn's schema migrations and feature builds, relocated out of `CLAUDE.md` to keep that always-loaded context file lean. This is historical narrative: the **running** schema is always source-of-truth in `src/migrate.ts`, the service-worker cache version in `public/sw.js`, and the deploy/migration/backup playbook in `docs/OPERATIONS.md`. Read it only when you need the history behind a specific migration or feature — you do not need it to work on current code.

---

## 2026-08-05 — the week is a ring, the anchor belongs to the closed week, a question is never a veto

Follow-up round closing the flags the day's three builds left open. **The week is cyclic**: the
Mon–Sun template repeats, so day 7 and day 1 are neighbours — `weekLayoutRead`'s adjacency, its
hard-stack scan (rotated so a Fri→Mon stretch reads as one stack, and a stack's `days` list may wrap,
e.g. `[6,7,1]`), the clearing-slot legality check, and the run engine's `dayAfterLower` all read the
ring; plan days outside 1–7 are ignored rather than misread. The long-run slot preference is tiered —
a slot with no leg day on either ring side first, a merely-free slot second — in both the static and
fatigue-aware paths, so the engine no longer places the long run exactly where the read will flag it;
on a genuinely unseparable week the placement is unchanged and the read still tells the truth.
**The volume anchor belongs to the closed week**: `weeklyRunPlan`'s trailing-volume window AND its
`max(actual, base)` ratchet both default to the previous full Mon–Sun week (one `volumeAnchorDate`
governs both halves; an injected `compliance` is used as given), so a week's prescription can no
longer grow from the runs it itself prescribed — the property `runComplianceRead` already enforced
for judging now holds for planning. The runner *gate* keeps the live read (a first run logged Tuesday
is real evidence). **Chat honesty**: `hasExplicitDecisionRevertIntent` shares the edit gates'
leading-question guard (with `will` added to the interrogatives everywhere), so "Can/Will you undo
that?" is conversation, not a veto; a refused or failed `revert_decision` whose prose claims success
is REPLACED by a rotating correction (`reconcileChatRevertReply`, refused ids on their own channel
out of `applyChatActions`); and fifteen refusal/no-op literals in the chat reconcilers became
`pickDayVariant` variant sets, each keeping an invariant phrase so the fact survives the rotation.
**Typecheck honesty**: the server `tsconfig` excludes the client ambient-global `.d.ts` files, so a
server module referencing a browser global fails compile instead of throwing at runtime;
`client-shell-globals.d.ts` joined `tsconfig.client.json` so it lives in a program again. No schema
change, no `public/` change (no service-worker step).

## 2026-08-05 — the hard day earns its fuel, the week reads its own shape, chat writes a run honestly

Third round of the day, closing the gaps the first two named. **Day-specific fueling**:
`dayFuelDemand()`/`fuelDemandWeek()` (`src/repo/fuel-demand.ts`) classify each day light/standard/big
from the movable run intentions and the plan's heavy-lower days; a big day earns one quiet carb-bias
line on the fuel card (today only, never retrospective, the accepted target never moves) and the weekly
meal-plan prompt receives the week's demand map as a hard rule. **Week layout**:
`weekLayoutRead()` (`src/domain/training/week-layout.ts`) ranks the plan's lower days by tonnage →
compound sets → sets, detects the top-ranked day sitting adjacent to the long/quality run and
3-hard-days-in-a-row stacks, surfaces one movable suggestion through `adaptations_due`, and hands the
structured read (with a verified `suggested_move`) to the program-evolution prompt. **Chat runs**: a
`set_run` action lets the athlete's own words adjust one run through the same
`cardio[] → setWeeklyRuns` writer the Monday tick uses (merge-not-replace, personal-model zone tags,
refusals over guesses); endurance-shaped `plan_update` changes re-route there instead of becoming
fabricated strength items, and every readback is composed from a re-read of the store. **Closures**:
`runZones()` resolves through the personal HR model whenever it can speak (one Z2 everywhere, formula
as fallback); never-anchored calibration lines wait for enough running to read; four UTC-stamp reads
now key on the stamp's local day; the race ramp words the rate when the calendar is what broke; and a
peak day's heavy single renders as its own line ahead of the back-off block, inserted server-side in
`normalizeComposedSession` so no agent can author one. No schema change; the day's three rounds share
one service-worker step (`v546`).

## 2026-08-05 — the phase enters the math, the cut becomes a lever, the two engines see the same week

No schema migration (`user_version` stays 91); no service-worker bump (no `public/` change). Three
tracks landed in parallel, each consuming a seam the others gave a real body.

**Periodized, cut-aware, evidence-led progression** (see the architecture section). A block's phase
stops being prose and starts changing what a main lift is prescribed: accumulation banks a clean rep
on top of the range before load moves, intensification earns the step on a strong top set alone,
deload adds nothing, and realization prescribes ONE heavy top set derived from the lift's own best
estimate — est-1RM's first prescriptive role, sized to clear the calibration ledger's verifying
fraction so a logged peak re-anchors the estimate rather than becoming a stored guess. The cut turns
from a sentence in a playbook into an actual lever: a slip that coincides with live under-fuelling
evidence holds instead of taking the automatic tenth off, and a flat lift on a real deficit buys weeks
of patience before a variation is offered. A second applied deload inside eight weeks changes SHAPE —
a lower, heavier rep window, or a forced variation when there is none to wave — instead of repeating
itself, and the proportional step cap (2.5% of the bar, floored at the old flat cap) stops a 300 lb
squat and a 100 lb press from earning identical increments.

**The strength learning loop closes.** Three seams that were inert stubs while the progression round
above was built now speak for real: `movementRiskFor` reads pain on two separate days inside 90 days
as a flag (sparse data, an unknown exercise, an unreadable table all read clear — the asymmetry is
deliberate, nothing may reach the swap pool on the strength of silence); `estimateConfidenceFor` runs
the same staleness ladder the athlete-facing freshness word already runs on, and `liftProgressionSubjects`
now writes the 21-day hold expectation against a VERIFIED anchor rather than Epley's reach, since a
baseline nobody tested is exactly what let a hold expectation miss forever and teach the ledger a false
lesson; `liftLedgerRead` returns a lift's own conclusive verdicts, informative only at two or more.
`strengthRead` gains the same confounder discipline the evaluators already had, so a trip, an injury, a
measured deficit, or an open symptom loading the lifts that slid keeps a regression visible without
opening a case conference the window already explains.

**The two training engines can see each other's week.** The run builder used to consult a calendar
where it should have consulted the legs; `weeklyRunPlan` now reads `strengthLegLoad` — the
strength-sourced share of the residual on the run's own prime movers — and defers the demonstrated-long
floor-raise and the race-ramp pull, out loud, when the legs are genuinely carrying a lifting session (a
runner's own mileage never defers their build). A strength block in its intensification/realization
weeks suppresses the race pull the same way a taper or a health hold already does, and
`combinedLoadState` names a documented cross-modality read when both lanes' acute:chronic ratios sit in
their own upper caution band at once — a peaking block yields the run, a dated race yields the
strength, otherwise the run yields by default — spoken through `adaptations_due`, never a new surface
or a number. The strength-evolution prompt now carries the hybrid placement rule: never stack the
heaviest lower-body day next to the long or quality run, and say so when the week cannot avoid it.

## 2026-08-05 — the race pulls, the zones are yours, the coach tests

No schema migration (`user_version` stays 91); two new tables via `CREATE TABLE IF NOT EXISTS`
(`hr_model_state`, `calibration_events`).

**Run planning stops being reactive-only.** New `src/repo/run-ramp.ts` computes ideal + constrained
race trajectories; `weeklyRunPlan` blends the constrained ask as a pull on ordinary build weeks
(protective branches untouched), reports `goal_feasibility` in three bands with choice-framed
variant prose, and treats a demonstrated long run as a floor (bounded), not only a cap. Distance-
aware phases (≥15 km → 14-week build), threshold in the base quality pool, endurance block for a
timed race inside 16 weeks, quality from 10 km/wk with a race target, and the supporting-role
contradiction named plainly. Overshoot became visible: acceleration needs two ≥1.15-cleared windows
instead of three.

**Personal HR model + calibration ladder** (see the architecture section): zones from observed data
on a field-test → sustained-effort → fraction-of-max ladder, nightly + post-sync derivation,
conservative test detection for LTHR/benchmark/strength top sets, staleness → suggestion loop for
both domains, coach-context projection at day_read/session.

**The Endurance page stops disagreeing with itself.** The lead sentence is completion-aware (a
banked long run reads as banked, with the actual distance); `getRunCompliance` gains `basis` with a
live-plan fallback via the new domain composer; a Monday scheduler tick keeps the applied week
current through the autonomy service; and `planCardioIsRun` fixes machine-applied cardio rows
counting as zero prescribed runs (the label was folded away on save whenever the engine wrote
prose). New `GET /api/calibration/status` + `get_calibration_status` MCP mirror.

## 2026-08-04 — a volume cut is owed back

No schema change (`user_version` stays 91). Service worker `cairn-v543`.

**Training volume gets a floor and a road back up.** Progressive overload only ever moves load and
reps, so nothing in the push ladder could raise a plan item's `sets` back — a repeated
fuel-protection deload halved it forever with no bottom. `src/repo/volume-guard.ts` caps an applied
`changes[]` set-reduction to one per revision (measured against a pre-apply snapshot, so a payload
repeating one item can't each take their own step; manual edits and the `parsed.days` restructure
path are exempt by design — the restructure now reclassifies quiet_apply→announce whenever it lowers
volume, via a deterministic detector in `case-conference.ts`). Every cut records a cause-tagged
restore debt (`fuel` vs. `policy`) on its decision; only fuel-caused debt is auto-restored, one set
per item per boundary, once the underfueling loop's own training action reads `proceed` — routed
through the ordinary propose→apply path at `announce`, never quiet, and voided the moment the
athlete moves the item themselves.

**A restructure finally explains itself per movement.** `planPrescriptionSnapshot()` /
`planPrescriptionDiff()` (`src/repo/plan.ts`) diff every strength prescription across a `parsed.days`
rewrite, so `brain_change_before`/`brain_change_reason` reach the plan surface the way a targeted
change already did.

**The waiting surface.** `awaitingBrainDecisions()` surfaces held/observed decisions that carry the
case conference's own athlete-facing sentence (`action.user_explanation`), across every domain,
un-windowed — a hold stays until it resolves. `GET /api/brain/decisions/waiting` and MCP
`list_waiting_brain_decisions` expose it.

**Two smaller closures.** `recoveryReadiness()` now honors `sensorIsCurrent()` instead of falling
back to a stale-average readiness score. `nutritionTargetBasisLine()` appends the trailing-21-day
intake/weight/maintenance arithmetic (or an honest thin-data disclosure) to a nutrition target's
note whenever the kcal number actually moves.

## 2026-08-03 — the brain stops lying to itself about time

Four rounds in one day. Migrations **v89** (`settings-training-drive`), **v90**
(`insight-intent-key`), **v91** (`day-read-expectations-heal`). No service-worker bump (no
`public/` change).

**Push drive (v89).** `settings.training_drive` (`steady`|`push`): in push, an
`accumulated_load_rest` read becomes a targeted train read for due muscles — only when no other
rest trigger fired, the consecutive-hard-day ceiling holds, nothing clinical is active, and the
evidence is green (backed, or fresh readiness + last-night sleep).

**Brain honesty.** The learning ledger had zero conclusive verdicts lifetime — three annihilators
fixed (`resolved_at`/`expected_recovery_days` finally honored, done no longer cancels the morning
read, `minimum_data` normalized at write). `READING_TRUST` was born: a wearable reading is
`verified`/`uncorroborated`/`contradicted` by sleep-duration and `min_hr` coherence, and an
excursion needs ≥2 consecutive verified current readings before it changes interpretation.

**Brain quality (v90/v91).** Day-read decisions fingerprint the CLAIM (date, kind, override), not
the inputs, so a mid-day recompute is a no-op instead of a canceled prediction; reality-locked
outcomes survive supersession and v91 heals the wrongly-canceled history. `deriveDirectives()`
runs daily (ungated scheduler slot) plus on user dismiss/resolve and doc delete — the labs lane
can no longer go dormant between panels. Insights carry a flip-symmetric **intent key**
(`src/repo/insight-intent.ts`, 38-facet closed vocabulary) so a rephrased repeat collides with its
territory instead of slipping past raw-text dedupe. Reading-trust witnesses must share the
reading's source; the plausibility band demotes but never contradicts.

**Marker temporal validity (no schema change).** "Old" stopped being one number:
`src/repo/marker-validity.ts` classifies every marker into `genetic` (never age-doubted; a year
reads as confirmation), `slow` (365d note / 730d), `standard` (180/365, the default), or `fast`
(90/180 — acute-phase, white line, fasting glucose/insulin, cortisol, iron kinetics, electrolytes,
BP, wearable vitals). A finding past its own class's window leaves the prompt's "honor these"
block for an informational one, loses act-now weight in the health focus, and sinks in nutrition's
honored slots; a synthesized cluster takes its longest-lived non-genetic member and floors at
`standard` when any member is genetic. The derive signature folds one `(label, month bucket,
band)` entry per marker × reading date — clusters and zone-less markers included — so the daily
re-derive stays zero-churn and a horizon crossing lands the day it happens.

## 2026-07-30 — pain is reported in words, not filled into widgets

Migration **v88** (`symptom-scope-and-inferred-evidence`) plus one new table. Service worker
`cairn-v539`. The round removed every pain mini-UI from the app and replaced it with a capture lane:
the athlete says it however they'd say it, and an agentic pass derives the structure.

**The three failures it closes**, all confirmed against live data:

1. **Words were lost.** A free-text report was squeezed through `normalizeSymptomArea` into
   `training_symptom_events.area_text`, a 60-character *label* column — the live database held
   `"Slight unpleasent feeling in my right hand joint (probably"`, clipped mid-word, the rest gone.
   New table **`symptom_reports`** (`CREATE TABLE IF NOT EXISTS`, so no migration entry) stores every
   pain-ish input VERBATIM and synchronously, before anything is derived: `text`, `source_kind`
   (`session_note` | `session_feedback` | `chat` | `api`), `reported_on`, a nullable event/session
   link, and `extraction_json`/`extraction_status` (`pending`|`done`|`skipped`|`failed`).
   `area_text` remains the short grouping label it always was — pain-relevance runs substring
   regexes over it, so a paragraph there loads every lift.
2. **Whole-body reports had nowhere to go.** `training_symptom_events.scope`
   (`'area'`|`'systemic'`, default `'area'`) makes "everything feels off, not one movement" a
   first-class watch. A systemic event never drives movement relevance — `activeRelevantTrainingSymptoms`
   and `trainingSymptomsForMovements` exclude it by SCOPE rather than leaving it to fail the area
   vocabulary — but it appears in the session primer's watch list (its own variant set) and in the
   coachOps fingerprint, and any training day refreshes it.
3. **Freshness was a manual keep-alive pedal.** Only button presses moved `last_reported_on`, so a
   watch the athlete trained around daily went stale in a week. `finishSession` now runs
   `inferTrainingSymptomExposures()`: for each active area watch, every movement worked that day
   that it plausibly loads, with nothing reported painful on it, becomes a quiet tolerated exposure
   — `outcome 'pain_free'`, new column `movement_tolerance_observations.evidence = 'inferred'`.
   Idempotent through the existing unique exposure indexes, so a re-finish or a Garmin re-sync adds
   nothing.

**Silence is never dressed up as confirmation.** An inferred exposure moves recency and nothing
else: no recurrence bump, no clearing of `legacy_unconfirmed`. `hydrate()` carries
`stated_pain_free_exposures` and `inferred_only` so surfaces say "tolerated in training twice — no
word from you yet" rather than implying an all-clear, and a later stated observation UPGRADES the
inferred row in place instead of being swallowed by the duplicate guard. The lifecycle also gained
`last_stated_on`/`stated_freshness` — how current the athlete's own ACCOUNT is, which `freshness`
no longer tracks now that quiet training refreshes it. `symptomGatesComparability`,
`dailyDecisionSnapshot`'s protective-vs-soft_recheck level and the primer's recheck wording all read
`stated_freshness`; without that split, one open note plus a training habit would hold every outcome
out of the comparable set forever — the "no verdict can ever be reached" failure an earlier round
already dug out of live data. With no inferred evidence on file the two are identical, so every
pre-existing record behaves exactly as before.

**The extraction lane.** `src/symptomCapture.ts` is the ONE contract (the role `src/foodCapture.ts`
plays for meals): one JSON shape, one prompt builder, one validator, never re-declared elsewhere.
Output is `{found, reports:[{quote, area_label, scope, change, movements:[{name, outcome}]}]}`.
The model never picks an id — it echoes an area LABEL and the deterministic side matches it through
`symptomAreaKey`; it never invents a movement — it may only name movements from the list it was
given, and `matchSymptomMovement` re-matches every one; and `quote` must actually appear in the
athlete's text, which is what keeps coaching prose, a score or a verdict out of a field the surface
renders as their words. Validation is strict (a violation fails the whole payload) because failure is
free: `extraction_status` goes `failed`, the words stay stored and displayed. Results apply through
the EXISTING repo functions only — `reportTrainingSymptom`, `recurTrainingSymptom`,
`resolveTrainingSymptomByArea`, `recordMovementTolerance` — so every idempotency guard, epoch rule
and proposal-truth snapshot keeps working. A new `symptom` kind on the enrichment queue
(`src/enrich.ts`, `processSymptomJob`/`applySymptomExtraction`, `pickAgentOrderForTask("enrich")` +
`executionProfileForTask("enrich")`) runs it; the repo registers its enqueue through
`src/repo/symptom-extraction-hooks.ts` rather than importing the engine. Enqueue points: session
finish notes, `updateSessionNotes`, the feedback `joint_pain` line, an explicit REST/MCP report and
the chat action — each behind `symptomTextMentionsBody()`, a cheap keyword prefilter so "felt strong,
good session" never costs an agent call.

**The UI is display-only.** Gone from `src/client/today-session-feedback-client.ts`: the "Report
pain" composer, the "Choose movement" dropdown, the Pain-free/Pain-present pair, the "It returned"
recurrence form, and — from `today-cards-client.ts` — the per-exercise Movement check, its
stop-marker machinery and the per-session `loadSymptomMovements` relevance read. What remains is the
PAIN & INJURY header with its active count, each watch rendered in the athlete's OWN verbatim words
(escaped; falling back to `area_text` for legacy rows), the Watching / "Older note · unconfirmed"
badges, the honest evidence line, one-tap **Mark resolved**, the resolved-history disclosure, and a
quiet hint: *"Mention pain in your session notes or chat — Cairn picks it up."* The server endpoints
and MCP tools all stay — they are the agent/API surface; what was removed is asking a HUMAN to fill
them in. `report_training_symptom` (REST + MCP) gained `report_text` and `scope`.

---

## 2026-07-30 — the presentation round: docs hold living references only

Six commits, no migration, no service-worker change — nothing under `public/` moved. Beyond the
documentation work below, the round carried three runtime changes:

- **The nightly learning pass became durable** (`src/scheduler.ts`). It was the last daily job gated
  on the process being awake at exactly the memory hour, with its last-run date in a process-local
  variable — a restart across 3am silently dropped a whole day of suggestion reconciliation,
  expectation evaluation, miss follow-ups, step-back drafting and model rebuilds. `memoryMaintenanceDue()`
  is now an hour floor over the same durable `dailySlotDue` slot every other daily job uses
  (`app_state` key `memory_maint_last_date`), so a missed hour catches up on the next tick past it.
  `seedMemorySlotOnFreshInstall()` acknowledges the current day on a database with no scheduler
  history at all, so a brand-new install booted after 3am waits for the next memory hour instead of
  running the whole pass — agentic consolidation included — a minute after first paint.
- **Antigravity gained enforced structured output** (`agents.json`). `agy` 1.1.8 added
  `--json-schema` + `--output-format`; both flags now ride the `{schema_args}` slot, with the model
  JSON unwrapped from the CLI's telemetry envelope (`structured_output` key — the same trap grok
  has). Verified live end-to-end through `runAgent`. Full flag notes: `docs/ARCHITECTURE.md`.
- **The prompt layer got one home per repeated contract** (`src/prompt/`): `renderJsonContract()`
  replaces ~22 hand-written output-contract preambles (the strictest drifted variant won),
  `MECHANICS_ENCODING` + `renderGoalTargetFallback()` centralize the assisted-weight/timed-seconds/
  target-fallback rules, the health ingest and enrich prompts share one transcription rule block,
  and the meal-plan prompt no longer re-serializes six subtrees its `DATA:` projection already
  carries (the check-in, which has no `DATA:` block, keeps the full payload). Lane-scoping the chat
  action catalog was evaluated and deliberately rejected: real coach-lane phrasings ("undo that",
  "my knee's been bugging me") route to coach, and no server backstop or escalation signal exists
  to catch the capability loss.

`docs/` now holds only documents that describe how Cairn currently works. Four executed one-round
build plans and agent-process notes are deleted: `ADAPTIVE_DAILY_TRAINING_PLAN.md` (the four-stage
daily training plan — all four stages shipped and are described in `ARCHITECTURE.md`),
`ELITE-BRAIN-PLAN.md` (whose outcome is `ELITE-BRAIN-IMPLEMENTATION.md`),
`ELITE_COACHING_QUALITY_PLAN.md`, and `CODEX-MULTIAGENT-ORCHESTRATION.md` (how one round's
multi-agent build was driven, not how the product behaves). Git history keeps all four; none of them
described running behavior that lives nowhere else. `ELITE-BRAIN-IMPLEMENTATION.md` opened by naming
the plan it was integrated against and closed by citing the orchestration note for its
model-selection rules — both lines now stand on their own. Five source comments in `coachOps.ts`,
`db.ts`, `daily-composition.ts`, `daily-decision.ts` and `daily-reconciliation.ts` cited section
numbers inside the deleted training plan (`§4`, `§5`, `§6`, `§8`); they name their stage instead.

`README.md` went from 508 lines to 261. It had grown two Docker sections whose `docker run` block
was byte-identical, a 230-word identity paragraph above the fold, an API count (`211 routes across
84 groups`) that had drifted from the generated index's 307, and the MCP server — half of what makes
Cairn interesting to anyone building with agents — buried at line 446. The rebuilt page leads with
the tagline, hero and five bullets, keeps ONE quickstart, promotes MCP to its own section with live
generated counts, condenses `WHY-CAIRN.md` into four paragraphs that each name when the alternative
wins, and moves the no-auth security callout below the install material rather than above the fold.
The hero deliberately stays a GIF: GitHub strips `<video>` from rendered markdown and serves a repo
raw `.mp4` as `application/octet-stream`, so the 1 MB `media/cairn-hero.mp4` would download instead
of playing — only uploaded-attachment URLs render a player.

One fact from the previous round the entry below does not record, from the review commit it folds
in: `RecentLoad` carried the internal decaying muscle residual, and `coach.ts` spreads that record
whole into the coach context as `recent_load` — which sits in `TRAINING_FULL`, so every training
prompt was handed a raw float per muscle group with nothing in the reading grammar to catch it. The
field is gone; consumers wanting the depth behind the boolean call `acuteGate()` / `muscleResidual()`
directly, and a test pins that the key never returns.

## 2026-07-30 — sensor timestamps, muscle time, ledger ownership, and a chat review that resolves

Six commits, migration **v87** (`expectation-overlap-arbitration`, no schema change), sw v537.

`src/repo/sensor-freshness.ts` is now the one place that answers how old a wearable datum may be
before it stops speaking for today (`SENSOR_MAX_AGE_DAYS`: sleep 2, `training_readiness` 1,
HRV/resting-HR/`training_load` 3, `fitness_marker` 14). Past its bound a reading behaves exactly as
absent, never a soft caution or a discounted vote — an unbounded "give me the newest row" lookup
used to happily hand back a fortnight-old night as though it were last night's. Wearable markers get
the lab path's own no-forecast-off-two-dots honesty layer plus this recency bound; recovery bands,
acute training load, the coach prompt's point-in-time readings, and `day-read`/`signal-state`'s own
hand-rolled age checks (sleep moved 3→2 days) all resolve through the same table now.

The muscle model traded a fatigue boolean with a midnight cliff (`sets >= 4` inside a fixed 2-day
window) for a per-group decaying residual: `residual = Σ dose × 0.5^(hours_since/half_life)`,
strength dose reusing the shared effective-volume read and endurance dose scaling past each
modality's own heavy bar. `acuteGate()`/`acuteGates()` (`src/repo/hybrid-load.ts`) is the one
acute-recovery question every consumer now asks instead of four different hand-rolled versions of
it — `autoregBrake`, plan-selection, the daily-decision envelope, `today-agenda`'s balance rows, and
(newly) `forwardLook`/`weekAheadPlan`, which is how the Brief stops saying "quads & calves due" the
morning after the long run that flattened them. Soreness/performance autoregulation now scopes to
the muscle groups a session actually trained rather than braking the whole body for three days, and
fails closed when the scope can't be resolved; the daily envelope's REDUCED areas are clamped
server-side instead of only asked for in the prompt.

Five silent read-path defects in the personal-response model got the same fix in one pass: the
500-row outcome window read oldest-first instead of newest, so a busy ledger froze on ancient
verdicts forever; the progression ladder resolved a lift's step through the athlete-facing
`learnings` prose (capped at four) instead of the underlying `modifiers`, so a modifier fell off the
cap and a null-subject nutrition learning could shadow the training default; a modifier earned once
applied at full strength forever, and now ages — full to 180 days, linear fade to 365, gone after;
`domainIsDemoted`'s reversal-safeguard predicate moved from counting in JS over the last 100
decisions to SQL, since the busy domain the guard exists for was exactly the one that made the JS
scan miss; and a declared 0.85 floor `training_progression_step` could never reach was deleted.

Nutrition got three grounding fixes: a low-confidence food-capture entry is now excluded from the
nutrient band tallies (they render verbatim as counts, so they stay whole numbers) and from
`foodRecovery`'s exposed/clean evidence outright — an uncertain guess is not evidence either way; `mealPlanFreshness()` gained a pure calendar-age branch (`MEAL_PLAN_CALENDAR_STALE_DAYS`
= 21) so a stable athlete's plan goes stale by the calendar even with no newer upstream signal to
compare against; and an active saturated-fat/added-sugar lab directive (ApoB, LDL-C, Non-HDL-C,
cholesterol, triglycerides, HbA1c) now lands a non-blocking `validation_warnings` entry when the
plan's own pattern reads `watch` on that band — sodium directives deliberately warn on nothing,
since the plan schema carries no sodium field by anti-hallucination design.

The expectation ledger's "two changes racing over one metric silence each other into
`inconclusive`" bug (documented above, migration v87) is one of these six commits, not a separate
round — `retireSupersededExpectations` (`src/repo/brain/expectation-arbitration.ts`) is a single
symmetric (loser, winner) SQL predicate that IS the write path when scoped to one row and IS
migration 87's whole-table repair when it isn't.

Last, the chat capture chip's promised nutrition review finally resolves inside the original
message: `stampCaptureFood()` (`src/repo/chat.ts`) derives the ingredient rows an estimate was built
from (capped at 6, with the true count) plus a provenance line, off the food note's current parsed
blob at READ time — nothing is written back onto the message, so a re-enrichment revises the review
in place instead of appending a second one, and a client that was closed when the estimate landed
sees it on the next ordinary history read.

A same-day follow-up closed a hole that machinery couldn't reach: "Add half of Brussel sprouts from
their appetizer list" routed to the coach lane (no word of it was in the food-noun lists), where the
model *claimed* the addition and emitted no action — nothing changed and no estimate was ever made.
Chat routing now treats menu language (appetizer/starter/entrée/dessert/side of) as food, and gains a
`recent_food_capture` input (`hasRecentFoodNote()`, 6h): an amendment-verbed follow-up (add/include/
also — plain "log …" keeps its instant receipt) while a food note is fresh routes to the capture lane
tagged `capture_correction`, which keeps it off the no-agent instant path (that path can only create a
NEW note — a duplicate meal here) and on the agent path where `update_food_note` reaches the existing
row; activity/weight/supplement-shaped messages never ride the branch. The coach-lane prompt
additionally forbids claiming anything was logged or changed unless the turn actually emits the
matching action. The same message also silently folded the chat fuel strip: the client gates it on its
OWN food regex (a third drifting food classifier), which knew no menu vocabulary either. The client
now recognizes menu language and, more structurally, trusts the reply's `meta.routing` reason codes —
the server's own verdict — as a food signal, keeping the strip from ever disagreeing with the lane
that handled the message (sw v538).

## 2026-07-30 — the completion round: every declared lever now pulls

Four commits closing out the elite-brain arc below: every target the personal-response model and the
expectation ledger had declared, and nothing yet read, gets a real consumer.

Weekly running volume could only ever brake. `reaction-model.ts`'s `run_volume_step` now accelerates
too, to a declared ceiling of 1.05, behind the strictest guard stack in the model: three consecutive
aligned adherence verdicts (one more than the in-session load step's two, since a week of mileage isn't
recheckable next session the way a lift is), nothing missed anywhere in the comparable window, no
training symptom on record, and — the no-whiplash rule — a full clean cycle at the standard build
before an ease may become an acceleration, so one good week straight after a bad one can't whipsaw the
athlete from a reduced build into a raised one. `weeklyRunPlan()` (`src/repo/run-progression.ts`) had
been silently discarding any modifier scale above 1, the same bug the strength consumer once carried;
it now composes an earned acceleration only on an ordinary build week (never taper, deload,
recovery-down, a mileage spike, or a scheduled/detraining rebuild) under a hard 1.15 ceiling on the
week's total factor, so run volume's declared bounds are finally the ones the model can actually reach.

`vo2max_trend` needed a window measured in months — its evaluator refuses a slope off fewer than 4
readings spanning 21 days — and every decision remade often enough to host a training change was
remade far too often to carry an eight-week question. `buildAerobicTrendExpectation()`
(`src/repo/brain/change-expectations.ts`) instead hangs an aerobic-floor expectation ("fitness should
not drift down," never a promise it goes up) off `createBlock()` (`src/repo/program-blocks.ts`), the
only training structure in the app with a declared multi-week lifetime and one created rarely enough
not to remake the question every week. It writes only when the watch is actually reporting VO2max, and
a re-arm guard (`hasLiveAerobicTrendWindow`, deliberately wider than the confounder check it exists to
stay clear of) refuses a second window while one is already standing, so two overlapping windows can
never flag each other as confounders. Recording is fail-soft: the block itself is authoritative, its
ledger entry best effort.

The personal-response modifier map had been quietly starving whichever target was learned about least
recently: `whatWorksForYou()` handed out four slots by recency across what are now five declared
targets, sliced from a prose list that had *already* been cut to four for calm — two stacked
truncations, so a busy ledger could switch a whole lever off with no evidence anything had been
dropped. The slot logic is now two-phase — one slot per distinct target claimed before any second
reading of the same target, then staged nutrition-stage variants backfilled — and the cap is derived
from the declared target record (`Object.keys(PERSONAL_MODIFIER_TARGETS).length + 3`) rather than a
literal 4, so a sixth declared target nobody wired a slot for is a build error, not a silently reopened
bug.

The two targets that fix unblocked now have real consumers. `plan_complexity` — earned from
repeatedly-missed plan days — rides the daily-decision snapshot (never read live inside the decision
itself, so `buildDailySessionDecision` stays a pure function of its input and the fingerprint moves
only when the learning does) into `softenVolume`: below 0.95 the day is offered in the reduced shape
with a rotating athlete-facing reason, silent on a rest day where volume is already minimal.
`recovery_adjustment` steers `buildRecoveryMenu()` (`src/repo/recovery-menu.ts`) toward the quieter
half of the same combo — dropping the option that raises breathing, shortening the rest — but ONLY
above 1, since this target sizes the recovery response itself rather than a step size and so eases
*upward*, the opposite direction from every step-size target; read the other way, a scale that ever
drifted under 1 could never talk the menu into offering more than the standard day.

The nutrition-target change now writes the composition half of its own prediction. A cut whose tape is
genuinely flowing (two waist readings in the trailing 60 days) claims what a deficit unambiguously
claims — the waist should not go up — via `bodyMeasurementExpectation()` (`src/repo/nutrition.ts`).
Gain and maintenance deliberately claim nothing: some waist gain is expected in a lean gain and nothing
in the evidence knows how much, so predicting a ceiling there would be inventing a number. This is
cut-only by design, not an oversight.

`checkins.mood` has been written since the first check-in and read by nothing that reasons about it.
It now enters the signal state as a generic `context_only` observation (`src/repo/signal-state.ts`) —
carried into coverage, provenance and the evidence trail, excluded from every computation that produces
a status, confidence, voice or posture. A bare `neutral` direction would not have been safe on its own:
a neutral observation still makes a dimension's `active` list non-empty, which would have flipped an
otherwise evidence-free morning from `unknown` readiness to `ready`.

An audit of directive churn found the suspected bug already fixed — the diff-based reconcile has
churned zero rows since it landed — so the round adds the row-level regression test the old
count-based assertion could never have caught, and migration **v86**
(`directive-soft-resolve-compaction`, no schema change) compacts only the historical pile the
pre-reconcile engine left behind: ~1000 `'markers'`-source rows soft-resolved in 300-a-day bursts for a
handful of live findings. The compaction is deliberately narrow — machine soft-resolves only
(`status_at IS NULL`; a user Done/Dismiss is never touched), exact duplicates only (same directive_key,
text, domain, marker AND trigger snapshot), and nothing a `resurfaced_from_id` audit chain points at —
and idempotent, keeping the earliest `created_at` in each group.

Last, a failed prediction now queues a real step-back instead of only a note. When a change-EFFECT
guard (session feedback, joint pain, est-1RM — never an adherence/completion metric, where a miss is
the athlete's own choice and walking their plan back would be punishment) comes back `not_aligned` on
an applied training change, `queueExpectationRevisions()`
(`src/domain/brain/expectation-followup.ts`) reconstructs the prior prescription field-by-field from
that change's own `brain_rollbacks` before-snapshot — the same compare-and-set Undo uses, so a target
the athlete has since moved is left alone rather than overwritten — and drafts the reverse as an
ordinary proposal through `applyProposalWithAutonomy()`. No agent is called; this is server-policy
actuation, so `decideAutonomyTier` still owns the posture, `lead_mode` still governs, and the step-back
spends the same surprise budget as anything else. One attempt per failed change, ever, recorded on the
decision either way; behavioral metrics queue nothing, and a step-back that itself misses spawns
nothing but the note — a machine revising its own revision is not coaching.

## 2026-07-30 — the brain learns to push and to check its own changes

Three tracks land beside the wearable-truth round below: a day that has actually earned it can now
register as such, applied training changes get their promises checked, and outcome lessons stop
mistaking a stale trend for their own effect.

`src/repo/signal-state.ts` gains a `backed` support tier riding beside the existing five-value
posture enum (untouched, including its safety ranking): `supportState()` earns it only from evidence
in the athlete's OWN lane — `SUPPORT_EARNED_FIELDS` (`session_quality`/`felt_energy`/`sleep_feel`) —
never from a wearable alone, so an absent or junk watch can neither grant nor deny the tier, and
never when anything fresh is pulling the other way. `coach.ts`'s new `SessionQualitySignal` is the
positive half of the autoregulation rollup: the freshest rated session came back strong with no
soreness/joint report since, where before the rollup could only ever say something was wrong or say
nothing at all. `dayRead()`'s `planned_training` rule reads a backed, uncaveated day into
`signals.push_bias`, and `dayReadHeadline()` picks a push-flavored headline/frame off it rather than a
fifth `kind` — `est_minutes` stays untouched, since a backed day is room to reach within the session,
not a reason to make it longer.

The personal-response model gets the same direction. `reaction-model.ts`'s `training_progression_step`
family is the one metric allowed to ACCELERATE its own next step, to a declared ceiling, on a run of
≥2 aligned verdicts with zero misses anywhere in the comparable window and no training symptom on
record; `clampedOverload` (`src/repo/progression.ts`) now honors a modifier above 1 instead of
discarding it. `run_volume_adherence` stays deliberately hold-or-ease — bone and tendon adapt on a
slower clock than an aligned-verdict window can see, so "absorbing the load" is not evidence a bigger
weekly jump is safe, and that ruling from the endurance round is now written down as code rather than
convention.

Eight of the fifteen falsifiable metrics had a registered evaluator and no writer, so the judgement
never ran. `src/repo/brain/change-expectations.ts` writes four predictions against an applied training
change, each only when the athlete is already logging the evidence that could falsify it:
`buildTrainingFeedbackExpectations` (session ratings shouldn't slide, joint pain shouldn't get more
frequent than it already was), `buildLiftProgressionExpectations` (a named lift's est-1RM should hold
within 3%), and `buildHrvGuardExpectation` (a run-volume step shouldn't cost more than a tenth of the
athlete's own overnight HRV — written only for a watch actually producing it). Case-conference
predictions now survive all three paths: a landed or scheduled revision asserts them, a held one parks
them on its own record instead of judging a change that never happened, and
`recordAppliedProposalDecision` (`src/repo/profile.ts`) thaws a parked set with re-based windows the
moment the proposal is finally applied; advice-only conferences keep their predictions live
throughout, since an advisory read is checkable against where the picture actually heads.
`src/domain/brain/expectation-followup.ts` turns a genuine `not_aligned` verdict on a change-effect
metric into one quiet in-app note per DECISION (never per-prediction), which releases itself after
three weeks or the moment the change behind it is no longer in force — nothing reverted, nothing
pushed.

Meal-plan adherence existed nowhere, so a missed weight expectation had exactly one explanation
available — the calorie target — and eased it even when the athlete had simply not eaten the plan.
`mealPlanAdherence()` (`src/repo/nutrition.ts`) classifies logged days against the plan's daily bands
(`followed`/`diverged`/`too_thin`) and confounds the intake→weight evaluator into `inconclusive` on a
clearly-diverged or unreadable window — a followed window adds nothing and simply lets the existing
comparison run; adherence can only take a verdict away, never hand one out.

The nutrition check-in lesson used to score a check-in against a trailing 21-day slope that predated
it almost entirely. `postInterventionWeightTrend` (`src/repo/goal-pace.ts`) fits its slope only over
weigh-ins on/after the intervention date, requires 3 weigh-ins across 7 days before it will speak, and
otherwise defers idempotently — silent, never an error — closing honestly at a 28-day deadline.
`session_suggest` outcomes gain a parallel minutes-drift lesson: three reconciled days drifting the
same way inside a trailing 45-day window produce a calm "size up/down" learning, and a flip in
direction retires its opposite (`writeLearning`, `src/repo/memory.ts`) rather than leaving both live.
Memory's `last_referenced_at` was stamped and never read: `memoryForCoach()` now breaks confidence ties
on it, and the consolidation librarian sees recorded/updated/surfaced dates plus who said each fact,
under an explicit rule that age alone never supersedes and a goal the athlete stated themselves is
theirs until they say otherwise.

Migration **v85** (`day-read-entity-decode`, no schema change) repairs day-read `headline`/`why`/
`focus` prose already stored HTML-escaped (`Push session &amp; run complete`), which the PWA then
escaped a second time on render. `decodeDayReadAgentProse`/`decodeCommonEntities` (`src/dayread.ts`)
decode agent prose on the way in, in one pass with `&amp;` decoded last, and
`isValidDayReadAgentResult` now rejects prose that still carries an entity after that pass rather than
silently double-decoding it.

## 2026-07-30 — grounded wearable truth and an adaptive rest read

Four tracks, one round. Migration **v84** (`garmin-wear-quality-repair`, no schema change) repairs
two classes of junk already sitting in `garmin_daily_metrics`: a `resting_hr` derived from the daily
summary on a day the watch caught no genuine rest window (no sleep record, and no witnessed minimum
HR inside a physiologically plausible 30–65 bpm rest band), and negative "no data" sentinels (`-1`,
`-2`) stored raw across roughly two dozen metric columns. Both classes are idempotently nulled.
`src/garmin.ts`'s ingest now rejects the same junk at the source: `credibleSummaryRestingHr`
(exported) accepts a summary-derived resting HR only when its own witnessing min-HR sample is itself
plausible and low enough to prove real rest coverage — the sleep-derived value always wins when
present — and every non-negative picker (`pickNonNegNum`/`asNonNegNum`) now also guards `min_hr`/
`max_hr`. The bug this closes: a watch worn only in the daytime reported a "resting" HR of 94–118 off
its own daytime minimum (70–78), which then poisoned the 7-day-vs-30-day recovery delta into a daily
false "resting HR elevated" caution.

`src/repo/coach.ts`'s autoregulation rollup (the soreness/low-performance flags feeding
`dayPlanningSignalState`) moves from a session-INDEXED window — the last 4 sessions — to a 7
CALENDAR-DAY one: indexed at 4, a rest read that produced less training meant the flag's own clearing
evidence took longer to arrive, so a low-performance flag could prolong the very rest posture that
produced it. 0-set sessions no longer count toward either rated signal (an opened-and-abandoned row
is not a report on how training felt), a later good session (performance ≥4, soreness ≤2) clears an
earlier flag inside the window instead of waiting for it to age out, and each flag's observation dates
to the offending SESSION, never to "now".

`src/repo/brain/read-adherence.ts` gains `restOverrideSoftening`: when 3 or more of the last 10 closed
days offered a rest (or already-softened easy) morning that the athlete trained through anyway with
nothing in session feedback suggesting it cost them (worst-of-day performance ≥3, or unrated — silence
is not evidence of harm), the next non-clinical rest read softens one notch to easy, via a new
`outcome_feedback_soften` rule outcome. Softening is scoped to exactly the four accumulation-style
rest codes in `SOFTENABLE_REST_CODES` (`accumulated_load_rest` / `low_readiness_rest` /
`felt_run_down_rest` / `acute_signal_protection`); `acute_sleep_corroborated` and
`recovery_dose_overrun` stay excluded as fresh 24-hour facts history cannot argue with, and
`clinicallyDriven()` — probing an active constraint item, the arbitrated `source_dimensions`, and the
`health_constraints` dimension's own status — is an absolute floor regardless of which rule fired.
Push-direction logic has to live in these deterministic rules to have any effect at all, since
`enforceDayReadSafetyPosture` clamps away any agent-side upgrade of a rest baseline. A softened easy
morning trained through without harm counts as the SAME evidence restated, so the pattern keeps
accumulating once active instead of self-extinguishing the moment rest mornings stop appearing; an
honored rest or an honored softened-easy morning resets the count. `signals.outcome_feedback` now
publishes `{...RestOverrideSoftening, applied}`, and the day-read prompt site
(`src/prompt/context-projection.ts`) gains a compacted `read_adherence` block (`compactReadAdherence`,
capped to the recent window) — the one prompt allowed to see it, since the Brief is the very read
being measured.

`src/repo/recovery-menu.ts` (new) builds a derived, never-persisted menu of 2–3 low-key recovery
options (easy spin / walk / mobility / core) for a rest or easy Brief, so a quiet day never reads as a
void. Grounded in recent muscle load and steered clear of any active training symptom via a gentler,
symptom-guarded phrasing variant; wording rotates through `pickDayVariant`. `attachDayReadContext`
(`src/domain/brain/day-read-use-case.ts`) computes it fresh on every response — same precedent as
`forward`/`arc` — and only for a read date on or after today, since a routed past date would invite a
session that day is already over for. `public/styles.css` and `today-brief-client.ts` render the menu;
`sw.js` bumps to `cairn-v536`.

## 2026-07-28 — pain-aware daily authority and calm lifecycle feedback

No schema change. The versioned daily-session decision now fingerprints its policy identity, ordered
training priorities, and the rolling run agenda's next genuinely open key-run window. Flexible-agenda
completion and deliberate undating are authoritative over a fixed template, quality detection
recognizes the generated plan's real labels/zones, and a quality-bearing long effort closes the
long-shaped intention before it can leave duplicate long work open. Day-read cache identity includes
that movable lookahead truth, and dated prompts resolve effective home/travel location for the date
being coached.

Pain protection applies to cardio labels as well as stored strength exercises and the composition
normalizer fails closed when active exclusions cannot certify an unknown cardio item. The finished
session replaces its dense movement-note form with the compact Atelier **Pain & injury** lifecycle:
active notes lead, pain-free and pain-present share equal neutral actions, reporting and exact-movement
recurrence stay collapsed until requested, and resolved history remains one quiet disclosure. No
score, diagnosis, plan mutation, or fabricated movement evidence is introduced.

## 2026-07-28 — durable home location with temporary travel overrides

Migration **v81** adds nullable `profile.home_location` as the athlete's durable, manually entered
home base. The Profile UI can set or clear it without browser geolocation or a daily current-place
picker. Travel remains a dated `context_event`: only an active, unarchived, unresolved trip with an
optional `meta.location` temporarily becomes the effective coaching location, while upcoming/past
trips stay on the timeline and never overwrite home.

`location-context.ts` owns the deterministic read and projects a compact home/effective/source/trip
block into coach context and every person-aware prompt. A home-location change invalidates current
coaching identity, and the date-keyed read naturally changes at trip boundaries. The block explicitly
marks weather unavailable and location as context-only; this round adds no weather provider,
geolocation request, score, or gate. REST inherits the profile field, MCP `set_profile` documents it,
and the PWA explains the optional trip override (see `public/sw.js` `CACHE` for the live precache stamp).

## 2026-07-28 — terrain-aware hybrid scheduling and movable run intentions

No schema change. The endurance ontology now preserves the legacy run/ride/swim/row/walk families
while distinguishing trail/XC MTB, downhill/lift-served MTB, road, gravel, generic cycling, alpine
skiing, Nordic skiing, touring, and generic skiing. Capability evidence is mode-specific: a road
ride or lift-served downhill day cannot prove a two-hour trail-MTB capability, while a generic
cycling goal may still use any cycling subtype. Terrain-aware hybrid load accounts for climbing,
technical descending, eccentric demand, trunk/back/grip work, and the different aerobic character
of each skiing mode without inventing a subtype from the word "skiing."

`flexibleTrainingAgenda()` turns the deterministic run plan into weekly intentions reconciled with
reality. Actual runs close one compatible easy/quality/long intention regardless of exact weekday;
quality requires intensity evidence, cross-training affects load without completing a run, and
actual lower-body or hard-cardio work moves key-run guidance toward a cleaner opening. Supporting
endurance is capped at three runs in a normal week and two with proportionally lower, exposure-capped
volume in a constrained week; a stretch race time cannot add volume. Remaining openings are allocated
once across the agenda, so key runs cannot stack onto one day; work that no longer has a clean opening
stays undated and creates no catch-up debt. Coach context and prompts receive this rolling read, treat
plan days as provisional anchors, and never call moved work missed or prescribe catch-up volume. REST/MCP/PWA
surface the same agenda, and coaching caches now fingerprint the material training, goal, symptom,
context, recovery, and daily-decision state so same-day changes cannot leave old guidance in place.

## 2026-07-28 — ordered training identity and sport-specific capability

Migration **v80** adds nullable `profile.training_intent_json`: ordered durable priorities
(`longevity | muscle | leanness | strength | endurance`), an explicit endurance role
(`none | supporting | co_primary | primary`), and an optional sport-specific duration capability.
Null retains the legacy-derived discipline/goal-mode behavior, so upgrades are backward-compatible.
The coach context, prompt projection, conductor, and whole-person trajectory now follow this
athlete-owned order instead of assuming every `hybrid` profile means co-equal goals. Age informs
the long view but never becomes an automatic brake; actual recovery, performance, soreness,
joint/tendon feedback, training history, and life context determine dose.

`getEnduranceCapacity()` reads matching logged activities to describe a capability as ready,
building, rebuilding, or not yet observed without changing the plan. Dated races stay in the
existing `endurance_goal_json` as temporary overlays and now appear on the forward timeline; a
supporting race can shape a run build but cannot silently demote higher durable goals. Profile,
REST, MCP, and Chat share the same normalized contract. Invalid calendar dates are rejected
without clearing a valid event already on file, and session-suggestion caching includes profile
goal identity so a same-day change cannot serve the old plan.

## 2026-07-27 — bounded recovery overlays, movement-scoped symptoms, outcome learning v2

Three additive ledgers establish the non-destructive recovery/learning substrate without changing
`user_version`: `recovery_cycles` owns scheduled → active → recheck → exit-review calendar windows
and immutable overlay JSON; `training_symptom_events` keeps pain explicitly open/resolved with
legacy session feedback normalized as unconfirmed; and `movement_tolerance_observations` records
only stated relevant pain-free/pain-present exposures. A recovery adapter copies a selected plan
day into an easy roughly half-volume prescription while leaving `plan_items` untouched, calendar
exit prevents inactivity from extending a cycle, every working load is eased even on a one-set day,
the overlay accepts only a small normalized scalar allowlist, cooldown prevents repeats, legacy date-only/v1
recovery stamps remain readable, and blind program-block week advancement pauses only during the
active/recheck window. Two relevant pain-free exposures make a movement `trial_ready`, never
resolved; an explicit recurrence starts a new evidence epoch and clears the named movement (or all
movements when unknown) without deleting history, while unrelated movement and null feedback do nothing. Injury expected-window expiry plus a
bare later workout now asks for a movement-specific soft recheck rather than silently inferring
resolution or extending a whole-program reduce-load flag; fresh/recurred injuries remain
protective.

`daily_session_outcomes.facts_json` is now additive schema v2: stable composition-item, movement,
and intent identity; complete prescribed/achieved set dose; whole-challenge verdict; and explicit
recovery/override/travel/illness/symptom/endurance/partial context. Every set/skip/reopen/finish/
feedback mutation and same-date manual/Garmin activity insert, update, or delete refreshes it
best-effort. Active movement-relevant symptom-ledger evidence is included even when legacy
`sessions.joint_pain` text is absent. The bounded `recentMovementResponse()` read requires
two comparable completed moderate/high-confidence outcomes for the same movement/intent and emits
only insufficient/contradictory/earned-absorbed/earned-hold; only the two newest comparable
exposures decide, while older matches remain counted for inspection. Recovery doses and confounded work stay
visible but cannot become evidence for another structural deload. Progression and daily-composition
consumption remain explicit later integration hooks.

## 2026-07-25 — meals remember when they were eaten, one food-capture contract

A three-commit round on the food-capture path: the log finally distinguishes when a meal happened
from when it was typed, and the three surfaces that ask an agent to describe a meal stopped
drifting into three different shapes.

**(1) `food_notes` gained a time, not just a day.** Migration 79 adds nullable `food_notes.eaten_at
TEXT` — a LOCAL wall-clock `"HH:MM"` (24-hour) sitting beside the existing LOCAL `date` column,
deliberately not a UTC instant: `date` already owns which calendar day a meal belongs to,
`created_at` already owns the UTC instant of the WRITE, and `eaten_at` owns only the clock reading
inside that day, so the three can never disagree about which frame they're in.
`resolveFoodNoteWhen`/`canonicalFoodNoteWhen` (`src/repo/nutrition.ts`) are the one trust boundary
REST, MCP and chat all pass through: a stated `date` is checked against the future and a
`MAX_FOOD_BACKDATE_DAYS` (365-day) ceiling — generous on purpose, since backdating IS the point ("I
remembered what I ate last night") and the only real risk is a mistyped year — and a stated
`eaten_at` is checked by the new `normalizeWallClock` (`src/repo/shared.ts`), which accepts only a
24-hour wall clock and deliberately rejects a 12-hour one rather than guess which half of the day
was meant. The boundary is `lenient` by default (a bad value is dropped with a `console.warn` and
the row still saves on today/no-time) but the REST routes opt into `lenient:false` — a person
typing a date into a form deserves a 400 with the reason, where a model that mis-resolved "last
night" out of a sentence should never lose the whole meal over it. `addFoodNote`/
`addChatCaptureFoodNote` take the same optional `date`/`eaten_at` behind a trailing options object,
so every existing positional caller is unaffected; `updateFoodNote` can now MOVE an entry to
another day (undefined leaves both fields alone, so fixing a macro never restamps the clock, and an
explicit blank `eaten_at` unstates a time that turned out to be wrong) and — because a day move
changes two days, not one — invalidates and emits `food_corrected` for BOTH the day the entry left
and the day it landed on, which `invalidateDayReadForDate`'s single-date signature couldn't do on
its own.

Only one direction of inference is allowed, and the code says so explicitly: a stated TIME may name
an unstated meal LABEL (21:00 → dinner, via the new `mealLabelForTime`/`MEAL_WINDOWS` in
`src/repo/shared.ts`, nested inside `partOfDay`'s own hour buckets so the two vocabularies can't
contradict each other) — that direction is honest because a label is a category. The reverse never
happens: a stated label is never turned into a stored clock time, because `eaten_at` is rendered
straight to the athlete, and a derived "12:30" from the word "lunch" would be indistinguishable —
on screen, in the coach prompt, to the brain correlating intake against bloodwork — from a minute
the athlete actually said. `getDayIntake` now reads a day back in EATEN order rather than insertion
order (a backdated dinner would otherwise sort after today's breakfast, and a day would read as the
sequence in which things happened to be remembered) via a three-tier, read-time-only sort key —
stated `eaten_at`, else the label's representative hour via the new `approxTimeForMealLabel`, else
the last placeable row's carried-forward position — computed fresh on every read and never written
back or shown. The displayed `logged_at` prefers the stated time (formatted through the new
`clockLabel`, matching `chatHistoryTimeLabel`'s own register so both clocks read identically in one
list) over the write-time label, because for a backdated entry `created_at` is when the meal was
REMEMBERED, not when it happened; `eaten_at` rides alongside it raw so a reader can tell which of
the two clocks `logged_at` is actually showing. `frequentFoods()` now bands on the eaten hour the
same way, so a late dinner logged the next morning stops polluting the breakfast-time frequents.

**(2) The chat agent resolves "last night" itself.** The chat `log_food`/`update_food_note` actions
(`src/chatActions.ts`) gained optional `date`/`eaten_at`, resolved by the model against the local
clock it already receives via `DATA.now` — "last night" (yesterday, late evening), "this morning"
(today, early), a bare clock time (today unless the sentence points elsewhere). The model is told
never to ask what time it was: an entry with no stated time is ordinary, and approximating from
what WAS said ("a late dinner" → about 21:00) is right where interrogating for a number is not.
This has to be gated at the ROUTING layer, not just the prompt: `completeInstantFoodCapture` is a
zero-agent receipt path ("just had a protein shake" → save immediately, no CLI round-trip), so it
can only ever stamp today with no time — exactly wrong for "I had a late dinner last night around
9". `mentionsWhen()`/`MENTIONS_WHEN_RE` (`src/chatTurns.ts`) is a deliberately coarse "does this
sentence place the meal in time at all" gate (named days, elapsed time, clock times, calendar
dates) that disqualifies the instant-capture bypass the moment it fires, sending the turn to the
full agent lane instead — erring toward the extra round trip is cheap; erring the other way writes
the wrong day into the log. Both `log_food`'s direct write and the photo lane pass `lenient: true`
through to the repo, and the coach prompt (`renderTodayFuel`, `src/prompt/shared.ts`) now says
"eaten at" or "logged at" explicitly rather than one unlabeled `at`, so the model reading its own
context can't confuse the two clocks either.

**(3) One food-capture contract, not three.** Free-text enrichment, the chat `log_food` action and
the plate-photo vision read each declared their own JSON shape for a meal, and had drifted: chat
never asked for `nutrition_pattern` at all, the photo path — where the portion is INFERRED and
structure matters most — never asked for ingredient rows, none asked for ingredient-level fiber,
and only the photo path carried any provenance. `src/foodCapture.ts` declares the shape ONCE:
prompt fragments (`FOOD_INGREDIENT_SCHEMA`, `FOOD_NUTRITION_PATTERN_SCHEMA`,
`FOOD_PROVENANCE_SCHEMA`, `FOOD_CAPTURE_GUARDRAILS`) interpolated into all three prompts, and the
coercion every path runs a returned payload through — `coerceFoodIngredients`/`coerceFoodItems`
(quantity is a FIELD, not prose folded into an item name), `foodMacroTotalsFrom` (builds a meal's
totals up from its ingredient rows when the agent gave no top-level number, so fiber stops being a
top-down guess — a stated total still always wins), `coerceFoodProvenance`/`coerceNutritionPattern`,
and `clampFoodMacro`. `normalizeFoodCaptureParsed` builds the blob for a path that stores an
agent's estimate DIRECTLY (chat's `log_food`, and the photo seed a vision-capable chat agent
already produced); the two background enrichers in `enrich.ts` (`applyFoodPhoto`,
`applyStructured`) MERGE over an EXISTING blob and so apply the same coercions field-by-field
instead. `enrich.ts`'s own former copies of `coerceNutritionPattern`/`macroTotalsFromItems`/
`photoItemLabel` are gone, re-exported from the one module instead. Every entry now carries
`confidence` (low/medium/high) and `basis` (`label`/`user_report`/`estimated_from_foods`/`photo` —
the same vocabulary `nutrition_pattern` already used, now shared), and every capture path supplies
its own honest `fallbackBasis` (chat's unlabeled estimate defaults to `estimated_from_foods`, never
`user_report`, unless the athlete actually stated a quantity), so an estimate can never read as a
measurement. Chat is roughly two-thirds of all logging, so this is the first round in which
`nutrition_pattern` — the field that lets intake be correlated against a blood panel — actually
reaches most meals. **Capture depth is deliberately greater than display depth**: the richer
per-ingredient and pattern data exists to feed the brain and correlate intake against bloodwork
(sodium↔BP, saturated fat↔LDL, added sugar↔HbA1c, iron↔ferritin, omega-3↔inflammation), not to be
rendered — the UI shows a meal name, macros, and now an optional time; nothing here decides what a
surface displays.

## 2026-07-25 — the day read learns to be wrong, structured-output enforcement, ledger repair + prose polish

A five-commit round closing two different kinds of accountability gap, plus a handful of
independent prose fixes.

**(1) The morning read finally predicts something.** The brain writes a decision every time it
reads the day — 294 of the 354 rows in the live ledger — and not one of them carried an
expectation, so the loop's single most frequent judgement could never be checked and could never
teach anything, while the sharpest feedback available sat unused: over 41 mornings the read said
rest on 21 and the athlete trained anyway on 11 of them. `src/repo/brain/read-adherence.ts`
attaches a falsifiable `day_read_adherence` expectation to every `train`/`easy`/`rest` read (never
`done`, which acknowledges work that already happened and predicts nothing) with a SAME-DAY window
that matures the next morning — unlike every other expectation in the ledger, which waits one to
four weeks, which is exactly why this one is worth having. `dayTrainingTruth(date)` grades a
calendar day's log the same way `dayRead()` itself does (discipline-aware `dayLoad` plus the
hard-cardio bump); `readAdherenceOutcome()` is the one shared followed/diverged/unclear test (a
`train` read is followed the moment ANY training is logged, no bar for how hard or close to the
suggestion — inventing one would be a graded judgement about the person). `writeDayRead()`'s
ledger write moved into `recordDayReadDecision()`, whose identity is the read's own decision
fingerprint (kind/focus/override plus the existing `dayReadInputFingerprint`) rather than the
whole mutable `signals` blob the old inline write compared — which moved all day and produced ~19
immutable rows per calendar day, 18 of them immediately superseded. Because training data
genuinely arrives late (a Garmin activity syncs after the fact, strength reconciliation attaches
work to a day well after it closed) and a missed re-judgement can only ever turn a real divergence
into a stale "followed" — never the reverse — `reopenDayReadAdherence()` (wired into
`invalidateDayRead()` for any past date) re-opens a judged same-day verdict only when the day's
logged facts actually moved; `TERMINAL_ONCE_EVALUATED_METRICS` +
`isTerminalOnceEvaluated()` (`src/brain/expectation-contract.ts`) keep every OTHER
already-evaluated same-day row out of the nightly candidate pool so it can't grow one row a day
forever, and `evaluateMatureExpectations` closes a reopened row again the instant a re-probe lands
the same answer. `readAdherenceModel()` surfaces the rolling counts (never a rate, never a score)
in operator diagnostics and an optional coach-context key wired into no prompt site;
`getBrainDiagnostics()` also gained an unwindowed `expectation_health` block (pending /
matured-but-unevaluated / evaluated / verdict mix / oldest overdue / ever-conclusive), because the
existing 90-day aggregate is blind to a ledger that has produced dozens of pending rows and zero
conclusive verdicts in its entire history. `getProgress()`, `getRecentSessions()`,
`estimateExpenditure()` and `trainingSignals()` each gained an optional historical horizon
(`through`/`asOf`) so a read of an earlier date can no longer observe sessions or trend logged
after the day it's reading — the same defect that once told a day inside a recovery week its reset
was months overdue, now closed for the producers underneath it too. Riding along: `test/_seed.js`'s
`seedTrainingDay`/`seedRecoveryDay` now drive `repo.logSetByName` instead of inserting
`logged_sets` directly, so a test asserting on `invalidateDayRead`, the `set_logged` brain event, or
`completeStrengthObjectiveFromLoggedSet` exercises the real write path instead of a fixture
artifact.

**(2) The suggestions ledger stops lying about how many times a day was read.** Before
`recordDayReadSuggestion()`'s dedupe guard existed, every Brief open re-recorded the day's
canonical suggestion, so a read that legitimately evolved across a day (morning rest → the athlete
trains → train → done) piled up one row per re-open while looking exactly like a single morning
suggestion — on live data June averaged 6.6 rows per date against July's 1.1, and seven dates
recorded all three readings at once. Migration 78 backfill-dedupes the history to the earliest
canonical row per date (steered rows are untouched — the athlete can genuinely steer twice in a
day), verified idempotent and byte-identical on the morning distribution before/after. The live
guard hardens from a `payload_json LIKE '%"override":null%'` substring match — silently defeated by
any whitespace change in the serialized payload — to `json_extract(payload_json,'$.override') IS
NULL`, now pinned by a regression test against a pretty-printed payload.
`repo.dayReadSuggestionsByDate()` is the one-row-per-date reader so future analysis cannot
reintroduce the same trap.

**(3) Four rough edges in athlete-facing prose.** `joinList()` (Oxford comma) replaces raw
`.join(", ")` everywhere a list reaches a person — the joint-pain voice read "your left knee, right
shoulder"; plan-selection (which feeds the Brief's `why` directly) had independently drifted the
same way. The finish-session response now carries a real, server-rotated headline instead of the
client hardcoding "You're done for today" (a client-side variant set was rejected: `pickDayVariant`
is a pure function of date and key, so a client reimplementation could diverge from the server's
and flicker between paints). The meal-plan prompt now renders the coaching focus it was already
being handed — every other prompt builder rendered it; `nutrition.ts` alone paid for the projected
key and did nothing with it. The no-score grammar rule no longer rejects a factual percentage of a
real quantity: "you're at 80% of your protein target" passes; "Readiness 38%" and "you scored 42%"
still fail.

**(4) Declarative structured-output enforcement.** The agent JSON contract was requested in prose
and recovered by `extractJson` scraping stdout for the first `{` — a model that narrated before
answering broke it by luck, not by guarantee. Three of the four CLIs can enforce it instead.
`agents.json` gains a `structured_output` block per provider (flag template, `arg:
"inline"|"file"`, optional `envelope`) expanded only at an explicit `{schema_args}` slot,
mirroring `{model_args}`/`{reasoning_args}` — verified against each CLI's own `--help`: claude
takes inline JSON, codex takes a file path (so `runAgentImpl` writes a `0600` temp file per run,
removed on every exit path), grok's flag implies `--output-format json` so its payload arrives
wrapped in a telemetry envelope that must be unwrapped before `extractJson` ever sees it (its
`thought` field would otherwise leak raw reasoning into the operation), and antigravity has no such
flag and keeps the prose path. Degradation is mandatory: a missing declaration, an argv template
without the slot, or a filesystem error all fall back to the prose contract, so
`runAgentWithFallback` keeps working across agents of mixed capability. The schema for each strict
operation is declared ONCE, in `src/agent-contracts.ts` beside its acceptance predicate
(`PLAN_PROPOSAL_SCHEMA`/`WEEK_AHEAD_SCHEMA`/`MEAL_PLAN_STRUCTURE_SCHEMA`/`MEAL_SWAP_SCHEMA`), and
the new `src/json-schema.ts` — a deliberately small evaluator covering only the keyword subset
these contracts use — runs that same object as the predicate's structural conjunct, so the
enforced schema and the accepted shape cannot drift apart. Every object node declares
`additionalProperties: true`: constrained decoding silently drops any field a schema omits
(verified live against claude and grok), and these payloads carry far more than acceptance checks
read. Applied only where the contract is one strict, non-union shape — proposal, `evolve_program`,
`week_ahead`, `meal_plan`, `meal_swap` — and deliberately not chat (prose-first, a schema would
destroy it), not the streaming path (no `{schema_args}` slot in any `stream.args`), and not the
bounded coach-read loop (`runChosenWithCoachReads` never forwards a schema, because a turn there
may legitimately be either the op's contract or a `coach_read` query, and the enforcing CLIs reject
a top-level `anyOf`).

## 2026-07-25 — day-read self-consistency: one signal state, cause-labeled caveats, a shared reading grammar

A two-strand round on top of the same day's earlier one, closing gaps its own new machinery exposed.
**(1) The read stopped contradicting itself.** `UnifiedSignalState.action.directives` gained
`training_source` (`src/repo/signal-state.ts`): which `SignalDimension` — recovery, accumulated load,
health constraints, or fueling — actually produced a `hold_aggression`/`modify`/`recover` directive,
via one ordered precedence chain (`planningDirectives`'s `rungs`) that replaced a nested ternary so the
verdict and its cause can no longer drift apart. The Brief's hold-aggression lead
(`src/repo/day-read.ts`) now speaks that dimension's own `voice` instead of `action.voice`, which on a
ready/train day is drawn from SUPPORT evidence — so a hold day used to tell the athlete they slept
fine and then ask them to hold, naming nothing they were holding for. `training_source` is deliberately
NOT hashed by `dayReadInputFingerprint`, which now selects `signal_action.directives` field-by-field
rather than spreading it whole (the same brake changing hands between two dimensions is not itself a
new decision; every input that CAN move it is already hashed elsewhere). A second latent conflation —
`directives.schedule === "compress"` firing for either a real dated commitment or
`context.expect_worse_sleep` (a late night, thinner recovery, no clock pressure at all) — had two
independent copies of the discriminator drifting into two different answers; `lifeCapacityIsCommitment()`
(`src/repo/signal-state.ts`, reading the arbitrated dimension's own `voice.key`) is now the one shared
test, so only a real commitment earns the Brief's time-window caveat and its 60→40 `est_minutes` clamp,
and the conductor gained its own life-pressure caveat/card for the other cause. All ten planned-training
caveat fragments (recovery-week dose, an injury or session-reported joint pain, a generic ease-around, an
anticipated deload, a volume spike, chronic low sleep, hold-aggression, and the commitment/life-pressure
pair above) are now rotating sets (`DAY_READ_CAVEAT_VARIANTS`/`DAY_READ_CAVEAT_CONCEPT`,
`src/repo/day-read.ts`) instead of single hardcoded clauses spliced behind a rotating lead. The
conductor's own work-around caveat is now chosen by CAUSE rather than by posture — `modify` is reached
from unrelated causes (health, fueling, or an arbitration tie-break), so keying prose off the posture
alone produced injury-shaped sentences ("work around IT") on fuel and sleep days where "it" named
nothing; `caveatCause()`/`CAVEAT_INSTRUCTIONS`/`CAVEAT_CAUSE_LABEL` (`src/repo/coaching-focus.ts`) pick
the most-severe dimension and publish its label as the new `CoachingFocus.caveat_cause`, and
`src/prompt/shared.ts`'s `caveatLine()` reads it instead of hardcoding "(injury/soreness)" at both call
sites — which had been announcing four of five causes to the model as an injury that did not exist. The
caveat text — the safety instruction — is now appended WHOLE by a `joinCaveat()` budget that clips only
the producer's own `why` to fit, instead of clipping the joined string and silently eating the
instruction off the end. Hygiene riding along: `.sr-only` (`public/styles.css`) was added — a class
`settings-agents-client.ts` already referenced but that had never actually been defined —
`clearDirectivesForSource` (dead code post-`reconcileDirectives`) was deleted, and
`CHAT_TURN_RETRY_TTL_MS` (`chat-turn-records-client.ts`) is now the single source for the retry
envelope's lifetime instead of a duplicated literal in the composer. `sw.js` → `cairn-v523`.

**(2) The read stopped claiming more than it knows.** `dayRead()`'s own fallback used to build a
materially THINNER signal state than the one `getCoachContext()` built for the coach prompt — omitting
`trainingSignals` (joint pain, the low-performance flag) and `programState` (an anticipated mesocycle
reset), both carrying `safety_override` constraints — so the Brief could say "train" on a day the coach
context had already gone `rest`/`recover` with `health_constraints` and `load_tolerance` both
constrained. `dayPlanningSignalState()` (`src/repo/day-read.ts`) is now the ONE builder of
`UnifiedSignalState`, memoized per `(date, request)` under the same brain-snapshot key
`getCoachContext()` already used; `coach.ts`'s `getCoachContextFromSnapshot` calls it instead of a
second local `planningSignalState()` build, so the Brief, the coach context, the server-policy clamps
and the persisted `signals`/`input_fingerprint` describe one state within a request. `programState` is
now keyed to the DATE BEING READ rather than to "now" — reading an earlier date used to report a
mesocycle measured from today, telling a day inside an applied recovery week that a reset was months
overdue. Outside a request scope (the scheduler's warm run) `computeDayRead` (`src/dayread.ts`) now
threads its own baseline into `buildDayReadPrompt(ctx, {…, baseline})`, which used to recompute a SECOND
baseline from `context.signal_state` — closing the rich/thin seam where the agent was shown one state
while the server clamped, persisted and fingerprinted a different one. Sleep evidence split into two
observations that used to be one: `sleep_night_short`/`sleep_night_ok` (`src/repo/signal-state.ts`) now
speak only for the latest DATED night, and a separate `sleep_trend` observation (voiced through
`sleep_short`, at `caution` rather than a day-owning severity) exists only when the multi-night
`avg_sleep_min` average is genuinely short — previously a single short night, read off the same field a
chronic vocabulary key, produced "short nights have been stacking up" directly above a signals row
saying sleep was normal. `src/prompt/day.ts` gained a matching guardrail (a `ONE NIGHT IS NOT A TREND`
line) so the agent can't narrate last night as a pattern unless `low_sleep` backs one. Readiness's
`max_age_days` dropped 3 → 1 (a three-day-old subdued reading was still forcing an easy read voiced as
this morning's, since the protect rule leads off posture alone, with no gate on the reading's own age),
and the word "fresh" came out of its sentences to match. The felt-energy observation's machine-facing
`summary` was rewritten out of second person and out of handing the model a verdict ("rest is the smart
call") where the contract promises an observation. `violatesReadingGrammar()` (`src/repo/day-read.ts`,
the four rules — no engineering vocabulary, no device/clinical jargon, no score, no gate language) now
binds the AGENT's `headline`/`why` too (`isValidDayReadAgentResult`, `src/dayread.ts`), not just the
deterministic vocabulary that was already written to it — the athlete's actual morning sentence had been
held to nothing. `dayReadHeadline()` — the most prominent string on the Brief — was unified from three
separate implementations (a `dayread.ts` literal, a byte-identical copy in the day-read use case, and a
hardcoded `"Take it easy."` inside the recovery-week clamp) into one, rotating `DAY_READ_HEADLINE_VARIANTS`
by calendar day like the rest of the vocabulary; `agent_conservative_adjustment` joined
`DAY_READ_POLICY_REASON_VARIANTS` for the same reason (a hand-written literal that the rotation had
missed). `src/prompt/shared.ts` + `context-projection.ts`: a conductor item whose `day_posture` is set
carries the Brief's own sentence verbatim in `why` — which had been leaking straight back into the
prompt as "the conductor's focus" even though `day_read` is dropped from every site for exactly this
kind of parroting. `compactCoachingFocus()` now strips that `why` and `renderCoachingFocus` substitutes
a `GROUNDS: …` line from `based_on` instead, on every site that carries `coaching_focus`; a non-posture
item's `why` is untouched, since there it can carry the conductor's caveat verbatim. Lastly,
`clipText()` (`src/repo/shared.ts`) replaced seven independently reimplemented "trim to N chars"
helpers (`attention.ts`, `coaching-focus.ts`, `forward-timeline.ts`, `learned-timeline.ts`,
`team-week.ts`, `today-agenda.ts`, `training-milestones.ts`), each option combination preserving its
caller's exact prior output including each one's own pre-existing quirks, and `selectionReason()`
(`src/repo/plan-selection.ts`) turned the adaptive plan-day picker's single literal override-reason into
the same kind of rotating, second-person fragment set as the rest of the Brief's vocabulary.

## 2026-07-25 — day-read accountability + prose variety, per-op execution profiles, prompt context projection, Today lead arbitration

A four-strand round. **(1) The day read grew a ledger, a voice, and a softer
answer to chronic short sleep.** A chronically short sleeper used to be told to
rest outright: the old `earned-rest` rule folded a <6h rolling sleep average into
the same trigger as a recovery-dose overrun or three stacked loading days, with
no way to distinguish "acute and corroborated" from "chronic but nothing new
today." Now a fresh short night only forces rest when a short rolling average
corroborates it (`acute_sleep_corroborated`); the chronic-only pattern was pulled
out of `earned-rest` entirely and instead rides as a caveat on a due plan day, or
— when nothing's programmed — surfaces its own `chronic_sleep_watch` **easy**
read (never rest), demoted below `suggested-plan-day`. A chronically short
sleeper is now offered their due session, with a caveat, instead of a rest read
they didn't ask for. Underneath that behavior change, a `DayReadRule` now
resolves to `{outcome, read}` where the outcome carries both a stable machine
`code` and the athlete-facing `reasons` (`src/repo/brain/day-read-rules.ts`);
before this round a rule was just `{name, resolve}`, and `resolve()` built and
returned the whole `DayRead` itself with one hardcoded `why` literal baked into
its body — `name` was documentation only (never read at resolution time), so no
rule had any identity that survived past resolution and there was nothing an
accountability ledger could key on. Reads now persist a `decision` block
(`rule_code`, `basis`, `baseline_kind`, `reason`, bounded `evidence`,
`computed_at`), and the server-policy clamps in
`src/dayread.ts` (`enforceCompletionContract`, `enforceDayReadSafetyPosture`, plus
the new `enforceRecoveryWeekCadence`, which stops a recovery week from stacking
consecutive rest days) each write one through a shared `policyDecision()` helper.
Because a stable input fires a stable rule, every athlete-facing string became a
SET of phrasings rotated by `pickDayVariant(variants, date, key)` — deterministic
and offline, same day ⇒ same text, consecutive days always differ — across three
vocabularies (`DAY_READ_OUTCOMES` reasons, `DAY_READ_WHY_VARIANTS`,
`DAY_READ_POLICY_REASON_VARIANTS`), with `DAY_READ_REQUIRED_CONCEPT` pinning the
one idea each rule's words must carry so a new variant can't drift from its
meaning. `recentDayReads()` + `dayReadContinuity()` give the Brief cross-day
memory (`quiet_streak`, yesterday's kind/rule/why, `repeat_of_yesterday`), which
both the deterministic floor (varying words, escalating a long quiet stretch to
"the smallest thing worth doing") and the agentic layer now read. Cache
invalidation became fingerprint-aware: `dayReadInputFingerprint()` hashes only the
PREDICATES the rules branch on (short sleep, low readiness, anticipated deload,
volume spike) plus whole athlete-entered context, so a mid-day watch sync no
longer discards a warm agentic read and burns a `brain_decisions` row for a
decision that never changed; an overridden cached row is replaced through the
compare-and-swap `replaceStaleDayReadOverride()`. A `curated` read (the demo
seed's hand-authored Brief) is now served as written instead of being overwritten
by the deterministic floor on first open.

The day read's dominant rest/easy path also stopped talking about the athlete in
the third person. The protect posture (`acute_signal_protection`) used to hand
`action.reason` — `evidence[0].summary`, third-person evidence prose written for
coaches and machines ("The athlete feels poorly recovered despite any wearable
reading.") — straight to the Brief's headline `why`, the loudest line on the
screen, printed verbatim every morning a stable check-in fired the same branch.
`SignalObservation` (`src/repo/signal-state.ts`) now carries an optional `voice`
alongside `summary` — a small `{key, subject?}` reference, not sentences, so
`UnifiedSignalState` stays cheap enough to keep riding in every prompt payload —
and the new `SIGNAL_VOICE` registry holds 38 keys / 114 second-person phrasings,
each with its own `concept` regex beside the prose (the same no-parallel-map
contract as `DayReadRuleOutcome`). `action.voice` is always set, the
athlete-facing counterpart of `action.reason` drawn from the same winning
evidence, and degrades by posture — never to `summary` — when that evidence
carries no voice of its own.

The same third-person defect lived a tab away, too — not beside the Brief on
Today (which already suppresses the conductor's day-posture lead there as
duplicate narration once the Brief has printed it), but on the "Where to focus"
conductor card: Stand's overview (`coachingFocusCompactHtml`), Me → Health →
Standing (`#cfocusStandingSlot`), and Progress → Program
(`coachingFocusCardHtml`) were all rendering `lead.why` from the same
`action.reason`/evidence `summary` the Brief used to. `spokenSignalVoice(ref,
date, key)` (`src/repo/signal-state.ts`) is now the single rotation contract
both surfaces call — the Brief's protect rule and the conductor's daily-posture
lead, fueling caveat and schedule caveat (`src/repo/coaching-focus.ts`) — keyed
by the shared `SIGNAL_VOICE_KEYS` (`protect`/`injury`/`fueling`/`schedule`) and
rotated on `UnifiedSignalState.date`, deliberately not a second `today` threaded
through `CoachingFocusInput`, so the same signal reads as the same sentence
wherever it surfaces rather than two differently-worded notes about one morning.
`SignalDimensionState.voice` now sits beside each dimension's `reason`, for the
conductor's parallel fueling/schedule cards, which speak to one dimension rather
than the day's whole posture. The shared active-injury caveat that closes every
protective read got the same treatment, and stopped naming the injury twice: it
used to splice `summary` behind a fixed lead-in ("…around the active injury:
Achilles tendinopathy: an active injury is worth easing or working around."),
with a "must" that read as a gate rather than a suggestion; it now speaks the
injury's own name once, in register, through `SIGNAL_VOICE` — an injury
lowercases into the sentence ("your shoulder strain"), while an illness or a
dated commitment keeps its own case, since lowercasing those produced a bare
noun phrase missing its article ("you're working through head cold"). `summary`,
`action.reason`, `action.reasons`, every dimension `reason`, and the conductor's
`based_on` provenance trail are all unchanged — `renderSignalState`, the coach
context and the model still see exactly what they saw before.

**(2) Per-op model/effort profiles (migration v77).** `TASK_EXECUTION_PROFILES`
(`src/repo/settings.ts`) is the sibling of `TASK_POLICY`, keyed by the same
`taskForOp` class: `TASK_POLICY` picks WHICH agent runs an op, this picks HOW.
Before it, effort was inherited from whatever the CLI's home settings said, so an
op ran at a different depth on a dev box than on the deployed host. Profiles are
provider-neutral (`MODEL_CLASSES` = `fast` | `deep`) and map to a CLI model ALIAS
via the new `model_classes` field in `agents.json`, so nothing in `src/` names a
concrete model and an Anthropic alias can never reach a non-Anthropic CLI; a
provider declaring no mapping keeps its own model and takes only the effort.
`resolveAgentProfileForClass()` clamps a request to what the CLI declares and
never throws (`highestSupportedReasoning` degrades `xhigh`/`max` to a provider's
ceiling rather than failing; `ReasoningLevel` gained `max`). Resolution happens
once at spawn time via the new `RunOpts.profile` resolver callback — threaded as a
callback because the policy module imports `agents.ts` — folded in at the single
`runAgent` chokepoint every spawn path shares, so it resolves against the agent
ACTUALLY chosen and `runChosen` call sites need no wiring. The new
`agent_profile_bindings` settings column (v77, same JSON shape as
`chat_profile_bindings`, both now normalized by one generic
`normalizeProfileBindings` in `src/chatRouting.ts`) is the optional per-provider,
per-task override. The interactive timeout now scales with the requested effort
(`interactiveTimeoutFor`: low 90s → medium 150s → high 240s → xhigh/max 300s),
reached via `interactiveTimeoutForOp` for job ops and `chatTurnTimeoutMs` for
chat — a flat 90s cap had been killing high-effort runs mid-think, which the
rotation then read as a failed agent. Chat stays deliberately absent from the
table: its adaptive lane router remains authoritative for model/effort, and only
the timeout follows the resolved profile.

**(3) Per-prompt-site context projection.** Every plan-shaping prompt used to end
with `JSON.stringify(getCoachContext())` — the whole ~63-key snapshot at every
site, ~196 KB per call on a demo seed. The new `src/prompt/context-projection.ts`
is one seam: a declarative per-site key allowlist over cohesive domain bundles,
applied by `promptData(ctx, site)`, covering all 13 prompt sites (DATA −43%).
`getCoachContext()` is untouched, so every non-prompt consumer (MCP tools, routes,
`agentJobs`, the read-tool loop) still gets everything and the builders keep
reading the full ctx for their own `render*` prose blocks. A key earns its place
under a three-part rule (the prompt's text names it / a `render*` helper at that
site reads it / the builder's code reads it off the DATA), with "when in doubt,
KEEP". Two within-key right-sizings ride along: `recent_sessions` capped per site
with each set PROJECTED to the fields prompts read (never null-stripped — `weight:
null` means bodyweight), and `compactRecovery` keeping one copy of the per-metric
quality map `getRecoverySummary` emits four ways.

**(4) Today lead arbitration.** `src/domain/brain/today-attention.ts` decides
which single surface earns the main column's position of prominence
(`brief` | `feedback` | `insight` | `weekly` | `fuel`) with an emphasis tier for
the rest, running inside `attachDayReadContext` so REST, MCP and `agentJobs`
agree. `briefState()` lets the Brief yield only on a quiet day with nothing logged
whose own prose already admits it repeats yesterday; absence of a continuity block
degrades to today's behavior. It is deliberately NOT merged with
`repo/today-agenda.ts`: that budgets the RAIL and exists to reduce, this
reorders main-column emphasis and never hides anything. The internal rank never
crosses the wire — the client gets semantic labels only, as with marker
`impact_score`. Also in this round: the Gemini text-model default was corrected to
the real `gemini-3.6-flash` (a non-existent `gemini-3.1-flash` had been silently
killing every semantic-cache canonicalize call), pinned by
`test/artModelDefaults.test.js`, with `enrich.ts`'s food-photo fallback now
importing that constant rather than re-deriving the chain.

## 2026-07-23 — pace-aware fuel reads + Brief cache invalidation on food/plan writes

A **fuel-reactivity** round fixed the Brief's FUEL line being pace-blind: it used
to say "protein is ~N g short of today's target" whenever ≥25 g remained, which
reads as a nag before lunch even when intake is on track. `dayFuelState()`
(`src/repo/fuel-state.ts`, no schema migration — pure/deterministic, `now`
injectable for tests) grades protein against where you'd EXPECT to be at this
point in the eating window (first-logged-meal-or-07:00 start through a 21:00
end) rather than the raw remaining grams, returning a `behind | on_pace | met`
bucket plus the last-logged-meal recency; a past day falls back to a full-day
total since pace is meaningless once the day is over. `dayRead()`
(`src/repo/day-read.ts`) stamps the bucket/so-far/target into `signals.fuel` so
the cached row carries it, and `readToday()`
(`src/domain/brain/day-read-use-case.ts`) treats a fuel-bucket flip between two
present buckets (e.g. a lunch moving behind→on_pace) as a serve-time material
truth change that heals the cached prose — a cache row from before this signal
existed has no fuel key and is treated as no-change, so deploy never churns the
whole cache. `debriefFacts()` (`src/prompt/day.ts`) renders the new bucket into
plain words ("protein's running behind pace — 65 g in so far vs ~110 g you'd
expect by now"; on-pace and met read as calm, no-nudge lines). A new
`localHourFraction()` (`src/repo/shared.ts`) gives the pace model minute-precision
against the device's active zone via the existing `zonedParts` machinery.

Separately, food and meal-plan writes in `src/repo/nutrition.ts` now call the
existing `invalidateDayRead()` so the cached Brief recomputes instead of going
stale: `acceptMealPlan`/`restoreMealPlanAfterUndo` (a different plan becomes
current), `updateMealPlanDays`/`swapMealInPlan` (the plan's content changed),
and every food-note write path (`scheduleFoodNoteEffects`'s
`invalidateDayReadForDate` helper, plus `deleteFoodNote`/`updateFoodNoteParsed`/
`updateFoodNote`) — the helper busts both the entry's own local day and, when
that isn't today, today's cache too, since a past day's intake still feeds the
trailing-average expenditure/fuel reads that shape today's Brief.
`setMealRecipe` deliberately does not invalidate — caching a recipe doesn't
change what the plan prescribes. No schema migration in this round.

## 2026-07-20 — durable daily-session compositions

Daily session acceptance now persists a full, immutable execution snapshot in
the additive `daily_session_compositions` table. A composition has ordered
prescription items, presentation fields, constraints, provenance, a required
training-session link, an optional weekly-plan link, and active/superseded
version history. Its stored snapshot remains the execution source of truth even
if the weekly plan is edited later.

The shared training use case owns preparation, normalization, identity, and
replacement policy; REST and MCP are thin wrappers over that same behavior.
The PWA prepares the canonical snapshot before opening a session, restores it
after reload, and renders plan-backed versus built-for-today identity without
collapsing custom work into a template. Equivalent prepare retries reuse the
active composition. A different replacement is permitted only before meaningful
session state exists; once work, feedback, completion, notes, or matching logged
cardio evidence establishes a started session, the server refuses the change.
Supersession is retained for provenance and idempotency, while older sessions
and clients remain compatible through a nullable daily-session association.

## 2026-07-14 — trustworthy daily reads, durable capture, and Apple Health pairing

Cairn **v1.2.0** applies one shared reading grammar across the daily driver. The
Brief exposes the small set of contributors behind its suggestion, leads with
what is going well, and presents missing or uncertain evidence as context rather
than a score. Recovery and training-load reads now derive bounded personal
baselines when enough history exists and fall back conservatively when it does
not. The Energy Balance surface uses the same plain-language lead and confidence
geometry, while accepted nutrition-target changes can trigger downstream meal
planning through the existing autonomy, boundary, supersession, and Undo ledger.
Expenditure estimation was hardened so sparse or anomalous inputs lower
confidence instead of dominating the recommendation.

The background brain now reasons about configured local days while preserving
UTC timestamps for durable ordering. Schedule freshness, demo/test seed dates,
and adoption-grace comparisons therefore behave consistently across time zones
and midnight boundaries. Eligible orphaned drafts can re-enter the server-owned
autonomy path after a bounded grace period, without bypassing explicit nutrition
vetoes, natural-boundary semantics, structural-change announcements, or Undo.

Capture and wearable reconciliation received reliability fixes. The offline
outbox exposes retry/remove recovery for failed rows, preventing an unrecoverable
“Needs attention” overlay. Garmin strength set ingestion is transaction-scoped:
detected sets either reconcile together or roll back together, remain idempotent
on re-sync, and never overwrite authoritative hand-entered work. Measurement
prefill, wrapped-pill rendering, and local-date test coverage close smaller daily
friction and determinism gaps.

Apple Health gains least-privilege Shortcut pairing groundwork. Owner-authenticated
REST endpoints create short-lived single-use pairing codes; exchange yields a
hashed, revocable ingestion credential scoped to `POST /api/health-metrics`, and
Settings exposes connection creation and revocation. Pairing management is
intentionally owner-only REST rather than MCP. Migration **v65**
(`daily-metrics-apple-richness`) adds nullable source-agnostic fields for total
calories, distance, exercise minutes, stand hours, SpO2, and VO2max. Fresh
`apple_health_pairings` and `apple_health_connections` tables are idempotent
`CREATE TABLE IF NOT EXISTS` schema, so they require no migration entry. The PWA
cache advances to `cairn-v492`.

No validated Shortcut artifact ships by default. Guided iPhone installation is
an opt-in integration surface and remains unvalidated until the operator
configures a trusted Shortcut URL; the documented manual-builder workflow is the
portable fallback for public self-hosters.

## 2026-07-12 — private household instances from one released image

Cairn **v1.1.1** remains single-user per process, but one Docker host can now run a private
instance per household member from the same released image. Compose container
identity, loopback bind, and host port are configurable while preserving every
existing single-instance default; distinct Compose projects automatically keep
the database/uploads, provider login home, and installed-tool volumes isolated.
The release Compose now also carries fail-closed auth and the Settings encryption
key consistently with source deployments.

`CAIRN_BLANK_PROFILE=1` gives a newly created member a clean personal baseline:
only the neutral exercise catalog is seeded; no example plan, fictional seed
measurements, or completed training history is created. The public
household guide covers unique tokens/keys, Tailscale identities and HTTPS origins,
per-instance connectors/provider logins, backups, updates, and safe removal. No
schema migration or PWA cache change was required.

## 2026-07-11 — trustworthy autonomous intelligence and visible future change

The **v1.1.0** quality round makes the expert-team model dependable at both ends of the loop. Agent
responses now have operation-specific semantic contracts: a provider that returns valid JSON for
the wrong job is repaired once, then rotated past, while Today and week-ahead reads fall back to
useful deterministic or stale content instead of showing empty work. Explicit user cancellation is
preserved through the verification and fallback layers, so a stopped request cannot quietly persist
later. Food events are also kept separate from durable meal preferences, preventing an ordinary log
from distorting future planning.

The normal Plan and Meals experience no longer revolves around Drafts. It shows the accepted plan,
the next scheduled change, and recent changes; Today gives a concise heads-up, with Hold, Why, and
Undo close by. Background training and nutrition adaptations continue through the same server-owned
autonomy policy: bounded reversible changes can land at natural boundaries, structural changes
announce first, and clinical or goal-identity decisions always ask.

The Docker runtime is leaner and provider-neutral. Coaching CLIs install on demand from Settings into
the persistent `cairn-tools` volume, with pinned package identities/checksums and opt-in updates,
instead of inflating every image with every provider. No schema migration was required. The PWA cache
advances to `cairn-v472`.

## 2026-07-11 — continuous expert-team stewardship

A no-schema **v1.0.3** autonomy-alignment round closes the remaining legacy
draft/apply seams beneath Amendment 1. Manual program reviews, weekly and
data-triggered evolution, strength progression, endurance run programming,
adaptive nutrition, and verified meal planning now route through one
server-owned policy. In Lead mode, bounded reversible changes land at the next
un-lived natural boundary; structural changes announce first; review posture
still holds a draft; goal-identity and clinical decisions still ask.

Meal planning is now a coordinated downstream expression of the whole picture.
A scheduled meal week leaves the currently accepted plan active until its food-day
boundary, supersedes older queued alternatives, and retains the previous week as
an exact one-tap rollback. A landed nutrition target asks the background team to
refresh meals from the newly active calories and macros. Plan and Meals surfaces
show calm upcoming information instead of Apply/Replan chores, while Hold, Undo,
manual review, and chat direction remain immediate override paths. No schema
migration was required; the rollback ledger's existing text kind now also accepts
`meal_plan` snapshots, and the PWA cache advances to `cairn-v469`.
The meal specialist also carries the same goal/floor distinction as training and
chat: during a cut, continued strength and muscle development remain the objective;
lean-mass preservation is a non-negotiable floor, never the headline aspiration.

## 2026-07-11 — strength development remains the goal

A no-schema **v1.0.2** correction separates the athlete's aspiration from the
safety floor. Hybrid/strength profiles optimize **strength and muscle
development** during cuts and race builds; `no avoidable strength regression`
and `no avoidable lean-mass loss` are explicit universal floors, never the
ceiling. Training, chat, and nutrition prompts carry the same contract: a
deload or load hold absorbs fatigue so earned progression can resume rather
than silently redefining success as maintenance.

The whole-person strength read now compares each established lift against
itself instead of averaging unlike exercises together. Any comparable
regressing lift remains visible and triggers the standing revision loop even
when other lifts are advancing, while fresh lifts remain `unknown` until they
have enough exposures. This prevents broad program gains from hiding a slipping
bench or another specific strength objective.

## 2026-07-11 — adaptive-cut trust and Pi defense-in-depth

Migrations **v63** (`profile-measured-rmr`) and **v64**
(`journey-baseline-backfill`; package version `1.0.1`) make the athlete's real
journey and metabolic test durable without rewriting existing observations.
The metabolic-test ingest extracts a plausible measured RMR into provenance-bearing
profile fields; goal math preserves formula BMR for the activity-factor seed,
uses the measured RMR as the displayed resting anchor, and only combines it with
Garmin active calories once enough days exist. The journey baseline backfill
fills only missing fields from the earliest weigh-in, so an explicit baseline
always wins and no journey phase auto-activates during migration.

The closed loop now treats repeated strength-endurance fade in session notes and
material one-tap fatigue as real program signals. During a cut, those signals can
trigger a cooldown-bounded nutrition recheck when loss pace or hybrid fuel risk
also warrants it; carb-led corrections still travel through the existing
lean-safe nutrition proposal, autonomy, and accountability path. Cut/race phases
introduced an explicit strength/lean-mass protection floor instead of parking
strength. Case conferences accept typed nutrition-target revisions, preserve
valid specialist findings through a conservative advice-only fallback when the
conductor envelope is malformed, and skip only malformed optional expectations.
Accepted nutrition targets invalidate older meal-plan assumptions.

Self-host hardening passes `CAIRN_REQUIRE_AUTH` and
`CAIRN_SETTINGS_SECRET_KEY` through Compose, keeping the app-token and encrypted
Settings-secret contracts explicit and stable across container rebuilds.

## 2026-07-10 — bounded local observability closeout

- Consolidated server, worker, scheduler, MCP, and agent error capture behind a
  shared class-only privacy contract; migration v61 removes legacy raw-ish agent
  detail and adds diagnostic coalescing metadata.
- Added capped hourly API/MCP latency histograms for throughput and approximate
  p50/p95 without raw successful-request rows.
- Added build SHA provenance, queue-age/failure readiness, scheduler heartbeat,
  operator MCP diagnostics, and smoke-only orphan-process containment.

A **local-first diagnostic telemetry** round (new `diagnostic_events` table via
`CREATE TABLE IF NOT EXISTS`; no migration; `sw.js` up to `cairn-v456`) added a
single privacy-bounded incident spine across the PWA, REST server, and Node
process. Every API response now carries `X-Request-ID`; unexpected server errors
return a generic correlated body while durable operator records keep only route,
status, duration, validated error class, and stack frames. `POST
/api/telemetry/client` ingests a strict 1-20 browser batch through a direct,
nonrecursive reporter with bounded local retry/dedupe; global browser errors,
unhandled rejections, tab render failures, HTTP failures, invalid JSON, and
timeouts are classified without collecting bodies, query values, chat/health
text, credentials, prompts, or raw agent output. The shared API client now rejects
non-2xx responses, preserves designed `200 + {ok:false}` outcomes, marks offline
only for real connectivity failures, and caches only successful GETs. Durable
capture outbox replay retains transient failures and marks permanent rejections
for attention instead of silently dropping them, carrying a stable idempotency
key. Successful keyed responses stay in the server ledger for the database's
lifetime because client outbox entries do not expire. The guard admits only the
durable capture/session mutation routes, caps keys at 120 characters and stored
responses at 64 KiB, and records a small non-retry replay error when a successful
response exceeds that envelope. Same-process overlapping retries wait for the
owning request instead of applying twice, while cross-operation key reuse fails
closed with a coded conflict. That modest household-scale storage is the safer
durability tradeoff.
`GET /api/diagnostics` powers a compact Settings operator card with grouped
issues/recent slow calls; `GET /api/ready` proves SQLite readability and reports
only queue counts. Uncaught process exceptions record generic diagnostics and
exit for container restart instead of continuing in uncertain state. Raw events
prune after 30 days; all writes remain failure-safe. The real-browser release
gate also exposed and closed a Family optimistic concurrency race: a confirmed
delete now waits for an active edit on that member, so the edit's late commit can
never repaint and restore the removed row; duplicate confirmed deletes are
coalesced.

An **Elite Brain accountability and autonomy** round (migrations **v59** `settings-lead-mode` and **v60** `evidence-governance`) closed the observe → decide → safely act → evaluate → learn loop. Material decisions now live in a generalized ledger with source links, falsifiable expectations, deterministic maturity evaluation, preserved inconclusive history, exact rollback snapshots for autonomous training changes, and bounded personal-response modifiers that now affect real nutrition and progression recommendations without overriding injury, allergy, clinical, or lean-safe floors. A coalesced signal router turns finished sessions and material nutrition corrections into durable background reviews: the next-session progression can quietly land after the completed-session boundary; nutrition changes wait for the next local day. Food-only chat turns cannot mutate training or goal identity, surprise budgets and veto-rate demotion limit autonomy, and direct/manual actions never claim Undo without a server-owned snapshot. Multidisciplinary case conferences share a pinned snapshot, require every deterministic conflict to be resolved or explicitly deferred, and can emit typed plan proposals through the same autonomy/safety path; advice-only conferences cannot become inert announcements. Nine bounded server-executed history reads use strict allowlists, call/round/byte/deadline limits, sanitized telemetry, and ambient-MCP denial. The standing whole-person trajectory now reaches coach context, weekly reads, REST, and MCP; lifestyle learning includes repeated explicit alcohol/late-caffeine response against next-sleep comparisons. Clinical evidence carries scope/version/review/expiry/freshness/verification/effective-confidence metadata and exposes it in the PWA. All user-facing agentic REST and MCP mutations use durable jobs instead of holding requests open. Settings diagnostics aggregate expectation/evaluation coverage, verdicts, reversals, demotions, bounded-read failures/budgets, and conference availability without exposing prompts, private files, chain-of-thought, or user-facing scores. The reported split UTF-8 replacement glyph is guarded in subprocess streaming, and affected training items explain autonomous changes with one-tap Undo.

A **Cairn v1 completion** round (migrations **v56** `profile-journey-baseline` and **v57** `profile-cv-risk-flags`; `sw.js` up to `cairn-v439`; package version `1.0.0`) finished the connected-athlete release line by integrating the last plan tracks through small worker branches and central merge verification. The release adds a request-scoped brain snapshot and attention budget, the Journey arc (baseline + phase read + milestones + nutrition prompt context + Progress overview UI), an AHA PREVENT 2023 cardiovascular-risk read with profile inputs, enhancer honesty, Stand heart-age/risk display, and a data-bound SVG risk ribbon, plus a doctor-facing loop (`/api/health/outcomes`, outcome recording, doctor packet export, MCP parity) that stays review-only and clinician-framed. Training gained benchmark milestones, K5/retest attention, and a deterministic plateau/adherence playbook that feeds program evolution signals without auto-applying. The UI/cold-path track added instant optimistic/SWR cache mutation helpers across Food/Memory/Family, a guarded optimistic Family save state, a `/api/today?date=` aggregate to prime Today caches on cold open, and a direct-WebGL Body 3D progressive-enhancement scaffold that never blocks the existing 2D body figure. Infrastructure pinned the TS7 compiler path, regenerated endpoint docs, kept MCP⊆REST contracts green, and finished with `npm run release:check` (verify + built server smoke + dependency-free browser smoke) passing.

A **focused Session destination** round (NO schema change; `sw.js` up to `cairn-v395`) lifted workout logging OUT of the Today re-render cycle to kill the flicker + scroll-jump that the background "brain" caused while entering sets. The root cause: Today is one wholesale `#view.innerHTML` rebuild (`today-screen.ts`) with no scroll preservation, and several background paths re-ran it under the user's fingers — the soft-SWR repaint (`today-data-loader.ts` `scheduleSoftRepaint`), the `day_read_override` agent job, `reshapeToday`, the first-set finish-stat fallback, and the 600ms adapted-Rx patcher. All of those self-gate on `state.tab === "today"`, so the fix is structural: **a new hidden top-level route `/app/session`**. `session` is added to `CLIENT_ROUTE_DEFINITIONS.tabs` (`src/contracts/client-routes.ts` + `src/client/route-state.ts`); the router serializes `?date` (`app/router.ts`), `render-dispatch.ts` dispatches `renderSession()`, and `tabs.ts` gives it a skeleton (no tab-bar button — reached via the global `openSession()`). **`renderSession()`** (a sibling of `renderToday()` in `today-screen.ts`, so it shares every closure) REUSES the exact data-prep (`preparePlanSession`), card/surface renderers (`buildHtml`) and session wiring (`wireSessionSurface`/`setupAddExercise`/`wireGuides`) but drops the Brief/rail/capture chrome, hides the global header + tab-bar (CSS `body[data-tab="session"]`), renders a calm sticky top bar (`.sess-topbar` — close ← / kicker / day name / progress dots), forces the finish bar **always-present** (`buildHtml` `hasLoggedSets:true`) so logging set #1 never triggers a full rebuild, drops the mid-workout "apply to plan" banner, kills the entrance stagger (`.sess-dest .reveal{animation:none}` — also fixes a compositing quirk that painted cards over the sticky bar), and PRESERVES scroll across the surgical delete/finish re-renders (reset only on a fresh open / day switch). A single mode-aware re-render callback — `rerenderTraining`, threaded in as the runtime's `renderToday` — makes the shared session/data/finish wiring re-render whichever training surface is live (delete/finish/reopen). On **Today** the inline logging surface is replaced by one calm **launch card** (`.sess-launch` — "Start/Continue →" → `openSession()`); the Brief's train CTAs (`start-session`/`reveal-plan`/`pull-plan`) also route to `openSession()`; and **focus mode is retired** (`renderToday` forces `focus=false`, since the destination IS the distraction-free surface). Verified live: isolated (`tab:session`, no `.today-wrap`/`.brief`/`.today-rail`, header+tabbar `display:none`), surgical set-log (chip append, no rebuild, no scroll jump, PR toast), sticky bar, delete, finish/feedback, bodyweight, day-switch, close ← and browser-back → Today. Tests: `clientAppRouter` (ROUTE_TABS) + `clientTodayBriefController` (redirects now open the destination) updated.

A **coaching-brain / conductor** round (NO schema change — all-new deterministic reads; `sw.js` up to `cairn-v166`) added the whole-athlete coaching layer and restructured the Me surface. Four new `src/repo/` modules: **`coaching-focus.ts`** (THE CONDUCTOR — `coachingFocus()`/`getCoachingFocus()` arbitrates every domain read (`healthFocus()` + the run plan + DEXA targeting + muscle trajectory + reaction-model/trajectory) into ONE sequenced focus — a single LEAD lever, 1–2 PARALLEL levers, an explicit LATER deferral, the cross-domain CONNECTIONS, and ONE batched RE-TEST — instead of a card flood; plain words, no scores, folded into `getCoachContext().coaching_focus` and rendered FIRST in every plan prompt via `renderCoachingFocus`); **`run-progression.ts`** (the deterministic RUNNING engine, the endurance counterpart to `program-state`/`performance` — `runZones()` real Z1–Z5 bpm bands grounded in physiology, `weeklyRunPlan()` this week's periodized N-easy-Z2 + 1-long + 1-rotated-quality mix with interval structure, `runVarietyRead()`, `enduranceTestsDue()` — rendered by `renderRunZones`/`renderRunPlan` (which also folds in the variety nudge + due endurance re-test), applied via the propose→apply path that maps `runs → parsed.cardio[]` through `setWeeklyRuns`); **`dexa-targeting.ts`** (`dexaTargeting()` maps the body-scan's REGIONAL read — lean asymmetry, low ALMI/FFMI, low BMD, visceral/central fat — into concrete training + one nutrition target, each with a plain "path to your next scan", via `renderDexaTargeting(training|nutrition)`; BMD/visceral stay INFORMATIONAL/clinician-framed, never a score); **`muscle-trajectory.ts`** (`muscleGroupTrajectory()` the per-canonical-group ADVANCING-vs-STALLING read with a same-pattern vary menu, plus `testWeekDue()` the cadenced strength re-test — `renderMuscleGroups`). All flow through `getCoachContext()` and degrade to `{available:false}`. Surfaces (additive, MCP⊆REST): `GET /api/coaching-focus`·`/run-plan`·`/run-zones`·`/muscle-trajectory`·`/test-week`·`/dexa-targeting` + `POST /api/program/run-plan/apply` (drafts a run-plan proposal, never auto-applied) + MCP `get_coaching_focus`/`get_run_plan`/`get_run_zones`/`apply_run_plan`/`get_muscle_trajectory`/`get_test_week`/`get_dexa_targeting`. **PWA IA restructure:** **Standing is now a top-level Me tab (FIRST/default — review-first IA)** leading with the conductor's calm "Where to focus" card over the where-you-stand health read; **Health is lab-data only**, its sub-nav now **Read / Markers / Records / Share / Learned** — the old **Brain** view is GONE, its connected-brain depth (recovery, priority markers, grouped directives, the agentic synthesis, supplements, symptom-links) folded into **Health → Read**. Today surfaces the conductor as ONE tappable thread (the multi-week focus is a review that lives on Me → Standing, not a card on Today). Tests: `test/{coachingFocus,runProgression,dexaTargeting,muscleTrajectory,markerGroups}.test.js`.

A **self-hosted update-detection** round (migration **v47** `settings-update-check-enabled`; `sw.js` `cairn-v154`) lets an instance detect a newer release and GUIDE the update (never auto-apply — a container can't safely replace its own image, mirroring the opt-in `cairn-update-agent-clis` stance): `src/version.ts` resolves the running version (`CAIRN_VERSION` env baked from the release tag → `package.json` → `0.0.0`) with a dependency-free SemVer comparator (`parseVersion`/`compareVersions`/`isNewer` — a release outranks its pre-release, garbage never reads as newer), and `src/updateCheck.ts` checks the **GitHub Releases API** for the latest tag, caching `{latest,html_url,notes,checked_at,error}` in the `app_state` KV (pure `parseLatestRelease`/`computeUpdateStatus`/`getUpdateStatus`/`checkForUpdate` — the network call never throws, folding errors into `status.error`). A quiet daily `scheduler.ts` tick (gated on `settings.update_check_enabled`, default ON, one toggle to disable; stamp-first via `update_check_last_date` so a persistent-offline box checks ≤1×/day) keeps it fresh — PULL-never-push, nothing notifies. Surfaces (additive, MCP⊆REST): `GET /api/version`, `GET /api/update-status`, `POST /api/update-check` (+ `version` on `GET /api/health`) + MCP `get_update_status`/`check_for_update`, rendered as the calm "Cairn version" card on **Settings → Data** (`public/js/10-boot.js` `renderDataSlice`/`updateCardHtml`): running version, up-to-date / "vX available" + a What's-new link + copy-paste How-to-update + a Check-now button, and the disclosed toggle. The release workflow bakes `CAIRN_VERSION` from the git tag (`Dockerfile` ARG/ENV); `CAIRN_UPDATE_REPO` overrides the checked `owner/repo` for forks. Tests: `test/{version,updateCheck}.test.js`.

A **HealthOS hardening + training-intelligence** round (migrations **v44** `blood-pressure-readings`, **v45** `garmin-daily-runner-metrics`, **v46** `garmin-activity-richness`; `sw.js` up to `cairn-v152`) did four things. (1) A **momentum-led health Standing** (`src/repo/standing.ts` `healthStanding()` — the Me→Health hero): sex/age **percentile reference curves** (`compareCurve`/`VO2_CURVE`/`bandForPercentile`, exported for reuse) read VO2max + body-fat FOR-AGE, a LIVE body-composition estimate projects the DEXA fat-free mass onto today's weight (so weight loss shows instead of a stale scan pegging an old "signal age"), the lab's measured Biological Age leads, momentum chips + the single `lead_lever` (`healthFocus().lead`) head the read, and blood-pressure CAPTURE moved out of the analysis view into a sheet with a plain `bpRead()` interpretation (`src/repo/health.ts`, migration **v44** `blood_pressure_readings`). (2) **Connected-brain input validation** (the "validate every metric the brain ingests" mandate): a `zoneNameTrustworthy` guard in `matchOptimalZone` (`propagation.ts`) kills clinically-WRONG directives from naive substring zone-matching (a "…/HDL Ratio" → "raise your HDL", a urine-albumin grabbing an unrelated optimal band); **symptom→marker reasoning** (`src/repo/symptom-links.ts` `symptomMarkerLinks()` — a curated `SYMPTOM_KB` links a logged symptom (blurry vision, fatigue, headaches…) to a co-occurring out-of-range marker as an informational "worth mentioning to your clinician" read, NEVER a diagnosis → `getCoachContext().symptom_links` + `GET /api/symptom-links` + MCP `get_symptom_links` + a quiet Me→Health→Standing rail card + a `renderConnectedBrain` clause); `markerInTransientWindow` wired into `annotateDirectiveFreshness` (an acute marker — hs-CRP/ESR — drawn inside an active illness/injury/hard-block window reads `transient`/informational, not a daily training cap, alongside the existing `stale` decay); and a conservative `plausibleMarkerValue` numeric/unit-plausibility clamp at lab ingest (`health.ts insertHealthPanels` + `enrich.ts cleanMarkers`) so a transcription typo / unit mix-up can't poison the directives. (3) **Garmin "parse everything we can"**: the keystone `rawGet` fix prepends the API host (`client.url.GC_API`) — a relative path threw "Invalid URL" and silently nulled every internal-endpoint field (stress / body-battery / calories / HR extremes / fitness-age / runner metrics — daily fields jumped 15→30 populated) — plus runner-metric endpoints (endurance + hill score with the required `?calendarDate=`, race predictions, training-load-balance now read from the `trainingstatus` aggregate, skin-temp via query params); the remaining null fields are genuine DEVICE limits (no SpO2 / body-battery / HRV / Index scale on this watch), each degrading null-safe under the `[garmin] GET … failed` warn. (4) The **performance / training-intelligence read** (`src/repo/performance.ts` `performanceStanding(date?)` — the athletic COUNTERPART to the health Standing, the answer to "how does the brain measure & balance my current performance?"): it benchmarks where the athlete actually STANDS — each lift's CAPACITY as a sex/age **percentile + level** (beginner→elite) against proven bodyweight-ratio strength standards (`STRENGTH_SPECS`, age-declined, fed through the SAME `compareCurve` as the health curves; `classifyPattern` picks the representative compound per movement pattern), VO2max-for-age, the strength **imbalances** (press vs pull, lower vs upper, the widest spread), the single highest-leverage **lever**, lifts worth **re-testing** (a stale heavy/≤5-rep max → re-measure true capacity, plus core/grip hold tests), and a **variety** nudge (don't run the identical movement as the only one in a pattern forever) — folded into `getCoachContext().performance` + `renderPerformance(ctx)` across EVERY strength prompt (coach/evolution/day-read/session/week-ahead, so the coach measures capacity + balances development, not just whether last week trended up) → `GET /api/performance` + MCP `get_performance` + the "where you stand" hero on Progress→Program (`public/js/05-progress.js` `loadPerformance`/`performanceHtml`). Percentile/level are recognized reference reads (the framing the athlete asked to keep), NEVER a 0-100 score; everything is derived LIVE so it reacts to every logged set. Tests: `test/{healthStanding,bloodPressure,markers,symptomLinks,markerPlausibility,transientDirective,garminVo2,performance}.test.js`.

A **device-following timezone** round (migrations **v42** `food-notes-local-date` + **v43** `chat-turns-tz`, `sw.js` `cairn-v137`) made Cairn's whole clock follow the athlete's DEVICE instead of UTC/the server — so the agentic brain is time-of-day aware and an evening log lands on the right day at home AND while traveling. **One local clock** (`src/tz.ts`): a request/turn-scoped IANA zone via `AsyncLocalStorage` — the PWA sends `X-Cairn-TZ` (`public/js/01-core.js` `api()`), a `src/server.ts` middleware wraps every `/api`+`/mcp` request in `runWithTimeZone`, and the chat worker re-establishes the zone captured at enqueue (`chat_turns.tz`, set in `createChatTurn`; `chatTurns.processChatTurn` → `processChatTurnInner`). The shared helpers `localDateISO`/`nowContext`/`chatHistoryTimeLabel` (`src/repo/shared.ts`) default their zone to `activeTimeZone()` (else the server's own TZ — legacy behavior unchanged for the scheduler/enrichment/tests), with a cached-Intl-formatter layer in the hot path; **logs stay UTC instants** (`created_at`), only the FRAMING moves. `nowContext()` is folded into `getCoachContext().now` and rendered as a `RIGHT NOW:` line (`prompt.ts` `renderNow`) in the chat/day-read/session prompts, the chat history lines carry relative time labels, and food/activity entries carry a local `logged_at`. Day-keying: `food_notes.date` (v42, backfilled via SQLite `localtime`) + `activities.date` stamp the LOCAL day; `getDayIntake` keys by `COALESCE(date, substr(created_at,1,10))`; and the broad **`todayISO()`→`localDateISO()`** sweep moved every "the user's today" call site (dayRead/forwardLook/getProgramState/todayAgenda/getWeeklyStats windows/logSetByName/skip/addCheckin/logWeight/getCardioForDate/session-suggest + the two `getCachedDayRead` lookups in api/mcp) onto the device-local day, leaving genuinely-UTC uses (export filenames, rolling-window lookbacks, `week_of`) on `todayISO()`. Tests: `test/timeAwareness.test.js`, `test/localDayKeying.test.js`.

A **unified-coach** round (NO migration; `sw.js` `cairn-v136`) made Today read as ONE invisible coach that speaks through the Brief — the coaching intelligence comes to you instead of living in tabs you operate. (1) An honest **`done`** day-read kind (`src/repo/intelligence.ts` `dayRead` — a genuinely LOADING session already logged today (graded via `dayLoad`; a light flush stays `easy`) reads "TRAINED TODAY", never "EASY DAY"; `src/dayread.ts` `computeDayRead` treats `done` as a FACT the agent voices but can't downgrade) with a **post-session debrief** (`prompt.ts` `debriefFacts(date)` → the deterministic facts (today's top set, the next session, a real protein gap) the agent weaves into a warm read-back; the steer chips + "ask for a session" push are suppressed once done). (2) A **day-ahead forward line** (`repo.forwardLook(date)` `{next_focus,due,text}` — the next plan day's focus + groups under their productive range): attached deterministically on EVERY `GET /api/today-read` AND MCP `get_day_read` as `read.forward` (a shared `withForward` helper at both surfaces — current, never a stale snapshot; null on a done day), rendered as a quiet "↗ Next: …" line under the Brief that taps to the week (`view-week` redirect), so the Program tab is never required reading. (3) Stale **acute-marker directives decay** (`repo.directiveFreshness`/`isAcuteMarker`/`ACUTE_DIRECTIVE_STALE_DAYS` — `prompt.ts` `renderConnectedBrain` drops a >stale hs-CRP/ESR-class directive from the daily "honor these" block to an informational "AGING LAB FINDINGS — recheck" note instead of capping training every morning; the acute window is short (`ACUTE_DIRECTIVE_STALE_DAYS` = 10) and anchored to the analyte's actual latest LAB reading date — via `repo.acuteReadingDateMap`/`repo.annotateDirectiveFreshness`, which also flow a `stale`/`acute`/`age_days` verdict onto `GET /api/directives` + MCP `list_directives` so the PWA Brief provenance line (`loadTrainingProvenance`) skips a stale acute finding too — and `directiveFreshness` falls back to `trigger_date`→`created_at` so even a `health_review` directive that never stamped a trigger_date can age out (the original "stale CRP caps forever" bug); a composite/cluster name that merely MENTIONS CRP (e.g. `ApoB+LDL-C+Lp(a)+hs-CRP+Triglycerides`) is guarded OUT of the acute class, and chronic markers (ApoB/Lp(a)/LDL/HbA1c) never decay). (4) The **adjustments digest** (`repo.programAdjustments`) leads with earned overloads, frames missing-pattern gaps gently ("Add a little core", never "No X programmed"). (5) The Today rail got a single calm masthead ("✦ Also worth a look", `03-today.js` `buildAgendaRailHtml` `.rail-mast`) and every rail card shares one frame (a `border-left` accent spine — sage default, gold = the connection insight, terracotta = a decision — + `--radius-sm`) so the arbitrated cards read as one continued voice, not loose features. Also fixed: a planned **run is skippable** on Today exactly like a lift ("not today" → the bottom Skipped line, keyed by its display label; a synced run overrides a stale skip), and the auto-progression **"apply to my plan"** now applies cleanly (the change carries `day_number`/reps/`reason` — the missing `day_number` was the "No plan day NaN"/"Couldn't apply" failure + the "Dundefined" render) and dedups drafts per day (`repo.supersedeAutoProgressionDrafts`). Tests extend `test/{dayRead,deriveDirectives}.test.js` (the `done` kind, `forwardLook`, `directiveFreshness`).

An **Era 2 — the calm daily driver** round (NO migration — all new state rides the `app_state` KV; the six-feature frontier in `docs/VISION.md` §12, holding the constitution: calm, no scores, pull-never-push, you-drive) shipped after the goal modes. (1) **The Today salience arbiter** (`src/repo/today-agenda.ts` `todayAgenda(date?)` → `GET /api/today-agenda` + MCP `get_today_agenda`): ONE deterministic ranking+budget pass over the WHOLE Today surface — a producer per existing card reads the SAME repo data the client uses and assigns an INTERNAL `priority` (never surfaced, like marker `impact_score`); the Brief is always the hero, the top `TODAY_PRIMARY_MAX` (2) candidates render inline and the rest collapse behind one quiet "N more" `<details>`; an empty-data candidate self-omits (a quiet day is just the Brief). `public/js/03-today.js` is now agenda-driven (`buildAgendaRailHtml`/`runAgendaRail`/`genericAgendaCardHtml`), reusing the rich existing cards verbatim + rendering the new generic Era-2 cards, falling back to the fixed rail if the route is absent. The **fuel card is the canonical example**: it surfaces ONLY when there's logged food to EVALUATE (priority ≤ 0 when nothing's logged), so Today NEVER nudges capture — food logging tapers by design ([[nutrition-logging-fades-by-design]]); the old "Nothing logged yet" empty-state nudge is gone. (2) **Reachable cited-evidence** (`src/guidelines.ts` — a curated, offline **trusted-guidelines pack** of recognized-body statements (AHA/ACC, Endocrine Society, KDIGO…) keyed to the connected-brain markers, every URL scheme-guarded; `guidelineFor`/`allGuidelines` → `GET /api/guidelines` + MCP `get_guidelines`): the brain now CITES offline (no web) via `prompt.ts` `directiveCitationTag` (a verified citation still wins), and `research.ts` `researchAutoEligible()` + a Settings auto-suggest make live web research discoverable while `research_enabled` stays opt-in (off). (3) **Photo → macros (Phase 5A)** (`src/enrich.ts` new `food_photo` kind + `prompt.ts` `buildFoodPhotoPrompt`): a plate photo attached in Chat creates an instant `food_note` with `image_path`, then a vision agent (Claude-first via `pickHealthAgentOrder`) estimates editable, confidence-banded macros that upgrade in place; a double-log guard suppresses the agent's inline `log_food`; degrades cleanly (no vision agent / non-absolute path → as-logged). (4) **"Since you last looked"** (`src/repo/since-last.ts` `sinceLastLookedCandidate`/`markTodaySeen`, `today_last_seen_at` stamp): honest continuity — one calm line for the single most notable change (a merged lab, a resolved directive, a PR, an applied plan, a new insight) since the last open, NEVER a streak/counter, silent on the first open, priority-capped so it's never the loudest thing. (5) **Gentle "is this still your goal?"** (`src/repo/goal-checkin.ts`): a rare (~90-day-stable), dismissible, modest-priority card; the first run seeds the clock so a new user is never nagged; confirm/change restarts it (folded into `PUT /api/profile` on a goal-field change) → `POST /api/goal-checkin/confirm|dismiss` + MCP. (6) **The learned timeline** (`src/repo/learned-timeline.ts` `learnedTimeline` → `GET /api/learned-timeline` + MCP `get_learned_timeline`): a pull-only **Me→Health→Learned** read projecting load-bearing memories + outcome learnings + connected-brain directives + applied proposals — explains, never grades. Built by parallel agent teams with seam integration owned centrally; tests `test/{todayAgenda,sinceLast,goalCheckin,learnedTimeline,guidelines,foodPhoto}.test.js`. Before it, a **calm-nutrition** round (migration **v41** `profile-goal-mode`) made the goal first-class beyond weight-loss and gave food logging a quick day-review + edit. (1) **Goal modes** — `profile.goal_mode` (`lose`|`maintain`|`gain`; nullable = derived from the goal weight for back-compat) with `normalizeGoalMode`/`effectiveGoalMode` + a shared `leanGainRate(weightLb)` helper (`src/repo/profile.ts`). `computeGoalCheck(prof?)` (now reuses an already-fetched profile) branches the recommended target + message per mode — **maintain** anchors to the real TDEE (no deficit), **gain** is a conservative lean surplus (≤0.5 lb/wk, never a dirty bulk), **lose** is unchanged — and returns `goal_mode`; `getWeeklyStats` reads pace in the mode's language (`holding`/`drifting_up`/`drifting_down` when maintaining, `on`/`behind`/`fast` inverted when gaining — never "behind" while just holding steady) + carries `goal_mode`; `clampNutritionTarget`'s wording is mode-aware; `getCoachContext` carries `goal_mode`; and `prompt.ts` `renderGoalMode(ctx)` conditions the getting-lean/deficit framing across the meal-plan/swap/recipe/nutrition-checkin/chat prompts so a maintaining or building athlete is never pushed into a cut. (2) **Daily fuel review + edit** (`src/repo/nutrition.ts`): `getDayIntake(date?)` sums a UTC day's `food_notes` into totals + a per-entry list + (only when a target exists) a gentle `remaining` ("remaining", never "consumed"; never red); `updateFoodNote(id, fields)` corrects a logged note (macro/rename/meal-slot) and stamps `enrichment_status` terminal so a queued enricher can't clobber the fix. Surfaces (additive, MCP⊆REST): `GET /api/nutrition/day` · `PUT /api/food-notes/:id` + MCP `get_day_intake`/`update_food_note`, and `set_profile`/`PUT /api/profile` accept `goal_mode`. PWA (`sw.js` `cairn-v126`): a calm "today's fuel" glance on Today's rail that taps through to the editable day review co-located with Energy Balance in **Plan→Meals** (`dayFuelHtml`/`openFoodEdit`, reusing the detail-sheet helpers), a mode-aware compass + goal line, and a Lose/Maintain/Gain selector in Me→Profile — capture stays in Chat (the review is never a logging form). Test: `test/goalModes.test.js`. Before it, two NO-migration rounds followed the elite-strength build. (1) A **connected-brain + coaching hardening** pass closed the propose→apply loop, deepened agentic exercise understanding, and hardened brain surfacing (markers/recovery/ingest) — plus a quality fix so `latestSleep`'s 30-day HRV baseline dedups to one row per date like `getRecoverySummary` (two wearables feeding the same nights no longer double-weight the norm), and MCP `get_health_synthesis` returns the `stale` flag via `getHealthSynthesisView` for REST/MCP parity. (2)

A **secure self-host phone path** round (`sw.js` `cairn-v124`) made getting Cairn onto a phone clean and safe: `scripts/setup-phone.sh` auto-detects the tailnet `https://…ts.net` URL via Tailscale **Serve** (tailnet-only, not Funnel) and degrades gracefully; a fail-closed **`CAIRN_REQUIRE_AUTH`** boot guard (`src/auth.ts` `authStartupError` — pure, unit-tested, default off) refuses to start an instance exposed beyond loopback without a token; `SECURITY.md`/`DEPLOYMENT.md` gained a pre-exposure checklist + Serve-vs-Funnel guidance and `.env.example` documents `CAIRN_REQUIRE_AUTH` + the rate-limit knobs; the PWA got a dismissible "add to home screen" coach on Today (appended post-render so it isn't wiped) and a "Phone & PWA access" Settings card with an auth-aware token helper; and a zero-install "Open in GitHub Codespaces" front door (README/QUICKSTART) over the existing `.devcontainer`.

An **elite strength-planning** round (migration **v40** `exercise-groups-canon` + one new `CREATE TABLE IF NOT EXISTS` `exercise_aliases`) closed the loop between logged lifts and the plan. (1) **Exercise canonicalization** (`src/repo/exercise-canon.ts` — mirrors `marker-canon.ts`): a canonical 13-group muscle taxonomy that ADDS first-class `core`/`forearms`/`mobility` groups (previously a bench press with no group fell into "other" and core/grip/stretch work was invisible), a deterministic `classifyMuscleGroup` KB + `canonicalGroup` legacy-folding (legs→quads, posterior→hamstrings), `MUSCLE_LANDMARKS` weekly-set bands (plain words, never a score, mobility non-counting), and duplicate-movement dedup (`normalizedExerciseKey`/`planExerciseMerges`, e.g. "Dead hang"/"Dead hang timed"). `findOrCreateExercise` auto-classifies on create; migration v40 backfills existing null/legacy groups; `reconcileExerciseGroups`/`mergeExercises` (repoints `logged_sets`+`plan_items`) clean up the long tail. `getProgress` now computes assisted-lift (negative weight = assist) est-1RM off bodyweight-relative effective load and NEVER emits a negative 1RM. (2) **The auto-progression engine** (`src/repo/progression.ts`): `nextPrescription`/`planDayProgression` read the last logged top set + RIR + the lift's program-state status and propose the next session's target (overload/hold/deload/vary, clamped ≤10%/≤5 lb compound · ≤2.5 lb iso, injury `constraint_note` → HOLD, timed → +s, assisted → reduce assist); `programBalance` reports per-canonical-group volume bands + adherence skew + which groups are `due`; `programAdjustments` is the "what changed & why" digest (lifts to push/hold/deload, due groups, missing core/grip/mobility GAPS). (3) **The loop is closed**: program-state now feeds the coach — `getProgramState` gained an ACWR low-base guard (gates on ≥3-of-4 weeks-with-data AND a chronic floor, so a returning athlete's thin history reads "building base" not a false spike) and folds volume onto the taxonomy; `getCoachContext` carries `program_state`/`program_balance`/`progression`/`program_adjustments`; `prompt.ts` `renderProgramState` + an `ELITE_STRENGTH_GUARDRAILS` block (program core/grip/mobility/ankle, manage cumulative grip+elbow load, balance chest vs shoulders, weight earned rest harder, loaded carries) are wired into the day-read/session/coach/week-ahead/evolution prompts; `program-blocks.ensureActiveBlock` auto-maintains a goal-aligned block; the week-ahead floor notes due groups/deloads. Surfaces (`api.ts`+`mcp.ts`, additive, MCP⊆REST): `GET /api/program/balance`·`/api/program/progression?day=`·`/api/program/adjustments`, `POST /api/program/progression/apply` (drafts a plan proposal through the usual propose→apply — never auto-applied), `POST /api/exercises/reconcile-groups`·`/api/exercises/merge` + MCP `get_program_balance`/`get_progression`/`get_program_adjustments`/`apply_progression`/`reconcile_exercise_groups`/`merge_exercises`. PWA: Today's lift card shows each lift's adapted next prescription (hold/next-up/ease-off/switch-up + a one-line why) with "apply to my plan"; Progress→Volume gains the balance read (due groups, adherence skew, core/grip/mobility gaps) over the now-correct canonical-group bars; a "what changed & why" digest surfaces on Today + Progress→Program. Tests: `test/exerciseCanon.test.js`, `test/progression.test.js`, `test/programState.test.js`.

Migration **v39** (`profile-name`) adds `profile.name` — the athlete's optional name, set in Me→Profile (`setProfile` carries it like the other free-text fields: `''` clears, `undefined` leaves intact, capped 120; MCP `set_profile` + `PUT /api/profile` accept it). It's stamped on the doctor-ready clinical report: `buildClinicalReportData()` carries it on `subject.name` and both renders default the header to it (an explicit `?name=` still overrides, and the header span stays contenteditable to fill/change on paper). Test: `test/healthReport.test.js`.

A **clinician export + marker canonicalization** round (NO migration — one new `CREATE TABLE IF NOT EXISTS` `marker_aliases`) added two things. (1) A **doctor-ready clinical report** (`src/report.ts` — `buildClinicalReportData()` over `prioritizeMarkers()` + `renderClinicalReportHTML`/`renderClinicalReportText`): a self-contained, print-to-PDF HTML document (a "findings to discuss" lead = every marker lab-flagged H/L or outside a TRUSTED optimal target, then markers grouped into clinical panels with the latest value + lab flag + optimal target + the full DATED history, a DEXA body-comp section, supplements, and a "Copy for MyChart" plain-text twin) → `GET /api/health-report`(`.txt`) (auth via `?token=`, allow-listed in `queryTokenAllowedPath`) + MCP `get_health_report`; it's the HUMAN counterpart to the FHIR-ish `buildHealthExport` JSON, surfaced as "Export for my doctor" on the PWA Me→Health→Markers tab. A report-local `optimalTrustworthy` guard suppresses the shared matcher's substring over-match (a composite/qualitative name like "…/HDL Ratio", "LDL Pattern", or a urine albumin grabbing an unrelated band) so a false target never reaches a physician; optimal-zone framing, no scores. (2) **Marker canonicalization** (`src/repo/marker-canon.ts` — the connected brain's analyte de-duplication): different labs name the same analyte differently ("Glucose (random)"/"Glucose Random"; "Vitamin D"/"25-OH Vitamin D"; "eGFR"/the long form/"Estimated Glomerular Filt Rate"), which split one analyte's history into parallel series. Mirroring `art.ts`'s `resolveConcept`+`art_aliases`: a deterministic `normalizeMarkerName` + a curated CONSERVATIVE clinical KB are the offline FLOOR, and an agentic reconciler (`coachOps.reconcileMarkers` + `buildMarkerReconcilePrompt` → the pure `repo.planMarkerMerges` validator → persisted `marker_aliases` rows, source 'agent') learns the harder synonyms and writes them so future labs self-align. `getMarkerHistory` keys by the CANONICAL key (`canonicalMarker`) — so every connected-brain surface merges automatically — while the DISPLAY name stays the lab's own (canonicalization only MERGES series, NEVER relabels what the athlete or a directive sees, and NEVER conflates clinically-distinct measures: calc≠direct LDL, random≠fasting≠estimated-average glucose, free≠total testosterone, serum≠urine). `enrich.ts` runs `reconcileMarkers("auto")` after each health-doc ingestion (before `deriveDirectives`); manual triggers are `POST /api/markers/reconcile` (+ `GET /api/markers/aliases`) + MCP `reconcile_markers` + an "Align lab names" button on the Markers tab. Tests: `test/healthReport.test.js`, `test/markerCanon.test.js`.

A **connected-brain synthesis** round (NO schema change — uses the `app_state` KV) added the elite-coach prioritization+synthesis layer ON TOP of the directive flood: `healthFocus()` (`src/repo/propagation.ts`) deterministically COLLAPSES the per-(marker×domain) directives into a handful of TIERED, deduped, connected priorities (`act_now`/`track`, one per health group, with the lead move per domain — plain words, NO scores) → `GET /api/health/focus` + MCP `get_health_focus`, folded into `getCoachContext().health_focus` so ALL coaching leads with priorities; and `coachOps.synthesizeHealth` (agentic, pull, `buildHealthSynthesisPrompt`) reads that tiering + full context and writes the whole-picture STORY — the headline, the 2-3 priorities and how they connect across labs/body-comp/training/recovery/nutrition/life, and the single highest-leverage move — cached in `app_state` (`getHealthSynthesis`/`saveHealthSynthesis`), regenerated as a streamed `health_synthesis` background job → `GET/POST /api/health/synthesis` + MCP `get_health_synthesis`/`synthesize_health` + `getCoachContext().health_synthesis`; surfaced as the synthesis lead card on the PWA Me→Health→Read tab (`#hSynthesis`, `renderHealthSynthesis`/`focusTierHtml` in `public/js/07-me-health.js`).

An **adaptive program intelligence** build (migration **v38** `program-blocks`, `sw.js` `cairn-v91`) made the training plan EVOLVE instead of being a static preset: a deterministic **program-state engine** (`src/repo/program-state.ts` `getProgramState()` — per-lift est-1RM trend + plateau/stall detection with a suggested action, volume landmarks per muscle, mesocycle position (weeks-since-deload + tonnage ACWR), and endurance trends; plain words, NEVER a score → `GET /api/program-state` + MCP `get_program_state`) is the FLOOR under an **agentic plan-evolution loop** (`buildProgramEvolutionPrompt` + `coachOps.evolveProgram` reads the program-state and drafts a plan EVOLUTION — progress what's working, deload/rotate-a-variation what's stalled, introduce novelty, periodize — as a DRAFT proposal through the usual propose→apply, never auto-applied; `POST /api/program/evolve` + MCP `evolve_program`). A lightweight **periodization block** model (`src/repo/program-blocks.ts` + `program_blocks` table; `blockForCoach()` folded into `getCoachContext` and rendered in the coach + evolution prompts so the agent periodizes toward the active mesocycle; `/api/program/blocks*` + MCP `get_active_block`/`create_block`/`list_blocks`/`update_block`/`advance_block_week`) and an **exercise-variation library** (`src/repo/exercise-variations.ts` — 14 movement patterns; `suggestVariations`/`suggestAlternatives` feed concrete same-pattern plateau-break candidates into the evolution prompt; `/api/program/variations` + MCP `suggest_variations`) back it, and a PWA **Program** view (Progress→Program, `renderProgram` in `public/js/05-progress.js`) renders the per-lift trend (plain words, no score), volume landmarks, mesocycle, endurance, the "what to evolve next" list, and an "Evolve my plan" button. The same build also shipped an **intensity-aware day-read** (`src/repo/training-read.ts` `sessionLoad`/`dayLoad`/`deriveSessionTitle` — only genuinely-loading days count toward earned rest, a recovery day breaks the streak, a mileage spike is a caveat not a forced rest; off-plan sessions get a content-true title; the Lately feed expands strength rows to their movement breakdown).

An **Agent Connect** round (NO schema change — `user_version` was 37 then, `sw.js` `cairn-v89`) made connecting/controlling the coaching CLIs first-class and honest. **In-app login**: the browser can drive a CLI's interactive sign-in (claude/codex/antigravity/grok) in an embedded terminal — `src/agentLogin.ts` spawns the login inside a REAL PTY with NO native module (Linux `script -qfc "<cmd>" /dev/null`; macOS `python3 -c 'import pty; pty.spawn([...])'` since BSD `script` can't allocate a PTY with piped stdio) as the server's own user, so the token lands in `~/.claude`/`~/.codex`/`~/.gemini`/`~/.grok` where the agent reads it (the `-u app` footgun is gone); it bridges over a **WebSocket** (`src/server.ts` `WebSocketServer({noServer})` upgrade handler at `/api/agent-login/ws?agent=&token=` — single session, idle 5m / hard 15m timeouts, SIGKILL on socket close, `?token=` auth mirroring SSE, **allowlist-validated `agent`** — the login argv is server-chosen, never client data), rendered with vendored **xterm.js** (`public/vendor/xterm*`, lazy-loaded) in the `openAgentLoginModal()` Settings modal (`public/js/02-ui.js`). Each agent in `agents.json` gained declarative `login`/`status_check`/`auth_state`/`models_list` (+ a declared-but-UNUSED `model_flag`; `command`/`args`/`stream` are untouched — defaults are kept, nothing is pinned). **Honest rotation**: `agentConfigured(name)` (`src/agents.ts`) is a cached tri-state — `claude auth status` parses `loggedIn` (exit code is 0 either way, so parse STDOUT), `codex login status` matches `/not logged in/i`, grok = `XAI_API_KEY ? true` else the device-auth login marker `~/.grok/auth.json` exists (so an in-app Connect login flips it with no env key), agy = `~/.gemini exists ? true : null` — folded into `usable = enabled && present && env_ok && configured !== false`, so an installed-but-not-logged-in CLI is kept OUT of the auto-rotation (**only `false` excludes; `null` stays** — never false-negative a working agent). **Version/model visibility (transparency, not control)**: `agentVersion`/`agentInfo` (installed version + best-effort `model_current` — grok exposes it free via its `Default model:` line (`parseDefaultModel`), codex reads its pinned `~/.codex/config.toml` model (`parseTomlModel`), claude has no free signal so it shows `—`) + `listAgentModels` (grok/agy catalog via `parseModelsOutput`) → `GET /api/agents/:name/info` + `GET /api/agents/:name/models` (+ MCP `get_agent_info`/`list_agent_models`); the `/api/settings` agents array now also carries `configured`/`version`/`can_login`/`models_list` (COMPUTED, not persisted). **Settings** is reorganized into a segmented sub-nav (**Agents / Sources / Automation / Data**, `public/js/10-boot.js` `renderSettings`) that holds every edit in one in-memory working model so sub-tab switches never drop unsaved changes (the floating save bar persists all of it), with agent **connect-cards** (✓ Connected / Connect → / Installed / Not installed) hosting the Connect button + the lazy version/current-model info line + a models disclosure. A completed in-app login calls `invalidateAgentConfigured(agent)` (`src/server.ts` login `onExit`) so the boot-time probe is dropped and the card flips Installed → Connected with no restart; the sub-nav click-handler now slides the ink thumb AND moves the `.active` paper-text state together (mirroring `setHealthSegActive` — previously the active class stuck on the first tab, rendering cream-on-cream). Test coverage: `test/agentLogin.test.js` (allowlist `resolveLoginArgv`, the PTY-invocation builder, `parseDefaultModel`/`parseModelsOutput`/`parseTomlModel`, the grok `auth_state` contract, `invalidateAgentConfigured`). A **quality round** then hardened it: the WS upgrade is rate-limited + timing-safe (`auth.ts` `checkRateLimit`/`tokenMatches`, mirroring the Express guards since upgrades bypass middleware) and the login subprocess strips Cairn's own secrets (`CAIRN_AUTH_TOKEN`/`GARMIN_PASSWORD`) since its PTY output streams to the browser; an active login is SIGKILLed on shutdown (`killActiveLoginSession`); `codex login status` now requires a POSITIVE signal (else `null`, never a false-positive); codex's current model is read from `~/.codex/config.toml` (`parseTomlModel`); `invalidateAgentConfigured` also clears the version/model read-caches (so a login OR a `cairn-update-agent-clis` refreshes the cards without a restart); `runChosen`'s pinned-agent path now goes through `runAgentWithFallback([one])` so a route gets the same JSON-repair retry + breaker + telemetry as the rotation; and the PWA save bar no longer false-flags "Unsaved changes" on load (a `controlAtDefault` guard ignores mount-time noise), the agent-health card speaks plain words not `%` (constitution), and the login modal keeps a failed login readable with Close + Try-again + a focus trap.

Migration **v37** (`profile-endurance-goal`) adds `profile.endurance_goal_json` — the endurance OBJECTIVE, **orthogonal to `primary_discipline`** (discipline says how much running matters vs lifting; the goal says what the running is *for*). Two modes, normalized/validated in `repo` (`normalizeEnduranceGoal`/`getEnduranceGoal`, the latter deriving race timing: `days_to_race`/`weeks_to_race` + a coarse `phase` hint base→build→sharpen→taper): **race** (a dated event the coach periodizes a conservative ramp + taper toward) and **standing** (an ongoing readiness target with NO date — e.g. "stay 10k-ready" — maintain, don't peak). Surfaced via `GET /api/endurance-goal` + MCP `get_endurance_goal`/`set_endurance_goal` (set/clear flows through `setProfile({endurance_goal})`; `PUT /api/profile` also accepts it), a chat `set_endurance_goal` action, fed into `getCoachContext().endurance_goal`, and rendered into every plan-shaping prompt by `renderEnduranceGoal(ctx, focus)` (coach/day-read/session = periodize + prescribe THIS WEEK's runs; nutrition = fuel the build / anchor to maintenance). The coach can now hand back **applyable run prescriptions** for the week as a `parsed.cardio[]` array (or `kind:'cardio'` entries in `changes`), applied SURGICALLY by `repo.setWeeklyRuns` — each run attaches to its `day_number`, REPLACING that day's cardio while leaving strength work intact; a day with no plan yet is created as a dedicated run day (the lighter counterpart to a full `days`→`replacePlan` restructure). PWA: a Running-goal editor (None/Race/Standing) in Me→Profile, the proposal card renders run prescriptions (sage-pinned `.run-line`), and a race-countdown / standing-goal banner (`.end-goal`) tops Progress→Endurance. Also in this round (NO schema change): applying a training proposal / accepting a meal plan now **retires the sibling open drafts** (server-side `'superseded'`, distinct from a user `'discarded'` — `supersedeSiblingTrainingDrafts`/`acceptMealPlan`), and the Coach lists fold older items behind a "Show earlier" disclosure + show a clear "✓ Applied to your plan" confirmation on apply (`sw.js` `cairn-v79`). A follow-on **runner-loop** round (NO schema change — DERIVED reads, `sw.js` `cairn-v80`) closes the loop for runs-from-Garmin (a synced run already lands as an `activities` row + a linked rich `garmin_activities` row, so endurance stats/PRs/day-read read it for free — but nothing tied the PRESCRIBED run to the ACTUAL one): `repo.getRunCompliance(weekStartISO?)` (Monday-anchored, mirrors `computeEnduranceWeekly`) returns this week's prescribed (summed plan `kind='cardio'` items) vs actual (non-strength `activities`) km/sessions + a plain-words `in_words` ("8 of 16 km this week" — NEVER the internal `pct_km` proportion), and `repo.getCardioForDate(date)` returns the day's synced cardio (distance/zones/pace/HR via the `activities ⨝ garmin_activities` LEFT JOIN); both surface as `GET /api/run-compliance` + `GET /api/cardio?date=` + MCP `get_run_compliance`/`get_cardio`, and `run_compliance` is folded into `getCoachContext()`. `prompt.ts` `renderRunCompliance(ctx, focus)` (woven into the coach/day-read/**weekly-read** prompts after `renderEnduranceGoal`) makes the coach adapt next week's running CONSERVATIVELY against actual mileage (fell short → hold/gentle, never make up missed volume; met/over → small progression while guarding recovery). PWA (Today, `03-today.js`): a prescribed cardio item whose run already synced flips to a calm **done card** (`cardioDoneCard` — "✓ Easy run — 8.2 km · ✦ synced from Garmin · mostly Z2 · pace · HR", no log button); unmatched keeps the prescription with "Log this run →" as the fallback + one quiet Garmin **sync-trust** line (`cardioSyncLine` — "synced 2h ago · Sync now", or a calm "this morning's run not synced yet?" when stale; silent when Garmin isn't configured); the day reads **day-type-aware** (`TODAY · A RUN` on a run day, `TODAY · LIFT + RUN` on a mixed day, cardio floated to the top); Progress→Endurance gains a "This week's runs — N of M km" compliance line + the same sync line.

Migration **v36** (`plan-items-exercise-nullable`) rebuilds `plan_items` (copy → drop → rename, guarded to run only when `exercise_id` is still `NOT NULL`) so cardio plan items (no `exercise_id`) can persist on DBs migrated up from an older schema — SQLite can't drop a `NOT NULL` via `ALTER`.

Migration **v35** (`endurance-discipline-and-cardio`) is the first-class endurance/runner+hybrid build: `profile.primary_discipline` (`strength`|`endurance`|`hybrid`, default `strength`) + `profile.endurance_sport`; `plan_items.kind` (`strength`|`cardio`) + `target_distance_km`/`target_duration_min`/`target_zone`/`interval_json` (and a nullable `exercise_id` in the fresh-DB `db.ts` schema); `sessions.kind`. It drives discipline-aware coaching/day-read/nutrition prompts (`renderDiscipline`), endurance weekly stats (`getWeeklyStats().endurance` — mileage/moving-time/longest/time-in-zone/pace-trend) + endurance PRs (`getEndurancePRs` → `GET /api/endurance-prs` + MCP `get_endurance_prs`; **sport-aware** — bests are grouped by canonical sport via `canonicalEnduranceSport` (`src/repo/endurance-sports.ts`) so a best reads in its own modality: pace (min/km at 1/5/10k/half/full) only for foot sports (run/walk), best speed (km/h) + distance/duration for cycling/swim/row — a fast bike "pace" never pollutes a runner's pace PRs; `sports[]` leads with the profile's `endurance_sport` (default running), flat fields mirror the lead sport for back-compat; the Progress→Endurance view renders the primary sport first with cross-training in a quiet disclosure, and `computeEnduranceWeekly`'s pace-trend is sport-scoped the same way), planned cardio in the plan editor, planned-cardio + a "log this run" affordance on Today, a Progress→Endurance view, a discipline selector in Profile + onboarding, and VO2max/RHR/HRV as trending optimal-zone markers in the connected brain (never a 0–100 score). Coaching responses also carry an additive `agent_status` (`ok`|`unconfigured`|`all_failed`) sidecar that drives a calm "coaching is offline" line in the PWA, and `pickAgentOrder()` now filters on a cached CLI-presence probe (`usable = enabled && present && env_ok`) so a fresh install with no agent CLI degrades honestly instead of serving the offline `stub`.

Migration **v34** (`settings-agent-routes`) adds `settings.agent_routes` — an optional per-task agent-routing map (pin chat → one agent, meal drafts → another); empty/null (the default) keeps the `auto` rotation exactly as before (`runChosen` honors a route only when set + the agent is enabled, else falls through).

A **finish-backlog** batch (v34 is its only schema change) also added, additively (`sw.js` `cairn-v68`): the connected-brain **visibility** layer (`evidenceSummary`/`getOutcomeLearnings` → `GET /api/evidence/summary`, `GET /api/learnings` + MCP `get_evidence_summary`/`get_outcome_learnings`, a Settings research toggle, evidence-count badges on directives, and the quiet "What Cairn has noticed" card — F1/F2, pull-never-push); structured **injury impacts** (`getInjuryImpacts` deterministically links active injuries to the exercises they load + calm swap suggestions → `GET /api/injury-impacts` + MCP `get_injury_impacts` + the Life-tab impacts view — F3); a **FHIR-ish health export** (`buildHealthExport` → `GET /api/health-export` + MCP `get_health_export` + a Me→Health "Export health summary" affordance — optimal-zone framing, no scores, never leaks `impact_score` — F4); a **Garmin reconcile-now** card (`listUnreconciledGarminStrength` → `GET /api/garmin/unreconciled` + MCP `list_unreconciled_garmin_strength` + the calm Today reconcile card — F5); and a G4 empty-state fix so the priority-markers loader falls to its calm empty state instead of a stuck placeholder when offline. Repo hygiene from the same batch: a `biome` lint/format config (`npm run lint`/`format`, no tree-wide reformat), an `npm run smoke` HTTP API smoke test (boots the server with `stub`; kept OUT of the offline `npm test`), and `docs/WHY-CAIRN.md`.

Migration **v33** (`family-nutrition-prefs`) adds structured **allergies + dietary restrictions** to BOTH `profile` and `family_members`: meal planning now **hard-excludes declared allergens** — the one constitution-sanctioned hard rule, since an allergy is safety, never a score/gate — and notes optional kid-friendly / household mods, via `renderHouseholdDiet()` in `prompt.ts` (woven into the meal-plan / meal-swap / recipe prompts) plus the Family + Profile PWA forms (`sw.js` `cairn-v62`); kid-mod ages come from the existing `family_members.birthdate`.

A **launch-polish** round (NO schema change — `user_version` stays 33, `sw.js` `cairn-v63`) added: an optional per-IP **rate limiter** (`src/auth.ts` `rateLimitGuard`/`rateLimitDecision`, gated on `CAIRN_AUTH_TOKEN`, in front of `authGuard`); an **iCal plan export** (`repo.buildPlanICS` → `GET /api/plan.ics` + MCP `get_plan_ics` + a Plan-editor "Subscribe to calendar" footer — weekly-recurring VEVENTs, pull-not-push); **last-night sleep/HRV in the Brief** (`repo.latestSleep()` reads the most recent single night's architecture + HRV — Garmin preferred, `daily_metrics` fallback — into `dayRead` `signals.last_night` + `buildDayReadPrompt`, named in plain words, no score); generated reference indexes (`scripts/gen-docs.mjs` / `npm run docs:index` → `docs/API.md` + `docs/MCP-TOOLS.md`); `docs/APPLE_HEALTH.md` (iOS Shortcut → `/api/health-metrics`, incl. Oura/Whoop); and `scripts/backup-example.sh`.

An **agentic-understanding** round (NO schema change beyond one new `CREATE TABLE IF NOT EXISTS` — `user_version` stays 33, `sw.js` `cairn-v65`) reframed two "tracker" features as understanding-not-logging: **supplements** — a new `supplements` table + `SUPPLEMENT_KB`/`parseSupplements`/`understandSupplements(text,{strict})`/`addSupplement`/`list`/`update`/`deleteSupplement`/`supplementsForCoach` (→ `getCoachContext().supplements`); say it once in plain words ("creatine daily, omega-3, some D, whey occasionally") and the KB APPROXIMATES name + dose + cadence + the markers/domains each touches (D3 ↔ vitamin-D, omega-3 ↔ triglycerides, whey ↔ protein floor, creatine ↔ eGFR), folded into every plan-shaping prompt by `renderConnectedBrain`; surfaces are a chat `log_supplement` action, `GET/POST/PUT/DELETE /api/supplements` (+`/understand`), MCP `list/understand/update/delete_supplement`, and a calm "What you're taking" card in Me→Health→Brain — NOT a daily log. **Onboarding** is now frictionless: `buildOnboardPrompt` + `coachOps.onboardFromText` (`POST /api/onboard`, MCP `onboard`) take ONE optional free-text intro (or Skip) and understand it in a single pass (about_me + profile numbers + supplements + injuries + memories), deterministic-base-first so a flaky/absent agent never traps setup; the PWA first-run is a text box, not the old 7-field form.

Migration **v32** (`settings-bg-ops-enabled`) adds `settings.bg_ops_enabled`.

A **dynamic-chat** round added one new table via `CREATE TABLE IF NOT EXISTS` only — **`chat_turns`** (no migration needed) — the durable outbox + job state behind the non-blocking chat queue (`status` queued/running/done/error/canceled, the user/assistant `chat_messages` links, `image_path`/`image_url`, `phase`, `meta`); see `src/chatTurns.ts` and the conversational-chat section.

A **workout-lifecycle UX** round added migration **v31** (`sessions-finished-at` — `sessions.finished_at`: NULL = open/mid-workout, a UTC stamp = finished; `finishSession` now stamps it, `reopenSession` clears it) plus its repo/api/mcp surface: `updateSet`/`updateSessionNotes` (history-correction edits — `PUT /api/sets/:id`, `PUT /api/sessions/:id/notes`, MCP `update_set`/`update_session_notes`), `reopenSession` (`POST /api/sessions/:id/reopen`, MCP `reopen_session`), and `deleteExercise` (`DELETE /api/exercises/:name`, MCP `delete_exercise`) — which REFUSES with `ok:false` when the exercise still has logged sets or sits in a plan (neither table cascades, so a blind delete would orphan a FK). PWA side: Today shows a calm finished-session **done card** (`sessionDoneCard` — summary + "how did that feel?" + log-more/reopen) instead of the live logging surface; History sessions are **tap-to-edit** (`openSessionEdit` — correct any set's numbers + the notes; corrections flow into `trainingSignals` on the next coach read, no re-trigger); the exercise detail gained a **manage row** (change type reps⇄timed via upsert-by-name, delete); off-plan cards got a **remove ✕** (`removeOffPlanCard`); re-adding an exercise with a different mode flips it in place instead of being swallowed; the segmented sub-nav **scrolls** when its pills overflow (`fitSeg` toggles `.seg-scroll` — content-width pills + solid active background, never clips the last pill) instead of cutting off "Calendar"; the rest bar blends with the page (paper-toned bg, not card-white); and `activateTab` is skeleton-first like `switchTab` so the first/programmatic tab paint never blocks on its data fetch. The **elite-build** batch (an agentic-system overhaul, five parallel streams) added migrations v28–v30 plus four new `CREATE TABLE IF NOT EXISTS` tables — `agent_runs` (agent-call telemetry), `app_state` (KV scratchpad for restart-tolerant scheduler stamps), `evidence_cache` (researched/cited evidence), and `suggestions` (suggestion→outcome learning).

Migration **v30** (`memory-self-updating`) adds `memory.updated_at`/`superseded_by`/`confidence`/`last_referenced_at`: memory is now a self-updating store — `addMemory` does semantic (Jaccard) dedup that folds near-duplicates in place, `memoryForCoach()` ranks load-bearing kinds (constraint/injury/preference/decision) over recent chatter and hides superseded rows, `supersedeMemory()` MARKS (never deletes), a quiet nightly `consolidateMemory`/`growAboutMe` pass (`coachOps.ts` + `scheduler.ts`) merges/supersedes/promotes and grows `about_me`, and `reconcileOutcomes` over the `suggestions` table writes durable learnings from what the Brief/session-suggest/nutrition-checkin proposed vs what happened. Chat gains `update_memory`/`supersede_memory` actions.

Migration **v29** (`settings-proactive-enabled`) adds `settings.proactive_enabled` (default on) gating the **proactive scheduler** (`src/scheduler.ts`): nightly quiet insight + weekly read + weekly nutrition-checkin precompute (pull-never-push — STORE a waiting read only, never notify) and a miss-tolerant coach draft (fires when the scheduled slot has passed and `app_state` shows it hasn't run since — survives restarts).

Migration **v28** (`research-enabled`) adds `settings.research_enabled` (default OFF) gating host-side research (`src/research.ts` `researchEvidence` → `evidence_cache`): a web-capable agent returns cited `sources[]`, URLs are validated and sourceless claims discarded; `verifyCitation()` strips unverifiable citations (downgrading the directive to `uncertain`) against a guideline-body allowlist, and `safetyGate()` annotates contraindicated supplement directives (iron+replete ferritin, D3+replete, creatine+low eGFR) — informational, never a hard block. The agentic loop itself was hardened in `src/agents.ts`: a string/escape-aware balanced-brace `extractJson` with truncation salvage, a one-shot JSON-repair retry, a decaying per-agent circuit breaker, interactive-vs-background timeouts, and `agent_runs` telemetry (`recordAgentRun`/`getAgentStats` → `GET /api/agent-stats` + MCP `get_agent_stats` + a calm Settings "Agent health" card — operator telemetry, never a user grade). The connected brain gained **forecasting** (a least-squares marker trend + plain-language projection feeding `prioritizeMarkers`; the internal `impact_score` is stripped before it crosses the API/MCP boundary — never a user-facing score), **acute-vs-chronic recovery baselines** (`getRecoverySummary` returns 7d-vs-30d `recent`/`baseline`/`delta` and surfaces the previously-dropped `acute_load`/`training_readiness`/`fitness_age`), **goal-pace projection** (`projected_goal_date`/`projection_text`), **predictive deload anticipation** in `dayRead`, and deeper marker medicine (Lp(a)/thyroid/B12/folate/magnesium/testosterone/estradiol/eGFR/ALT-AST in `OPTIMAL_ZONES`+`MARKER_MAPPINGS`, plus cross-marker synthesis clusters in `deriveDirectives`). The PWA got skeleton-first paint, a non-blocking Brief (instant cached/deterministic read upgraded in place with the `.is-thinking` filament), chat phase captions, a service-worker update toast + offline banner, reduced-motion/contrast a11y fixes, and a connected-brain provenance line on the Brief/meal cards. A follow-up **trust-build** round (NO schema change — `user_version` stays 30) added the verifiable/trustworthy layer: **code-enforced apply guardrails** (`updateTarget(…, {clamp:true})` via `applyProposal` clamp an off-spec load step to a safe max (~10%/10 lb), HOLD load on an injury-`constraint_note` exercise, and floor a nutrition-target to lean-safe values — every adjustment returned transparently as `clamped:[{exercise,field,requested,applied,reason}]`; a deliberate MANUAL edit (`PUT /api/plan/:day/target`, MCP `update_target`) is NEVER clamped — the user drives); an **agentic self-critique verify pass** for the meal plan + session-suggest (`runVerify` in `coachOps.ts` re-checks the draft against the hard floors/constraints and adopts a RE-VALIDATED fix only, fail-open → result carries `verified:{checked,adjustments}`); an inspectable **evidence** surface (`GET /api/evidence?marker=` + MCP `get_evidence` → `repo.getEvidenceForMarker` over `evidence_cache`, with a server-side http(s) scheme guard on stored URLs); **subprocess env hardening** (`buildAgentEnv` in `src/agents.ts` strips `CAIRN_AUTH_TOKEN`/`GARMIN_PASSWORD`/API keys from the now-web-capable agent CLI's env via a denylist, force-restoring each agent's declared `env_required`); the PWA trust surfaces (a "see the evidence" disclosure on cited directives, a calm "adjusted to a safe step"/"checked against your floors" transparency line on applies, and a "What Cairn did" agent-activity panel in Settings — all score-free; `sw.js` `cairn-v50`); and the first `npm test` harness (above).

Migration **v27** (`day-read-override`) adds `day_reads.override` — the athlete's persisted Brief steer ("rough night" / "give me an easy day" / …). The day-read is no longer a throwaway client-only reshape: `computeDayRead` (`src/dayread.ts`) always persists the read (steer included) via `repo.saveDayRead`, which has a no-clobber guard so a canonical/nightly recompute never wipes a steer; `GET /api/today-read?reset=1` invalidates a steer to return to the canonical read; and `getCoachContext().day_read` now prefers the cached read (agentic sentence + steer) over the bare deterministic `dayRead`, so chat/coach/meal prompts echo the Brief the athlete is actually looking at.

Migration **v26** (`directive-feedback-memory`) adds `health_directives.directive_key` plus trigger snapshot/status metadata so Done/Dismiss becomes agentic feedback memory: handled advice stays quiet for the same marker result, dismissed advice is not repeated unless the marker materially changes.

Migration **v25** (`insights-next-step`) adds `insights.next_step` — the quiet insight's optional concrete suggestion, split out of the `rationale` blob so the Today card can render it as its own scannable line (with the reasoning tucked behind a "why this" disclosure).

Migration **v24** (`garmin-strength-reconciliation`) adds `garmin_activities.exercise_sets_json` (detected strength sets) + `garmin_activities.session_id` (link to the reconciled Cairn session) and `sessions.garmin_json` (the strength physiology blob: HR/zones/calories/training-effect + the agent's one-line read + an `extrapolated` flag) — see "Garmin strength reconciliation" below.

Migrations **v22** (`garmin-daily-full-dataset`) + **v23** (`garmin-activity-detail`) expand Garmin into a full-body dataset: `garmin_daily_metrics` gains ~37 columns (sleep architecture deep/light/REM/awake + restlessness, HR max/min + 7-day avg, `hrv_status`, `stress_max`, body-battery charged/drained, respiration, SpO₂, `skin_temp_dev_c`, calorie breakdown, floors, intensity minutes, `vo2max`/`training_readiness`/`training_status`/`acute_load`/`fitness_age`, and full body composition) and `garmin_activities` gains ~15 (moving time, elevation loss, aerobic/anaerobic TE + label, cadence, power, speed, ambient temp, activity `vo2max`, and `hr_zones_json` HR-time-in-zone). The sync (`src/garmin.ts`) mines the rich `getSleepData`/`getDailyWeightData` payloads it already fetched plus the connector's internal endpoints (`/usersummary-service`, `/hrv-service`, `/metrics-service/...trainingreadiness|maxmet|trainingstatus`, `/activity-service/...hrTimeInZones`), each field best-effort/null-safe in its own try/catch. `upsertGarminDailyMetric` builds its INSERT from `GARMIN_DAILY_COLS` and COALESCE-merges on conflict (a sparse re-sync never nulls a richer earlier value). Signals flow through `getGarminCoachSummary`/`getRecoverySummary` → `renderConnectedBrain` (prompt) + the PWA Brain recovery view; `GARMIN_HR_ZONE_LIMIT` (default 20) bounds per-activity zone calls. See `docs/GARMIN.md`.

The HealthOS vision build added five **new tables** (no migration needed — `CREATE TABLE IF NOT EXISTS` only): `checkins` (optional subjective morning mood/energy/sleep-feel/soreness on a 1–5 scale), `daily_metrics` (source-agnostic wearable rows — Apple Health via Shortcuts etc., parallel to `garmin_daily_metrics`, `UNIQUE(source,date)`), `family_members` (the roster the coach plans around), `health_directives` (the connected-brain cross-domain directives), and `insights` (quiet one-at-a-time cross-domain reads). It added four **column** migrations: **v19** (`sessions-autoregulation`) adds `sessions.soreness`/`sessions.performance`/`sessions.joint_pain` (1-tap autoregulation feedback); **v20** (`profile-about-me`) adds `profile.about_me` (rich free-text understanding); **v21** (`health-directives-marker-uncertain`) adds `health_directives.marker`/`health_directives.uncertain`; **v26** adds `health_directives.directive_key`/`status_at`/`trigger_value`/`trigger_side`/`trigger_date`/`resurfaced_from_id`.
