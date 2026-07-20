# Adaptive Daily Training Execution Plan

**Status (2026-07-20):** Stage 1 is implemented in the local tree and is review-ready. It fixes daily-session persistence and identity, and snapshots the plan selection that is already adaptive. It has not yet been proven in a deployed self-hosted instance. Stages 2–4 below are planned work; the automatic bespoke-composition engine described there has not shipped.

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

Stage 1 introduces `daily_session_compositions` and carries one accepted composition through REST, MCP, the PWA, and the training-log session. It deliberately does **not** invent a new training-decision engine. For plan-backed choices it snapshots `selectedPlanDayForDate()`, which already uses adaptive plan-day selection. For an agent suggestion it persists the returned composition exactly after normalization.

### Persistence invariants

1. Completing a suggestion job does not save or activate its draft. The athlete must select **Use this session**.
2. Acceptance writes an immutable, full normalized snapshot: source, date, title, focus, rationale, time estimate, ordered items, constraints, provenance, and optional plan-day link. Later edits to weekly-plan items do not alter that accepted prescription.
3. At most one composition is active for a date. Prior versions remain as superseded history.
4. Repeating the same normalized prepare request returns the existing active composition and reports it as reused, including an exact `replace:true` retry after logging has begun.
5. A genuinely different replacement is explicit. It is refused after meaningful session state exists, including logged sets, skips, finish state, feedback, notes, or confidently matching synced activity.
6. Plan-backed sources retain their `plan_day_id`; custom/agent sources clear a stale plan link so they cannot masquerade as a weekly template.
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
- `POST /api/daily-session/prepare` accepts `date`, `day_number`, `source`, optional athlete-authored `session`, `constraints`, `provenance`, `replace`, and an authoritative top-level `agent_job_id`. `agent_suggest` requires a completed, matching-date session-suggest job and reloads its canonical result server-side; inline custom payloads use `athlete_override`. It returns `{ok, daily_session, session, reused}`.
- MCP `get_daily_session` mirrors the read.
- MCP `prepare_daily_session` mirrors preparation and replacement.
- Training-session responses include the nullable `daily_session` association.

The PWA now:

- shows **Use this session** on a completed suggestion instead of silently activating it;
- prepares a canonical snapshot before entering the isolated Session screen;
- renders custom work as **Built for today** and plan-backed work as **From plan · _name_**;
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

The final local gates pass: `npm run verify`, `npm run release:check`, built-smoke assertions, and browser coverage of the relevant acceptance flows. Deployment and post-deploy proof remain intentionally outstanding.

## 4. Stage 2 — deterministic daily decision envelope

Stage 2 should make the default selection explainable and reproducible before an agent is involved. Implement it as a pure or near-pure domain decision that consumes a bounded snapshot and returns a versioned decision envelope.

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

## 5. Stage 3 — bounded agent composition and safe exercise introduction

The agent's job is to compose inside the deterministic envelope, not to redefine safety or autonomy policy.

### Composition contract

- The server provides a compact allowlist, exclusions, caps, candidate substitutions, recent prescriptions, and the target session shape.
- The agent returns schema-valid ordered items plus brief athlete-facing rationale.
- A server normalizer verifies every item, clamps values, rejects excluded movements, and recalculates duration/volume bounds.
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

### Learning horizons

- **Strength:** update exercise baselines, progression holds/advances, volume tolerance, and substitution preference from repeated evidence.
- **Endurance:** learn interference and complement patterns across runs, hikes, rides, and strength work without treating all activity as equivalent fatigue.
- **Longevity:** preserve movement variety, sustainable exposure, recovery, and joint-friendly options rather than optimizing only short-term load.
- **Life constraints:** learn recurring time/equipment/family patterns as planning context, never as a compliance score.

Repeated, high-confidence patterns may propose a weekly-template evolution. Structural plan changes continue through the existing proposal/autonomy path and never occur as an unledgered side effect of one daily session. Reversals and athlete overrides are evidence about preference and fit, not mistakes to punish.

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
| 1 — implemented locally | `daily_session_compositions`; required session link, nullable plan link; normalized items, constraints, provenance; version/status history | `getActiveDailySession`, `prepareDailySession`; REST and MCP read/prepare; hydrated session DTO | Older sessions return `daily_session: null`; older clients continue using plan-day sessions |
| 2 — deterministic decision | Add versioned decision metadata such as `policy_version`, `input_fingerprint`, reason codes, and bounded signal timestamps, either in a dedicated JSON field/table or migrated columns | New deterministic `buildDailySessionDecision()`; prepare consumes it by default; optional bounded diagnostic read for UI/explainability | Missing signals fall back to current adaptive plan selection; adding columns requires a numbered migration |
| 3 — agent composition | Persist normalized candidate provenance, validation result, fallback reason, and safe-introduction metadata | `composeDailySession(envelope)` in shared orchestration; REST/MCP remain thin wrappers around prepare | Agent absence or malformed output never blocks a usable deterministic session |
| 4 — outcome learning | Composition-to-outcome reconciliation, modification reason codes, repeated-pattern evidence, and plan-evolution links | Reconcile on finish/feedback; feed bounded evidence to progression and program evolution | Existing logs remain authoritative; learning records are additive and null-safe |
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
| 4 | Repeated evidence supports structural change | A ledgered proposal is created; weekly plan is not silently mutated | Program-evolution/autonomy test |
| All | Existing plan-backed session, JSON export, and SQLite restore | Behavior remains valid with nullable additive fields; JSON export carries history, while SQLite is the restore artifact | Regression, migration, export, and restore checks |

## 10. Implementation sequence

Keep each stage independently reviewable, with shared domain behavior covered before its REST, MCP, and PWA wrappers are expanded. Run focused deterministic tests during implementation, then integrated verification before a release candidate.

### Stage 1 closeout

- Verify persistence, identity, replacement locking, legacy behavior, and REST/MCP parity.
- Run the normal release checks before deploying; use a rendered smoke only when the user-visible acceptance flow needs proof.

### Stage 2 — deterministic decision envelope

1. Add the decision module and fixture-heavy deterministic tests.
2. Once its output schema is accepted, expose it through shared DTOs and thin REST/MCP wrappers.
3. Render the accepted decision kind and concise reason facts without scores.
4. Review precedence, null-safety, health boundaries, and deterministic replay before integrated verification.

### Stage 3 — bounded agent composition

1. Add prompt/schema, server normalization, fallback behavior, and safe-introduction policy in shared domain/orchestration code.
2. Cover adversarial normalization and agent-unavailable fallback cases.
3. Add candidate, accepted, and fallback presentation with explicit athlete choice.
4. Review safety, trust boundaries, identity, and plan non-mutation before integrated verification.

### Stage 4 — outcome learning and evolution

1. Add reconciliation data, finish/feedback integration, confidence rules, and strength/endurance/life-context learning.
2. Connect repeated evidence to existing brain decisions and weekly-plan proposals, including undo semantics.
3. Add athlete-facing explanation/history and operational documentation.
4. Review false-causality risks, reversibility, privacy, and accidental structural mutation; verify migration, export, restore, and release behavior.

## 11. Rollout, back compatibility, and observability

### Deployment sequence

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
8. Verify relevant activity context remains available to coaching; do not claim Stage 2 adaptation until its deterministic envelope is deployed and tested.

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

Adaptive daily training is complete only when Cairn can deterministically choose a safe next-session envelope, optionally compose within it, persist the athlete's accepted session without identity loss, learn cautiously from the outcome, and propose structural evolution through the existing autonomy ledger—with reload, restart, legacy, rollback, and deployed-instance proof. Stage 1 establishes the durable substrate; it is not a claim that this full loop already exists.
