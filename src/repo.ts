// Barrel: repo.ts was split into cohesive domain modules under src/repo/.
// External code imports from "./repo.js" by name; every public symbol is
// re-exported here so those imports keep working unchanged. The split is a pure,
// behavior-preserving relocation — see the individual modules for the logic.
export * from "./repo/exercises.js";
export * from "./repo/exercise-canon.js";
export * from "./repo/exercise-guide.js";
export * from "./repo/plan.js";
export * from "./repo/proposal-truth.js"; // temporal provenance + compare-and-set evidence for enduring plan changes
export * from "./repo/training-read.js";
export * from "./repo/sessions.js";
export * from "./repo/adaptive-session.js";
export * from "./repo/profile.js";
export * from "./repo/location-context.js";
export * from "./repo/training-intent.js";
export * from "./repo/endurance-capacity.js";
export * from "./repo/activities.js";
export * from "./repo/memory.js";
export * from "./repo/brain-decisions.js";
export * from "./repo/brain-evaluations.js";
export * from "./repo/nutrition.js";
export * from "./repo/nutrition-progress.js"; // honest multi-week recorded-intake read; gaps and unknown nutrients stay null
export * from "./repo/fuel-state.js"; // pace-aware protein read for the Brief's FUEL line + day-read signal
export * from "./repo/fuel-demand.js"; // which days carry the week's biggest work (long run / quality / heavy lower / double)
export * from "./repo/intake-window.js"; // completed-day food coverage; missing days stay unknown
export * from "./repo/underfueling.js"; // uncertainty-aware multi-channel fuel protection read
export * from "./repo/underfueling-snapshot.js"; // fully hydrated, memoized protective read shared by every planning surface
export * from "./repo/dietary-constraints.js";
export * from "./repo/fueling.js"; // one-tap fueling follow-through after an applied target change
export * from "./repo/chat.js";
export * from "./repo/settings.js";
export * from "./repo/apple-health.js";
export * from "./repo/art-ledger.js";
export * from "./repo/agent-telemetry.js";
export * from "./repo/diagnostics.js";
export * from "./repo/request-metrics.js";
export * from "./repo/app-state.js";
export * from "./repo/meal-refresh-retry.js";
export * from "./repo/meal-directive-trigger.js";
export * from "./repo/meal-plan-refresh.js"; // is a weekly refresh a rotation or a change?
export * from "./repo/scheduler-operations.js";
export * from "./repo/client-tz.js"; // last-seen device zone for the TZ-correct Brief warm
export * from "./repo/lab-units.js";
export * from "./repo/marker-canon.js";
export * from "./repo/health.js";
export * from "./repo/imaging.js";
export * from "./repo/health-outcomes.js"; // intervention -> follow-up marker outcome annotations
export * from "./repo/ccda.js";
export * from "./repo/standing.js";
export * from "./repo/risk.js"; // cardiovascular risk input/enhancer/counterfactual read
export * from "./repo/doctor-loop.js"; // missing-workup + lab/DEXA retest attention policies
export * from "./repo/doctor-packet.js"; // export-ready doctor packet composing focus/risk/retests/outcomes
export * from "./repo/next-checkup.js"; // athlete-facing "next checkup" read: due/upcoming rechecks + follow-through + prep
export * from "./repo/prevent.js"; // AHA PREVENT (2023) base-model risk engine (pure math)
export * from "./repo/coach-context.js";
export * from "./repo/coach.js";
export * from "./repo/insight-intent.js"; // WHAT an insight connects (facet pair + polarity), so a genuine rephrase can be refused
export * from "./repo/baseline-bands.js"; // personal-baseline recovery + training-load reads
export * from "./repo/sensor-freshness.js"; // how old a wearable reading may be before it behaves as absent
export * from "./repo/sensor-cadence.js"; // how MUCH of a wearable series there is before it may describe a trend
export * from "./repo/wear-pattern-voice.js"; // how absence is SAID: episodic cadence vs a lapsed series vs no wearable
export * from "./repo/sensor-recheck.js"; // when the recovery picture has aged enough that one night would sharpen it
export * from "./repo/measurement-request.js"; // ONE calm in-app ask for the measurement a live derivation is blocked on
export * from "./repo/propagation.js";
export * from "./repo/marker-response.js"; // the lab loop: anchor an applied plan/meal change to its marker + learn which change coincided with which direction
export * from "./repo/symptom-links.js"; // deterministic symptom → off-marker reasoning
export * from "./repo/evidence.js";
export * from "./repo/intelligence.js";
export * from "./repo/program-state.js";
export * from "./repo/training-playbook.js"; // plateau/adherence playbook suggestions for plan evolution
export * from "./repo/progression.js";
export * from "./repo/volume-guard.js"; // prescribed VOLUME has no ladder back up: bound a cut, record what it owes, climb back
export * from "./repo/daily-decision.js"; // Stage 2: the deterministic daily-session decision envelope (policy-versioned, reason-coded)
export * from "./repo/daily-composition.js"; // Stage 3: server-side normalizer + deterministic fallback for bounded agent composition
export * from "./repo/equipment-capability.js"; // bounded per-session equipment parsing + exercise compatibility
export * from "./repo/daily-reconciliation.js"; // Stage 4: post-session suggested-vs-actual outcome reconciliation (idempotent, adherence-neutral)
export * from "./repo/daily-outcome-read.js"; // bounded athlete-facing learning read over completed reconciled sessions
export * from "./repo/recovery-cycles.js"; // temporary calendar-bounded recovery overlays; never mutate the base plan
export * from "./repo/training-symptoms.js"; // explicit movement-scoped symptom/tolerance lifecycle
export * from "./repo/symptom-reports.js"; // the athlete's verbatim pain words — the record structure is derived FROM
export { registerSymptomExtractionHook } from "./repo/symptom-extraction-hooks.js";
export * from "./repo/support-work.js"; // lagging compound → build the under-trained contributing muscle
export * from "./repo/session-primer.js"; // the pre-session "a coach was already here" read
export * from "./repo/strength-objectives.js"; // athlete-selected anchor-lift comeback journey
export * from "./repo/program-blocks.js";
export * from "./repo/exercise-variations.js";
export * from "./repo/performance.js"; // training-intelligence: capacity benchmark + imbalance + the lever
export * from "./repo/training-milestones.js"; // benchmark ladder + adaptive training attention cadence
export * from "./repo/run-progression.js"; // the deterministic RUNNING program engine (zones / weekly mix / variety / tests)
export * from "./repo/run-ramp.js"; // pure goal-anchored ramp arithmetic behind the weekly run plan
export * from "./repo/hr-model.js"; // the PERSONAL HR model — observed max, threshold, zone bands (never an age formula)
export * from "./repo/calibration.js"; // the coach's testing ladder: staleness → suggestion → detection → fold-back
export * from "./repo/movement-risk.js"; // durable per-exercise tolerance memory (hybrid-elite seam)
export * from "./repo/pain-band.js"; // the per-movement pain traffic light (green/amber/red)
export * from "./repo/flexible-training-agenda.js"; // rolling run intentions: actual logs, not fixed weekdays, control completion + next window
export * from "./repo/hybrid-run-lookahead.js"; // hybrid planned_run_next override from flexible agenda (cycle-safe; not in training-read)
export * from "./repo/dexa-targeting.js"; // DEXA regional read → training + nutrition targets
export * from "./repo/muscle-trajectory.js"; // per-muscle-group advance/stall + strength test-week cadence
export * from "./repo/coaching-focus.js"; // THE CONDUCTOR — one sequenced whole-athlete focus across all domains
export * from "./repo/signal-state.js"; // unified daily evidence dimensions + one deterministic planning posture
export * from "./repo/attention.js"; // adaptive attention cadence kernel
// Era 2 (the calm daily driver, docs/VISION.md §12):
export * from "./repo/today-agenda.js"; // the Today salience arbiter
export * from "./repo/since-last.js"; // honest "since you last looked" continuity
export * from "./repo/goal-checkin.js"; // gentle periodic "is this still your goal?"
export * from "./repo/learned-timeline.js"; // legible "what Cairn has learned about you"
export * from "./repo/team-week.js"; // the deterministic "here's what your team did this week" read
export { guidelineFor, allGuidelines, type GuidelineEntry } from "./guidelines.js"; // offline trusted-guidelines pack
// The "knows-me" layer (docs/VISION.md — the personal coaching team):
export * from "./repo/reaction-model.js"; // how THIS athlete actually reacts (the personalization foundation)
export * from "./repo/felt-signals.js"; // learns from subjective felt signals (overrides / check-ins / fueling feedback)
export * from "./repo/learned-models.js"; // learned cross-domain coincidences (endurance→strength interference, short-sleep→fueling)
export * from "./repo/trajectory.js"; // one periodized arc to the goals, today as the next step
export * from "./repo/whole-person-trajectory.js"; // standing "everything better" objective, per-domain words not a score
export * from "./repo/journey.js"; // body-composition journey phases + leanness-aware cut foundation
export * from "./repo/cut-target.js"; // the cut's calorie target, derived from logged intake + the measured weight trend
export * from "./repo/energy-deficiency.js"; // the male low-energy-availability symptom-cluster watch (protective, one-directional)
export * from "./repo/energy-deficiency-snapshot.js"; // its memoized read + the small projection a prompt sees
export * from "./repo/recomposition.js"; // phase-aware fat-loss + muscle/fuel protection synthesis
export * from "./repo/cut-quality.js"; // is the weight-loss phase preserving muscle? (goal-aware complement to under-fueling)
export * from "./repo/forward-timeline.js"; // the road ahead: one dated forward-looking timeline read
// context-effect: explicit re-export — its local isAcuteMarker would clash with propagation's `export *`
export {
  activeContextEffect,
  markerInTransientWindow,
  type ActiveContextItem,
  type ContextEffect,
} from "./repo/context-effect.js";
export * from "./repo/next-step.js"; // the one cross-domain next-best-step
export * from "./repo/body-metrics.js"; // at-home body measurements + derived indicators (BMI/WHtR/WHR/Navy body-fat)
export * from "./repo/goal-pace.js"; // motivational weight-progress series: weigh-in points + trend line + line-to-goal
