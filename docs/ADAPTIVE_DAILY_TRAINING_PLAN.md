# Adaptive Daily Training Execution Plan

**Status (2026-07-28):** Stages 1–3 are implemented and deployed on the primary self-hosted
instance: durable accepted-session identity, the deterministic decision envelope, and bounded
server-validated agent composition. Stage 4's factual outcome ledger, movement-response retrieval,
and endurance reconciliation are also shipped; automatic structural program evolution remains
behind Cairn's existing proposal/autonomy boundary rather than applying from one session. Local
verification and the primary deployment prove build identity, auth, migration, and database
integrity; the destructive/adversarial scenarios below remain a separate hands-on acceptance plan.

This plan follows Cairn's constitution: the product suggests the next useful move, never turns a weekly plan into a compliance gate, avoids readiness scores, honors athlete overrides, and keeps health information informational rather than diagnostic.

## 1. Current truth and root cause

The observed failure mode was a persistence and identity break, not merely a rendering problem:

- A completed suggestion was reduced to transient client state when the athlete chose to log it.
- Reloading or crossing another route boundary could lose the accepted order, prescription, identity, and rationale.
- Logging could associate that custom work with an unrelated weekly template, making the accepted session appear to be a plan day instead of the athlete's chosen daily session.
- Context such as recent endurance work may affect future prescription, but it was not the immediate data-loss root cause.

The root cause was the absence of a canonical, durable daily-session object between suggestion acceptance and set logging. The client held an ephemeral suggestion while the logging path still treated `sessions.plan_day_id` as the only meaningful session identity.

## 2. North-star contract

Two related objects must remain distinct:

- **Weekly plan:** reusable exposure templates. It expresses useful movement patterns, training emphases, and likely weekly volume. It is not a rigid Monday-through-Sunday compliance counter.
- **Daily session:** the durable answer to “what is my next useful move today?” It may snapshot a weekly template, adjust a template, or be composed specifically for the day. Once accepted, its identity and prescription survive navigation, reload, restart, and logging.

The intended flow is:

```text
weekly templates + recent work + recovery + constraints
                         ↓
             deterministic decision envelope
                         ↓
       optional bounded agent composition or fallback
                         ↓
             durable daily-session snapshot
                         ↓
            logged work + athlete feedback
                         ↓
       cautious future-session and plan evolution
```

The daily decision is a suggestion, not a gate. The athlete can choose another plan day, edit within safe bounds, or do something else without being marked noncompliant.

## 3. Stage 1 — durable accepted session

### Implemented boundary

Stage 1 introduces `daily_session_compositions` and carries one accepted composition through REST, MCP, the PWA, and the training-log session. Adaptive preparation now runs the Stage 2 decision **before** snapshotting and builds the accepted prescription from that exact envelope. Manual plan pulls remain athlete-owned snapshots; agent compositions persist only after server normalization.

### Persistence invariants

1. Completing a suggestion job does not save or activate its draft. The athlete must select **Use this session**.
2. Acceptance writes an immutable, full normalized snapshot: source, date, title, focus, rationale, time estimate, ordered items, constraints, provenance, and optional plan-day link. Later edits to weekly-plan items do not alter that accepted prescription.
3. At most one composition is active for a date. Prior versions remain as superseded history.
4. Repeating the same normalized prepare request returns the existing active composition and reports it as reused, including an exact `replace:true` retry after logging has begun.
5. A genuinely different replacement is explicit. It is refused after meaningful session state exists, including logged sets, skips, finish state, feedback, notes, or confidently matching synced activity.
6. Plan-backed training compositions retain their `plan_day_id`. A no-override rest decision intentionally accepts an unlinked recovery composition. A bounded agent composition retains the envelope's plan link when it was composed from that template.
7. The accepted composition can bind to the existing training `session_id`, and session reads hydrate the associated `daily_session`.
8. Accepting or replacing a daily composition never mutates the weekly plan.
9. Existing sessions and older clients remain valid: `daily_session` may be null, and plan-day behavior continues to work.
10. Persistence is transactional. A failed replacement cannot leave the date with a partially superseded active record.

### Current data shape

`daily_session_compositions` stores:

- identity and lifecycle: `id`, `date`, `version`, `source`, `status`, timestamps;
- linkage: required `session_id` and nullable `plan_day_id`;
- presentation: `title`, `focus`, `why`, `est_minutes`;
- durable payloads: `items_json`, `constraints_json`, and `provenance_json`.

Current sources are `adaptive_plan`, `manual_plan`, `agent_suggest`, and `athlete_override`. Items preserve ordering and support the complete strength or timed/cardio prescription rather than reducing the session to exercise names.

Because this is a brand-new table, current repository convention creates it idempotently from `src/db.ts`; no `user_version` migration is required for Stage 1. Any later column added to this existing table must use the normal versioned migration path.

### Current surfaces

- `GET /api/daily-session?date=YYYY-MM-DD` returns the active composition or null.
- `GET /api/daily-session/preview?date=…&override=…&train_anyway=…` is a read-only view of the exact adaptive candidate shown before Start. It returns the calm public summary plus `input_fingerprint`, and never records a decision or creates a workout row.
- `POST /api/daily-session/prepare` accepts `date`, `day_number`, `source`, optional athlete-authored `session`, `constraints`, `provenance`, `replace`, the explicit `train_anyway` athlete override, an authoritative top-level `agent_job_id`, and `expected_input_fingerprint` for adaptive compare-and-set acceptance. A stale fingerprint returns a fresh preview without writing. `agent_suggest` requires a completed, matching-date session-suggest job and reloads its canonical result server-side; inline custom payloads use `athlete_override`. It returns `{ok, daily_session, session, reused}`.
- MCP `get_daily_session` mirrors the read.
- MCP `preview_daily_session` mirrors the read-only adaptive preview.
- MCP `prepare_daily_session` mirrors preparation and replacement.
- `POST /api/training-symptoms/observation` and MCP
  `record_exercise_symptom_observation` share one atomic session-bound command for pain-present and
  pain-free movement evidence. The command validates the canonical movement exposure, keeps
  pain-present precedence for contradictory same-exposure taps, and participates in durable
  idempotent replay.
- Training-session responses include the nullable `daily_session` association.

The PWA now:

- shows **Use this session** on a completed suggestion instead of silently activating it;
- prepares a canonical snapshot before entering the isolated Session screen;
- renders decision-backed work as **Adapted for today** or **Training by choice**, with the stored rationale;
- renders the authoritative adaptive preview on Today, accepts only its exact fingerprint, and keeps stale/offline queued setup behind a visible attention barrier;
- places a quiet **Movement check** in prescribed strength cards on Today and Session, with
  movement-specific pain-present/pain-free recording and bounded current-session choices to ease,
  use a known-tolerable same-pattern option, stop, or skip without changing the weekly plan; a
  stopped card uses a bounded date/session/movement-only local marker so it stays stopped across a
  rerender without storing symptom text, while the server observation and logged sets remain the
  outcome truth;
- preserves generated order and full prescriptions;
- restores the accepted session after navigation or reload;
- uses explicit replacement when the athlete selects a different manual plan day;
- surfaces the server refusal when replacement is unsafe after logging has begun.

### Stage 1 verification

The integrated tests cover:

- persistence across fresh reads and process-level repository reuse;
- idempotent prepare and one-active-version behavior;
- plan snapshot and custom-session identity;
- explicit replacement and refusal after logged sets;
- normalization, bounds, invalid input, and legacy/null compatibility;
- PWA acceptance, canonical caching, reload restoration, labels, item order, and replacement behavior;
- compatibility with the existing Today session controller and performance UI.

The integrated local gates pass: `npm run verify`, `npm run release:check`, built-smoke assertions,
and browser coverage of the relevant acceptance flows. The primary deployment has separately
verified the exact build identity, auth boundary, schema migration, and database integrity.

## 4. Stage 2 — deterministic daily decision envelope

Stage 2 makes the default selection explainable and reproducible before an agent is involved. It is
a deterministic domain decision over a bounded snapshot and returns a versioned decision envelope.

### Required inputs

- existing plan selection from `selectAdaptivePlanDay()` / `selectedPlanDayForDate()`;
- recent muscle exposure from `recentMuscleLoad()`;
- recent running, hiking, and other endurance interference from `recentEnduranceImpacts()`;
- `dayRead()` plus unified recovery data;
- recent check-ins and session feedback (`soreness`, `performance`, `joint_pain`);
- active injury and life-context constraints;
- `getProgramState()` and progression recommendations;
- available equipment, time, athlete override, and current goal context.

### Decision precedence

1. Preserve an already accepted active composition unless the athlete explicitly asks to replace it.
2. Treat injury constraints, joint pain, and unavailable equipment as hard exclusions or conservative substitutions.
3. Use very low recovery, unusual soreness, repeated underperformance, illness/travel windows, and consecutive training days to cap intensity or choose easy/rest.
4. Account for recent run/hike load before assigning conflicting lower-body volume or intensity.
5. Balance due versus recently saturated muscle exposures; do not infer readiness from weekday alone.
6. Apply progression only when recent performance supports it; hold or regress conservatively otherwise.
7. Fit the session to known time and life constraints.
8. Use template rotation/weekday only as a stable fallback after the more meaningful signals.

### Envelope output

The output should be data, not prose:

- decision kind: `train`, `easy`, or `rest`;
- selected template or `custom` intent;
- required, allowed, reduced, and excluded movement/muscle groups;
- volume, intensity, and duration caps;
- candidate exercises and substitutions with reason codes;
- hard constraints and soft preferences;
- deterministic rationale facts safe to render;
- `policy_version`, `input_fingerprint`, and source timestamps.

The same bounded input must produce the same envelope. If optional sources are absent, the policy must degrade to the existing adaptive plan selector rather than fail or fabricate certainty. Stage 2 preparation persists both the resulting snapshot and enough decision metadata to explain why it was chosen without storing private raw health payloads in logs.

### Authoritative acceptance (implemented)

`adaptive_plan` preparation has one authority chain: normalized request → `daily_decision_v2` envelope → bounded composition → accepted session. The envelope carries both `baseline_kind` and the resulting `kind`, the selected plan identity, explicit `train_anyway`, caps, exclusions, candidates, and its fingerprint. That exact normalized decision context is embedded in `constraints_json` and `provenance_json`, returned as `daily_session.decision`, and linked to the matching `daily_session_decisions` row.

- A rest baseline with no override accepts a deterministic easy-recovery composition, never a full lifting template.
- Explicit **Train anyway** changes the envelope to `kind:"train"` while retaining `baseline_kind:"rest"` and enforcing reduced volume, held/easy intensity, injury exclusions, and a short duration cap.
- A manual plan pull remains the athlete's requested template. Cairn does not relabel the policy read; it carries the same safety context and presents it as **Training by choice** when the baseline did not call for training.
- The boolean override is part of normalized request identity. The legacy exact phrase `train anyway` is still recognized so old cached or queued clients remain replayable.
- Cached active-ID assertions remain read-only and shape-compatible. The PWA does not locally stage a raw weekly plan as a train-anyway prescription while offline because it cannot reproduce current server safety bounds.

## 5. Stage 3 — bounded agent composition and safe exercise introduction

The agent's job is to compose inside the deterministic envelope, not to redefine safety or autonomy policy.

### Composition contract

- The server provides a compact allowlist, exclusions, caps, candidate substitutions, recent prescriptions, and the target session shape.
- The agent returns schema-valid ordered items plus brief athlete-facing rationale.
- A server normalizer verifies every item, clamps values, rejects excluded movements, and recalculates duration/volume bounds.
- Plan-backed fallback applies candidate exclusions/substitutions/holds/deloads, per-item set/load/seconds caps, a total working-set cap, and the overall duration cap. Unknown or thin-history movements never receive a fabricated load.
- Invalid, empty, timed-out, or unavailable agent output falls back to the deterministic Stage 2 snapshot.
- The accepted normalized result is persisted as a new daily-session composition; raw agent text is never the execution source of truth.

### Safe exercise introduction

An unfamiliar exercise must be treated as a controlled baseline experiment:

- Prefer existing exercises or canonical, approved substitutions.
- Permit at most one novel movement family in a session unless the athlete explicitly asks for a broader change.
- Require equipment and injury compatibility plus an explicit reason for the substitution.
- When no performance baseline exists, prescribe conservative technique volume and no falsely precise working load; label the intent as establishing a baseline.
- Preserve a stable exercise canonical ID and provenance so future outcomes attach to the same movement.
- Never add the movement to the weekly plan merely because it appeared in one daily composition.

An exercise already present in a weekly template must not be mistaken for automatic plan mutation merely because it also appears in a daily composition.

## 6. Stage 4 — outcome learning and plan evolution

Stage 4 closes the loop without turning one day into a sweeping program rewrite.

### Outcome reconciliation

After a session, reconcile:

- what was suggested and accepted;
- what was started, completed, modified, reordered, substituted, or skipped;
- achieved load/reps/duration and progression evidence;
- athlete feedback and any joint-pain signal;
- relevant endurance work and life/recovery confounders.

Store derived outcome facts with confidence and reason codes. Do not interpret a skipped or reduced session as poor adherence when travel, time, recovery, pain, or another activity explains it.

The additive outcome ledger now stores `schema_version: 2`, stable composition-item/movement/intent
identity, the complete prescribed and achieved set dose, and a challenge verdict that considers
sets together with load, reps, or duration. Set add/update/delete, skip/restore, reopen, finish, and
feedback writes plus same-date manual/Garmin activity insert/update/delete refresh the same outcome
best-effort. Active movement-relevant symptom-ledger evidence participates even when the session's
legacy joint-pain text is empty. `recentMovementResponse()` first selects matching movement and
prescription-intent outcomes and only then applies its bounded evidence window; unrelated recent
workouts therefore cannot hide sparse comparable history. It needs at least two comparable
completed moderate/high-confidence outcomes and returns only `insufficient`, `contradictory`,
`earned_absorbed`, or `earned_hold`. Only the two most recent comparable exposures decide, so old
conflicts cannot outvote a newer repeated response indefinitely. Recovery overlays, athlete
overrides, partial work, travel/illness, relevant symptoms, and endurance-loaded days remain legible
facts but are not causal progression evidence.

Accepted cardio items add one-to-one `endurance_evidence` with stable prescription identity, the
prescribed sport/label/duration/distance/zone/interval, and the achieved activity
sport/name/duration/distance/pace/heart-rate/zones/source. Matching is same-date and canonical-sport
bounded, one actual effort can satisfy at most one item, generic cardio remains low confidence, and
missing zones remain unknown. The factual completion verdict distinguishes simple dose completion,
observed non-interval quality, quality contradicted by available zones, quality that cannot be
verified, dose shortfall, and no match. Aggregate time in a zone never proves interval
count/order/recovery completion. A matched cardio-only session can complete operationally without a
strength Finish tap, but only simple dose completion or directly observed non-interval quality can
read as completed-as-suggested; mixed strength/cardio retains strength finish semantics. Planned
cardio is not its own `other_activity` confounder, while a mixed session remains non-comparable for
strength progression. This factual endurance evidence does not progress duration, distance, zone,
or intervals.

`GET /api/daily-session/outcome` and MCP `get_daily_session_outcome` preserve that complete
machine-readable reconciliation while adding one deterministic `athlete_read`. The completion card
renders only its server-authored learning sentence and, when the current progression engine confirms
two clean comparable same-intent exposures, at most one earned next-exposure sentence. Older,
partial, recovery, symptom-relevant, travel, illness, endurance-loaded, or athlete-overridden
outcomes never promise progression. A missing or failed read leaves the existing completion card
unchanged.

### Learning horizons

- **Strength:** update exercise baselines, progression holds/advances, volume tolerance, and substitution preference from repeated evidence.
- **Endurance:** learn interference and complement patterns across runs, hikes, rides, and strength work without treating all activity as equivalent fatigue.
- **Longevity:** preserve movement variety, sustainable exposure, recovery, and joint-friendly options rather than optimizing only short-term load.
- **Life constraints:** learn recurring time/equipment/family patterns as planning context, never as a compliance score.

Repeated, high-confidence patterns may propose a weekly-template evolution. Structural plan changes continue through the existing proposal/autonomy path and never occur as an unledgered side effect of one daily session. Reversals and athlete overrides are evidence about preference and fit, not mistakes to punish.

Weekly evolution also has a temporal-truth boundary. Historical rationale uses structured
reason/evidence/as-of/source provenance and is rendered against the date it was generated, never as
timeless “yesterday” copy. Proposal creation fingerprints the weekly template plus relevant training
evidence; quiet or announced apply compares that snapshot again and holds changed or unverified
inputs for review. The weekly template keeps stable prescription facts, while the decision ledger
keeps dated narrative and Undo. Therefore a daily immutable composition copied from the template
cannot accidentally preserve a relative story whose meaning changes with the calendar.

## 7. Non-goals, safety, autonomy, and undo

### Non-goals

- No rigid push/pull/legs counter or calendar streak that overrides current context.
- No readiness, adherence, or health score.
- No medical diagnosis or automatic clinical recommendation.
- No rewriting completed session history when future recommendations change.
- No weekly-plan mutation from accepting, editing, or completing one daily session.
- No claim that Stages 2–4 are present merely because Stage 1 stores provenance.

### Autonomy

- An athlete-requested prepare/accept action may apply immediately.
- A bounded deterministic same-day adjustment may quiet-apply only at a natural boundary allowed by `lead_mode`, and must remain visible and reversible.
- A structural weekly-plan change must be announced through the existing brain-decision/proposal policy.
- Goal-identity changes and anything clinical always require the athlete to choose.
- An athlete override wins unless it violates a hard server safety bound; the UI should explain the narrow bound without moralizing.

### Undo

Stage 1 provides the safe primitive of explicit replacement before logging and retains superseded versions. A complete one-tap Undo remains roadmap work:

- before any logged set, reactivate the prior valid composition as a new version;
- after logging begins, preserve history and apply the requested change only to remaining/future work;
- ledger autonomous changes and their reversals through the existing brain-decision system;
- never delete completed sessions or sets to simulate an undo.

## 8. Data and API roadmap

| Stage | Data | API/domain surface | Compatibility rule |
|---|---|---|---|
| 1 — shipped | `daily_session_compositions`; required session link, nullable plan link; normalized items, constraints, provenance; version/status history | `getActiveDailySession`, `prepareDailySession`; REST and MCP read/prepare; hydrated session DTO | Older sessions return `daily_session: null`; older clients continue using plan-day sessions |
| 2 — shipped | Versioned decision metadata with `policy_version`, `input_fingerprint`, reason codes, and bounded signal timestamps | Deterministic `buildDailySessionDecision()`; prepare consumes it by default; bounded diagnostics support UI/explainability | Missing signals fall back safely; additive columns follow numbered migration rules |
| 3 — shipped | Normalized candidate provenance, validation result, fallback reason, and safe-introduction metadata | `composeDailySession(envelope)` in shared orchestration; REST/MCP remain thin wrappers around prepare | Agent absence or malformed output never blocks a usable deterministic session |
| 4 — factual loop shipped | `daily_session_outcomes` schema-v2 JSON with stable identity, complete prescribed/achieved dose, context exclusions, and bounded repeated-response evidence | Reconcile after every outcome-changing session mutation; structural progression remains a separate proposal/autonomy step | Existing/legacy JSON remains readable; recovery/override/partial/confounded outcomes never drive structural deload |
| Undo/observability | Composition lineage, brain-decision linkage, aggregate counters | Explicit revert endpoint/tool only after server policy is defined | Revert creates history; it never deletes logged work |

Public DTOs should expose the accepted prescription and concise explanation, not internal medical records or an unbounded raw coaching context. REST and MCP must continue to call the same domain use cases.

## 9. Acceptance matrix

| Stage | Scenario | Required result | Gate/evidence |
|---|---|---|---|
| 1 | Suggestion finishes but athlete does not accept | No active composition is created | Client/controller test plus repository read |
| 1 | Athlete accepts agent suggestion | Exact normalized identity, order, prescription, rationale, constraints, and provenance persist | Repository + REST/MCP tests |
| 1 | Reload/restart before logging | Same active composition and session identity return | Integration test and deployed-instance restart smoke |
| 1 | Custom composition begins logging | `plan_day_id` remains null and subsequent sets bind to the same session | Repository/API test and live smoke |
| 1 | Different plan day chosen before logging | Explicit replacement creates a new active version and supersedes the old one | Repository + PWA test |
| 1 | Replacement attempted after a set | Request is refused; accepted and logged history remain unchanged | Repository/API test |
| 2 | Recent lower-body endurance load conflicts with nominal leg template | Envelope reduces/substitutes lower-body stress with deterministic reason codes | Fixture-driven domain test |
| 2 | Recovery/check-in sources are absent | Decision falls back safely to existing adaptive selection | Null/missing-source test |
| 2 | Same bounded snapshot is evaluated twice | Equivalent envelope and input fingerprint | Determinism test |
| 3 | Agent proposes excluded or excessive work | Server rejects/clamps it and uses deterministic fallback if needed | Normalizer and orchestration tests |
| 3 | Agent proposes a novel exercise | Conservative baseline rules, canonical identity, and provenance are enforced | Safe-introduction tests |
| 4 | Athlete modifies or skips work for a known constraint | Outcome records the fact without an adherence judgment | Reconciliation test |
| 4 | Pain-present or pain-free is recorded beside a prescribed movement | Exact session/date/movement evidence survives retry; pain-free does not clear or medically validate the symptom | Domain, REST/MCP parity, outbox, and card/controller tests |
| 4 | Two comparable movement exposures sit behind unrelated newer workouts | Matching movement/intent history is found before the bounded window is applied | Sparse-history reconciliation test |
| 4 | Accepted cardio has one same-date matching effort | Exact prescribed/achieved facts reconcile once; cardio-only completion needs no strength Finish tap and promises no progression | Reconciliation and athlete-read tests |
| 4 | Repeated evidence supports structural change | A ledgered proposal is created; weekly plan is not silently mutated | Program-evolution/autonomy test |
| All | Existing plan-backed session, JSON export, and SQLite restore | Behavior remains valid with nullable additive fields; JSON export carries history, while SQLite is the restore artifact | Regression, migration, export, and restore checks |

## 10. Implemented stages and remaining extensions

Stages 1–3 and Stage 4's factual learning loop are shipped. The sequence below is retained as the
maintenance boundary for future extensions: keep shared domain behavior covered before REST, MCP,
and PWA wrappers expand, and keep structural program evolution behind the proposal/autonomy ledger.

### Stage 1 — durable identity (shipped)

- Verify persistence, identity, replacement locking, legacy behavior, and REST/MCP parity.
- Run the normal release checks before deploying; use a rendered smoke only when the user-visible acceptance flow needs proof.

### Stage 2 — deterministic decision envelope (shipped)

1. Keep the decision module and fixture-heavy deterministic tests authoritative.
2. Evolve its schema through shared DTOs and thin REST/MCP wrappers.
3. Preserve the accepted decision kind and concise reason facts without scores.
4. Re-review precedence, null-safety, health boundaries, and deterministic replay after extensions.

### Stage 3 — bounded agent composition (shipped)

1. Keep prompt/schema, server normalization, fallback behavior, and safe-introduction policy in shared domain/orchestration code.
2. Preserve adversarial normalization and agent-unavailable fallback coverage.
3. Keep candidate, accepted, and fallback presentation explicit about athlete choice.
4. Re-review safety, trust boundaries, identity, and plan non-mutation after extensions.

### Stage 4 — factual loop shipped; structural expansion remains bounded

1. Maintain reconciliation data, finish/feedback integration, confidence rules, and strength/endurance/life-context learning.
2. Route any deeper repeated-evidence action through existing brain decisions and weekly-plan proposals, including Undo semantics.
3. Extend athlete-facing explanation/history and operational documentation only when it improves a decision.
4. Re-review false-causality risks, reversibility, privacy, and accidental structural mutation; verify migration, export, restore, and release behavior.

## 11. Rollout, back compatibility, and observability

### Repeatable deployment and rollback sequence

1. Capture a current database backup and JSON export using the documented backup procedure.
2. Run local integrated gates and build the exact artifact to deploy.
3. Deploy the exact verified artifact using the source-checkout or published-image procedure in `docs/OPERATIONS.md`; do not substitute an unverified private image for a public-release requirement.
4. On first boot, verify `daily_session_compositions` and its active/date indexes exist. Because the table is additive, do not change `user_version` solely for Stage 1.
5. Confirm existing plan-backed sessions load with `daily_session: null` or their normal plan identity and that exports still complete.
6. Keep the prior deploy artifact and backup available. Roll back the application without dropping the additive table; retained composition rows are harmless to an older binary.

### Deployed-instance verification

Run this against a fresh test date after deployment; do not alter existing athlete history:

1. Generate a session suggestion and verify job completion alone creates no active daily composition.
2. Select **Use this session** and verify the prepare response contains the complete ordered prescription and `agent_suggest` identity.
3. Reload the PWA and query `GET /api/daily-session`; verify the same composition/version returns.
4. Restart the Cairn service and verify the accepted composition still restores.
5. Log the first set and verify it attaches to the same training `session_id`; for a custom suggestion, `plan_day_id` remains null.
6. Attempt replacement after logging and verify the server refuses without changing the active composition or logged set.
7. Separately accept a plan-backed selection and verify its template link and **From plan** label survive reload.
8. Verify relevant activity context remains available to coaching and the accepted session preserves
   the same deterministic envelope across reload and restart.

### Observability

Add aggregate, privacy-safe telemetry before broadening autonomy:

- prepares by source and outcome (`created`, `reused`, `replaced`, `refused`);
- active compositions restored after reload/restart;
- accepted suggestion to first-set conversion and time-to-start;
- agent validation/fallback categories without raw prompts or health payloads;
- athlete replacement, modification, and undo rates;
- composition/session identity mismatches, which should remain zero.

Operational logs must not include exercise rationale containing private health context, raw check-ins, medical-marker details, or full composition payloads. Observability should answer whether the system preserved and safely executed the decision—not expose why the person needed it.

## Definition of done

Adaptive daily training is complete only when Cairn can deterministically choose a safe
next-session envelope, optionally compose within it, persist the athlete's accepted session without
identity loss, learn cautiously from the outcome, and propose structural evolution through the
existing autonomy ledger—with reload, restart, legacy, rollback, and deployed-instance proof.
Stages 1–4 now provide that bounded loop; the remaining work is deeper hands-on acceptance and
cautious expansion of structural learning, not a return to transient session identity.
