# Elite Brain implementation handoff

_Integrated 2026-07-09 against `docs/ELITE-BRAIN-PLAN.md`._

## Outcome

Cairn now has an accountable, whole-person coaching loop rather than a collection of snapshot suggestions:

1. Material coaching decisions are recorded with falsifiable expectations.
2. Mature expectations are evaluated deterministically against later data.
3. Repeated outcomes become bounded personal-response modifiers; universal safety floors remain fixed.
4. Material signals enter one coalesced durable review path instead of route-specific agent calls.
5. Lead mode can quietly apply bounded changes, announce structural changes, or hold for review according to one server policy.
6. Every autonomous training-plan change is explained at the affected exercise and has exact server-owned Undo; Chat can cancel an announcement or put an applied change back in one turn. Meal-plan state changes are ledgered but never claim Undo without a stored before-snapshot.
7. Specialists can investigate bounded history through nine read-only capabilities and reconcile material cross-domain conflicts into one voice.
8. Learned, Today, weekly-read, and operator surfaces expose accountability without exposing internal scores, raw prompts, tool logs, or chain-of-thought.

The original lunch failure mode is explicitly guarded: a food-only turn cannot trigger training work. A later training change is handled in the background and appears with its reason on the affected exercise when it matters.

## Delivered architecture

### Contracts and safety kernel

- `src/brain/*-contract.ts` owns strict decision, expectation, evaluation, specialist, query-loop, and conference shapes.
- `src/repo/nutrition-safety.ts` enforces lean-safe calorie/protein floors and atomic allergen exclusions in code.
- `test/brain-scenarios/` pins ten longitudinal cross-domain safety scenarios.
- `npm run brain:eval` is the deterministic offline quality gate; `npm run brain:eval:agent` is the opt-in connected comparison gate.

### Decision, outcome, and personal-response loop

- `brain_decisions`, `brain_expectations`, `brain_evaluations`, and `brain_tool_calls` are the durable accountability ledger.
- `brain_rollbacks` stores exact server-only before/after reversal snapshots without widening the public decision contract. Training Undo uses a three-way, field-scoped restore, so later manual edits or newer decisions are never erased by an older rollback.
- The nightly scheduler evaluates mature expectations, preserves inconclusive history when late data arrives, then rebuilds the personal-response model.
- `what_works_for_you` is a typed, bounded coach-context block with evidence counts, recency, contradiction handling, and safety clamping.
- The whole-person trajectory reports each domain as `better | holding | worse | unknown`, names phase trade-offs, and forces revision on unexplained regression. For strength/hybrid profiles, strength and muscle development stay the optimization goal in every body-composition phase; avoiding strength or lean-mass loss is a universal floor, not the aspiration. Established lifts are compared against themselves so one regression cannot hide inside gains elsewhere.

### Signals, autonomy, and background work

- `emitBrainEvent()` is wired at training, activity, recovery, nutrition, health, medication, supplement, body, context, profile, goal, and plan write chokepoints.
- Fingerprinting, coalescing, significance, and durable cooldowns ensure a finished session yields one review rather than one review per set.
- `brain_review` and `case_conference` use the existing durable job lifecycle and never block a user-facing request. All agentic MCP coaching operations now return a durable job immediately and expose list/get/cancel job tools.
- `decideAutonomyTier()` owns all five postures. Settings exposes only Lead, Announce first, and Review everything.
- Quiet nutrition changes wait for the next day; an in-progress training session is never rewritten underneath the athlete.
- Announced changes land at their effective boundary unless canceled. Surprise budgets and 90-day veto-rate demotion limit overreach.
- `docs/VISION.md` now contains Amendment 1, with the former propose-only contradictions removed.

### Depth and multidisciplinary reasoning

- Nine shared read capabilities cover exercise, training, marker, recovery, nutrition, body-composition, life-context, decision, and current-plan history. Coach-read runs explicitly disable ambient MCP configuration; the server-owned query loop remains the only execution authority.
- The provider-neutral query loop enforces six ordinary or twelve conference calls, three rounds, byte ceilings, deadlines, cancellation, and snapshot fallback.
- The optional loopback MCP adapter uses a random per-run path and Claude strict-MCP config; ambient MCP tools cannot leak into the run.
- Case conferences share one immutable snapshot, run optional specialists in parallel, detect six deterministic conflict classes, clamp autonomy to the strictest specialist boundary, persist bounded opinions, and emit one conductor voice.
- A monthly, phase-boundary, or unexplained-regression scheduler check queues the standing whole-person revision conference.

### Nutrition, lifestyle, and clinical grounding

- Food enrichment can preserve coarse sodium, potassium, calcium, iron, omega-3, saturated-fat, added-sugar, alcohol, caffeine, and food-quality patterns with explicit basis/confidence. It never manufactures precise micronutrient values from a restaurant photo.
- Meal plans now account for preparation time, household fit, cost/availability, frequent foods, and coarse nutritional adequacy—not macros alone.
- Existing event-to-recovery and evaluated-decision learning connects sleep/life patterns to later recommendations only after evidence thresholds. Repeated explicitly logged alcohol or late caffeine can now produce a personal next-sleep pattern only with both exposed and clean comparison nights; the language remains observational.
- Guideline and research evidence carry source scope, version, review date, expiry, freshness, and effective confidence.
- Material clinical claims require claim-to-source verification. Organization names alone no longer verify a citation; stale or mismatched evidence is downgraded and remains inspectable.

### Calm accountability surfaces

- Affected exercises show what changed, why, and one-tap Undo. Meal-plan accept/discard/supersede transitions are accountable and measurable; manual swaps/edits remain explicit user actions and therefore do not manufacture autonomous rationale or Undo.
- Structural announcements appear as a calm next-boundary card with a working Chat “Hold on” path.
- The weekly read may mention at most one mature outcome verdict.
- Stand → Learned now includes decisions, expectations, outcomes, and earned personal-response patterns.
- Settings includes operator-only bounded decision/read diagnostics.
- UTF-8 subprocess decoding and the markdown renderer preserve split multibyte characters such as `·`, `é`, and `—`; the replacement glyph seen in the reported screenshot is covered by regression tests.

## Schema and compatibility

- Migration v59 adds `settings.lead_mode`.
- Migration v60 adds evidence-governance metadata and safely backfills legacy evidence as source-only/unverified rather than pretending claim verification.
- Fresh databases receive every new table/column directly from `src/db.ts`.
- Export/backup includes the decision ledger and rollback records.
- REST and MCP remain thin mirrors over shared domain/repo services. Generated indexes currently report 241 REST routes and 199 MCP tools.
- The PWA cache is `cairn-v452`.

## Verification evidence

- `npm run brain:eval` — pass, 7 invariant suites over all ten scenarios.
- `npm test` — pass, 288 test files across 8 isolated database workers.
- `npm run lint` — pass, 735 files checked.
- `npm run verify` — pass, including docs, action pins, launch safety, client contract, build, public scripts, service-worker cache, and the full isolated test suite. The combined sandboxed `verify:full` reached only a localhost-probe `EPERM`; its identical built HTTP smoke rerun with localhost permission passed all 68 assertions.
- `npm run smoke:browser:built` — pass in Chrome: 17 routes and 13 interactive workflows with no runtime errors.
- The connected harness now fails unless conference synthesis improves over the bounded snapshot-only baseline, cites only specialist-pinned evidence, and has no safety regression. It defaults to all ten material scenarios and can persist a release report via `BRAIN_EVAL_REPORT`.
- `BRAIN_EVAL_AGENT=codex BRAIN_EVAL_MODEL=gpt-5.4 BRAIN_EVAL_SCENARIOS=maintenance-must-not-drift ...` — pass after the stricter gate: snapshot-only baseline had two missing evidence keys; conference synthesis had zero missing/invented keys, zero unsafe autonomy findings, and one measured improvement.
- `npm run docs:check` and `git diff --check` — pass.

The configured local Sol model could not be used for the connected gate because the installed Codex CLI reported that it requires a newer CLI. The harness failed closed, then the compatible connected `gpt-5.4` model was pinned for the bounded release check. Model-selection intent and verification rules are documented in `docs/CODEX-MULTIAGENT-ORCHESTRATION.md`.

## Deployment state

Implementation and release gates are complete in this worktree. No target-device deployment was performed from this checkout: deployment changes external state and should use the normal backup, merge/release, deploy, and live-data validation procedure in `docs/OPERATIONS.md`.

This worktree is based at `34b105c1`. During implementation, `main` advanced through `860014f5` with the parallel body-figure and documentation cleanup series. The safe content delta has been reconciled manually: finalized typed body-figure sources are preserved; the five retired working-plan documents are deleted; and the `CLAUDE.md`, operations-tooling, and client-build notes from `main` are carried forward. The branch topology is still intentionally unmerged and uncommitted so the owner can choose the final integration/commit boundary without clobbering unrelated work.
