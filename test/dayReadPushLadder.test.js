// THE PUSH LADDER — the half of the brain that was missing.
//
// Every arbitration threshold in the signal state was negative (rest / easy /
// modify), so a day where every rated session came back strong and nothing at all
// pulled the other way resolved to exactly the same bare `posture:"train"` as a day
// with no evidence whatsoever: the brain could only ever get quieter. These cases pin
// the positive tier end to end — the evidence that earns it, the wearable-neutrality
// that keeps it honest, the read it produces, the acceleration it licenses in the
// personal-response model, and the two truths the softening allowlist rests on.
import test from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { whatWorksForYou } from "../dist/repo/reaction-model.js";
import {
  DAY_READ_PUSH_FOCUS_HEADLINE_VARIANTS,
  DAY_READ_PUSH_HEADLINE_VARIANTS,
  DAY_READ_REQUIRED_CONCEPT,
  DAY_READ_WHY_VARIANTS,
  dayReadHeadline,
  violatesReadingGrammar,
} from "../dist/repo/day-read.js";
import { SIGNAL_VOICE_REGISTRY } from "../dist/repo/signal-state.js";
import {
  decodeCommonEntities,
  decodeDayReadAgentProse,
  isValidDayReadAgentResult,
} from "../dist/dayread.js";
import { MIGRATIONS } from "../dist/migrate.js";

const REF = localDaysAgo(0);

const WORLD = [
  "checkins",
  "daily_metrics",
  "garmin_daily_metrics",
  "garmin_sources",
  "context_events",
  "sessions",
  "logged_sets",
  "activities",
  "plan_items",
  "plan_days",
  "exercises",
  "profile",
  "day_reads",
  "training_symptom_events",
];

function seedPlan() {
  resetTables(...WORLD);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
}

// A logged, RATED session `back` days ago. Nothing here touches a wearable — the
// whole point of the tier is that it can be earned from the training log alone.
function logRatedSession(back, feedback) {
  const day = repo.getPlanDay(1);
  const ex = repo.findExercise("Squat") ?? repo.upsertExercise({ name: "Squat", muscle_group: "quads" });
  const on = localDaysAgo(back);
  const session = repo.getOrCreateSession(on, day.id);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 185, 8, 2)`
  ).run(session.id, ex.id);
  repo.setSessionFeedback(on, feedback);
  return on;
}

// ---------- the supported tier ----------

test("strongly-rated sessions alone earn the backed tier, with no wearable anywhere", () => {
  seedPlan();
  logRatedSession(4, { performance: 5 });
  logRatedSession(2, { performance: 4 });

  const read = repo.dayRead(REF);
  const state = read.signals.signal_state;

  assert.equal(state.action.posture, "train", "the posture enum is untouched — backed is carried beside it");
  assert.equal(state.action.support?.level, "backed");
  assert.ok(
    state.action.support.fields.includes("session_quality"),
    `the tier must name what earned it, got ${JSON.stringify(state.action.support.fields)}`
  );
  // The machine register, exactly like every sibling `summary` in that module.
  assert.doesNotMatch(state.action.support.summary, /\byou(?:'re| are|r|'ve)?\b/i);
  // And an athlete-facing voice that is NOT the summary.
  assert.equal(state.action.support.voice.key, "well_backed");
  for (const line of SIGNAL_VOICE_REGISTRY.well_backed.variants) {
    assert.doesNotMatch(line, /\bthe athlete\b/i);
  }
});

test("an evidence-less day stays neutral rather than backed", () => {
  seedPlan();
  const state = repo.dayRead(REF).signals.signal_state;
  assert.equal(state.action.posture, "train");
  assert.equal(state.action.support, null, "no evidence is not the same as good evidence");
});

test("wearable absence is neutral: the same logs earn the same tier with and without a watch", () => {
  seedPlan();
  logRatedSession(3, { performance: 5 });
  const withoutWatch = repo.dayRead(REF).signals.signal_state.action.support?.level ?? null;

  // The same history, now with a healthy watch attached. Corroboration may join
  // `fields`; it must not be what decides the tier.
  seedPlan();
  logRatedSession(3, { performance: 5 });
  db.prepare("INSERT INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, training_readiness, sleep_min) VALUES (1, ?, 78, 470)`
  ).run(REF);
  const withWatch = repo.dayRead(REF).signals.signal_state.action.support?.level ?? null;

  assert.equal(withoutWatch, "backed");
  assert.equal(withWatch, "backed", "a present, healthy watch must not change what the logs already earned");
});

test("a wearable reading on its own can never earn the tier", () => {
  seedPlan();
  db.prepare("INSERT INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, training_readiness, sleep_min) VALUES (1, ?, 92, 500)`
  ).run(REF);

  const state = repo.dayRead(REF).signals.signal_state;
  assert.equal(state.action.posture, "train");
  assert.equal(
    state.action.support,
    null,
    "a watch reading is corroboration; the athlete's own logged evidence is what earns a push"
  );
});

test("one fresh caution anywhere withdraws the tier", () => {
  seedPlan();
  logRatedSession(3, { performance: 5 });
  // A life-capacity caution — nothing to do with training tolerance, and still
  // enough that the day is no longer maximally supported.
  repo.addContextEvent({ kind: "trip", title: "Work trip", start_date: REF, end_date: REF });

  const state = repo.dayRead(REF).signals.signal_state;
  assert.equal(state.action.support, null);
});

test("a rough rating after a strong one retires the strong claim", () => {
  seedPlan();
  logRatedSession(5, { performance: 5 });
  logRatedSession(2, { performance: 2 });

  const state = repo.dayRead(REF).signals.signal_state;
  assert.equal(state.action.support, null, "the FRESHEST rating owns the claim");
  assert.notEqual(state.action.posture, "train");
});

// ---------- the read it produces ----------

test("a backed train day reads as a push, publishes why, and leaves the clock alone", () => {
  seedPlan();
  logRatedSession(4, { performance: 5 });
  logRatedSession(2, { performance: 5 });

  const read = repo.dayRead(REF);

  assert.equal(read.kind, "train");
  assert.equal(read.decision.rule_code, "planned_training", "a push is a flavour of the same decision");
  assert.ok(
    DAY_READ_WHY_VARIANTS.planned_training_push.includes(read.why),
    `expected a registered push phrasing, got ${JSON.stringify(read.why)}`
  );
  assert.ok(read.signals.push_bias, "downstream surfaces must be able to see WHY the read pushed");
  assert.deepEqual(read.signals.push_bias.backed_by, ["session_quality"]);
  assert.equal(read.est_minutes, 60, "a backed day is a reason to reach within the session, not to lengthen it");
});

test("a caveat on the day beats the push — the read never offers more while working around something", () => {
  seedPlan();
  logRatedSession(4, { performance: 5 });
  logRatedSession(2, { performance: 5 });
  // Nothing here reaches the signal state as a caution (a resolved-load-neutral
  // event), but it does push a caveat onto the planned-training rule.
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: REF });

  const read = repo.dayRead(REF);
  for (const push of DAY_READ_WHY_VARIANTS.planned_training_push) {
    assert.equal(read.why.includes(push), false, `a caveated day read as a push — ${push}`);
  }
  assert.equal(read.signals.push_bias, undefined);
});

test("the push headline is opt-in on the published signal and rotates day to day", () => {
  const plain = dayReadHeadline({ kind: "train", focus: null }, REF);
  const pushed = dayReadHeadline({ kind: "train", focus: null, signals: { push_bias: { backed_by: [] } } }, REF);
  assert.ok(DAY_READ_PUSH_HEADLINE_VARIANTS.includes(pushed));
  assert.notEqual(plain, pushed, "an ordinary train day must not be given the push headline");

  const focused = dayReadHeadline(
    { kind: "train", focus: "Lower body", signals: { push_bias: { backed_by: [] } } },
    REF
  );
  assert.match(focused, /Lower body/, "the focus form still names the focus");

  for (const [label, read] of [
    ["plain", { kind: "train", focus: null, signals: { push_bias: {} } }],
    ["focus", { kind: "train", focus: "Lower body", signals: { push_bias: {} } }],
  ]) {
    const seen = [];
    for (let back = 6; back >= 0; back--) seen.push(dayReadHeadline(read, localDaysAgo(back)));
    assert.equal(dayReadHeadline(read, REF), dayReadHeadline(read, REF), `${label}: re-rolled within a day`);
    assert.ok(new Set(seen).size >= 3, `${label}: a week must not cycle through one or two`);
  }

  // A kind the ladder downgraded to takes the plain set, push signal or not.
  const eased = dayReadHeadline({ kind: "easy", focus: null, signals: { push_bias: {} } }, REF);
  assert.equal(DAY_READ_PUSH_HEADLINE_VARIANTS.includes(eased), false);
});

test("every new push phrasing holds the reading grammar and carries the reach", () => {
  const sets = [
    ["why:planned_training_push", DAY_READ_WHY_VARIANTS.planned_training_push],
    ["headline:train_push", DAY_READ_PUSH_HEADLINE_VARIANTS],
    ["headline:train_focus_push", DAY_READ_PUSH_FOCUS_HEADLINE_VARIANTS],
    ["voice:well_backed", SIGNAL_VOICE_REGISTRY.well_backed.variants],
    ["voice:session_strong", SIGNAL_VOICE_REGISTRY.session_strong.variants],
  ];
  for (const [label, variants] of sets) {
    assert.ok(Array.isArray(variants) && variants.length >= 3, `${label} needs several phrasings`);
    assert.equal(new Set(variants).size, variants.length, `${label} has a duplicate phrasing`);
    for (const text of variants) {
      assert.ok(text.length > 10, `${label}: ${JSON.stringify(text)} is not a real sentence`);
      assert.match(text, /^[A-Z]/, `${label} should open as a sentence: ${JSON.stringify(text)}`);
      assert.match(text, /[.!?]$/, `${label} should close as a sentence: ${JSON.stringify(text)}`);
      const broken = violatesReadingGrammar(text);
      assert.equal(broken, null, `${label} breaks the reading grammar (${broken}): ${JSON.stringify(text)}`);
    }
  }
  // A push that forgets to offer the reach is just a clear day with extra words.
  for (const why of DAY_READ_WHY_VARIANTS.planned_training_push) {
    assert.match(why, DAY_READ_REQUIRED_CONCEPT.planned_training_push, `push why lost its own meaning: ${why}`);
  }
  for (const text of [...DAY_READ_PUSH_HEADLINE_VARIANTS, ...DAY_READ_PUSH_FOCUS_HEADLINE_VARIANTS]) {
    assert.match(text, /\b(?:go after|push|reach|more)\b/i, `push headline lost its own meaning: ${text}`);
  }
});

test("the backed tier reaches the day-read prompt's DATA", async () => {
  seedPlan();
  logRatedSession(3, { performance: 5 });
  const { promptData } = await import("../dist/prompt/context-projection.js");
  const payload = JSON.parse(promptData(repo.getCoachContext(), "day_read"));
  assert.equal(payload.signal_state.action.support.level, "backed");
});

// ---------- the softening allowlist, both truths ----------

test("on the production path the subjective rests are shadowed by the protect posture", () => {
  seedPlan();
  db.prepare(`INSERT INTO checkins (date, energy, sleep_feel) VALUES (?, 1, 1)`).run(REF);
  const felt = repo.dayRead(REF);
  assert.equal(felt.kind, "rest");
  assert.equal(felt.decision.rule_code, "acute_signal_protection");

  seedPlan();
  db.prepare("INSERT INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, training_readiness) VALUES (1, ?, 20)`).run(REF);
  const readiness = repo.dayRead(REF);
  assert.equal(readiness.decision.rule_code, "acute_signal_protection");
});

test("...and are still reachable through a scoped state, which is why they stay softenable", () => {
  // The one documented seam that can separate the two inputs: `dayRead`'s
  // `unifiedState` argument scopes the whole signal state while the check-in and the
  // readiness reading still sit in the DB the rules read. Both codes then key a real
  // rest, and SOFTENABLE_REST_CODES is what lets the outcome loop ease it.
  seedPlan();
  db.prepare(`INSERT INTO checkins (date, energy, sleep_feel) VALUES (?, 1, 1)`).run(REF);
  const felt = repo.dayRead(REF, { has_data: false, recovery: {} }, repo.buildUnifiedSignalState(REF, []));
  assert.equal(felt.kind, "rest");
  assert.equal(felt.decision.rule_code, "felt_run_down_rest");

  seedPlan();
  const scopedRecovery = {
    has_data: true,
    recovery: { training_readiness: 20 },
    quality: { training_readiness: { latest_date: REF } },
  };
  const readiness = repo.dayRead(REF, scopedRecovery, repo.buildUnifiedSignalState(REF, []));
  assert.equal(readiness.kind, "rest");
  assert.equal(readiness.decision.rule_code, "low_readiness_rest");
});

// ---------- the acceleration branch ----------

const PROGRESSION_EVALUATOR = "push-ladder-test-v1";

function progressionOutcome(key, verdict, at) {
  const recorded = recordDecision(
    {
      effective_date: "2026-01-01",
      kind: "training_target",
      domain: "training",
      summary: `Bounded progression step ${key}.`,
      rationale: "Measure the response before changing the default again.",
      source: "test",
      source_ref_type: "plan_proposal",
      source_ref_key: key,
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {},
      action: { step: 5 },
      specialist: null,
      applied_at: "2026-01-01T12:00:00.000Z",
      reverted_at: null,
      superseded_by: null,
      evaluator_version: PROGRESSION_EVALUATOR,
    },
    [
      {
        metric_key: "exercise_target_completion",
        subject_key: null,
        direction: "at_least",
        baseline: { value: 0.8 },
        target: { value: 0.9 },
        window_start: "2026-01-01",
        window_end: `2026-01-${at}`,
        minimum_data: { sessions: 4 },
        confounder_policy: "standard",
        confidence: "tentative",
        evaluator: "exercise_completion",
        evaluator_version: PROGRESSION_EVALUATOR,
      },
    ]
  );
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? 1 : 0.5, sessions: 8 },
    evidence_keys: [`logged_sets:2026-01-01..2026-01-${at}:n=8`],
    confounders: [],
    explanation: verdict === "aligned" ? "Targets were met." : "Targets were missed.",
    evaluator_version: PROGRESSION_EVALUATOR,
  });
}

function trainingModifier() {
  return (whatWorksForYou()?.modifiers ?? []).find((m) => m.target === "training_progression_step") ?? null;
}

test("two aligned progression verdicts earn a larger step, inside the declared bounds", () => {
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  progressionOutcome("1", "aligned", "10");
  progressionOutcome("2", "aligned", "20");

  const modifier = trainingModifier();
  assert.ok(modifier, "an aligned run must produce a training modifier");
  assert.ok(modifier.scale > 1, `expected acceleration, got scale ${modifier.scale}`);
  assert.ok(
    modifier.scale <= modifier.bounds.max && modifier.bounds.max === 1.1,
    "acceleration is capped by the modifier's own declared bounds"
  );
});

test("a single aligned verdict is not a pattern", () => {
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  progressionOutcome("1", "aligned", "10");
  assert.equal(trainingModifier(), null, "one outcome never sets a default");
});

test("any missed verdict in the window blocks acceleration", () => {
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  progressionOutcome("1", "not_aligned", "05");
  progressionOutcome("2", "aligned", "10");
  progressionOutcome("3", "aligned", "20");

  const modifier = trainingModifier();
  assert.ok(modifier, "the aligned run is still the active verdict");
  assert.equal(modifier.scale, 1, "a miss anywhere in the comparable window holds the standard step");
});

test("an active training symptom blocks acceleration", () => {
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  progressionOutcome("1", "aligned", "10");
  progressionOutcome("2", "aligned", "20");
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, onset_on, last_reported_on)
     VALUES ('manual', 'left knee', 'active', ?, ?)`
  ).run(REF, REF);

  assert.equal(trainingModifier().scale, 1, "a larger step must never stack onto something that already hurts");
});

test("run volume is deliberately excluded from acceleration", () => {
  // The endurance round's injury-safety ruling: bone and tendon adapt on a slower
  // clock than the aligned-verdict window can see. The declared bounds still allow
  // 1.15, and the branch must still never reach for it.
  const source = MIGRATIONS.length > 0; // keep the import honest in this file
  assert.ok(source);
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  for (const [key, at] of [
    ["1", "10"],
    ["2", "20"],
  ]) {
    const recorded = recordDecision(
      {
        effective_date: "2026-01-01",
        kind: "training_target",
        domain: "training",
        summary: `Weekly run build ${key}.`,
        rationale: "Measure the response before building again.",
        source: "test",
        source_ref_type: "plan_proposal",
        source_ref_key: key,
        status: "applied",
        autonomy_tier: "quiet_apply",
        risk_class: "low",
        reversible: true,
        input_fingerprint: null,
        context: {},
        action: { km: 30 },
        specialist: null,
        applied_at: "2026-01-01T12:00:00.000Z",
        reverted_at: null,
        superseded_by: null,
        evaluator_version: PROGRESSION_EVALUATOR,
      },
      [
        {
          metric_key: "run_volume_adherence",
          subject_key: null,
          direction: "at_least",
          baseline: { value: 0.8 },
          target: { value: 0.9 },
          window_start: "2026-01-01",
          window_end: `2026-01-${at}`,
          minimum_data: { sessions: 4 },
          confounder_policy: "standard",
          confidence: "tentative",
          evaluator: "run_volume_adherence",
          evaluator_version: PROGRESSION_EVALUATOR,
        },
      ]
    );
    insertBrainEvaluation({
      expectation_id: recorded.expectations[0].id,
      verdict: "aligned",
      actual: { value: 1, sessions: 8 },
      evidence_keys: [`activities:2026-01-01..2026-01-${at}:n=8`],
      confounders: [],
      explanation: "The prescribed weekly volume was absorbed.",
      evaluator_version: PROGRESSION_EVALUATOR,
    });
  }
  const runModifier = (whatWorksForYou()?.modifiers ?? []).find((m) => m.target === "run_volume_step");
  assert.ok(runModifier, "the run-volume learning still produces a modifier");
  assert.equal(runModifier.scale, 1, "run volume holds; it never accelerates");
});

// ---------- day-read outcomes reach the prose, and nothing else ----------

const ADHERENCE_EVALUATOR = "day-read-adherence-v1";

function adherenceOutcome(dayIndex, kind, verdict) {
  const date = `2026-03-${String(dayIndex).padStart(2, "0")}`;
  const recorded = recordDecision(
    {
      effective_date: date,
      kind: "day_read",
      domain: "cross_domain",
      summary: `${kind} day`,
      rationale: "A calm sentence about the day.",
      source: "deterministic",
      source_ref_type: "day_read",
      source_ref_key: date,
      // The whole point: a read is a SUGGESTION, so its decision never leaves
      // `observed` and the applied-only filter dropped every one of these.
      status: "observed",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: false,
      input_fingerprint: `push-ladder:${date}`,
      context: {},
      action: { kind },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: ADHERENCE_EVALUATOR,
    },
    [
      {
        metric_key: "day_read_adherence",
        // The read DATE — which is exactly why comparableKey would have made every
        // day its own singleton group.
        subject_key: date,
        direction: "avoid",
        baseline: { read_kind: kind },
        target: { max: 0 },
        window_start: date,
        window_end: date,
        minimum_data: { closed_days: 1 },
        confounder_policy: "none",
        confidence: "tentative",
        evaluator: "day_read_adherence",
        evaluator_version: ADHERENCE_EVALUATOR,
      },
    ]
  );
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { read_kind: kind, occurrences: verdict === "aligned" ? 0 : 1 },
    evidence_keys: [`day_read_adherence:${date}:read=${kind}`],
    confounders: [],
    explanation: verdict === "aligned" ? "The read was followed." : "Training was logged anyway.",
    evaluator_version: ADHERENCE_EVALUATOR,
  });
}

test("observed day-read verdicts become prose, and never a modifier", () => {
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  for (let day = 1; day <= 6; day++) adherenceOutcome(day, "rest", day <= 5 ? "not_aligned" : "aligned");

  const learned = whatWorksForYou();
  assert.ok(learned, "the highest-volume metric in the ledger must teach something");
  const pattern = learned.learnings.find((l) => l.metric_key === "day_read_adherence");
  assert.ok(pattern, `expected a day-read pattern, got ${JSON.stringify(learned.learnings.map((l) => l.metric_key))}`);
  assert.match(pattern.statement, /train anyway/i, "the pattern must say which way it goes");
  assert.equal(pattern.subject_key, "rest", "grouped by the READ KIND, not by the read date");
  assert.equal(pattern.evidence_n, 6);

  // The hard rule: restOverrideSoftening already acts on these exact rows, so a
  // modifier here would move a second lever off one pattern.
  assert.equal(
    learned.modifiers.some((m) => m.key.includes("day_read_adherence")),
    false,
    "day-read outcomes must never carry a numeric modifier"
  );
  // …and the prose is athlete-readable, since the learned timeline renders it.
  assert.equal(violatesReadingGrammar(pattern.statement), null, pattern.statement);
});

test("a thin or evenly-split day-read history says nothing", () => {
  resetTables("brain_evaluations", "brain_expectations", "brain_decisions", "training_symptom_events");
  for (let day = 1; day <= 3; day++) adherenceOutcome(day, "rest", "not_aligned");
  assert.equal(whatWorksForYou(), null, "three outcomes is not yet a pattern");

  resetTables("brain_evaluations", "brain_expectations", "brain_decisions");
  for (let day = 1; day <= 6; day++) adherenceOutcome(day, "rest", day % 2 ? "aligned" : "not_aligned");
  const split = whatWorksForYou();
  assert.equal(
    (split?.learnings ?? []).some((l) => l.metric_key === "day_read_adherence"),
    false,
    "a coin-flip is not a pattern"
  );
});

// ---------- entity-clean prose ----------

test("agent prose arrives decoded, and double-escaped prose is refused", () => {
  const baseline = { kind: "train", signals: { today_load: "none", trained_today: false } };

  const escaped = { kind: "train", headline: "Push session &amp; run complete", why: "Legs &amp; lungs both got a turn." };
  const decoded = decodeDayReadAgentProse(escaped);
  assert.equal(decoded.headline, "Push session & run complete");
  assert.equal(decoded.why, "Legs & lungs both got a turn.");
  assert.equal(isValidDayReadAgentResult(decoded, baseline), true);

  // The exact shape that reached the live DB.
  assert.equal(isValidDayReadAgentResult(escaped, baseline), false, "an undecoded entity must not validate");

  // One pass only: text that is STILL escaped after decoding has been through an
  // escaper twice and is rejected rather than unwrapped again.
  const twice = decodeDayReadAgentProse({
    kind: "train",
    headline: "Push &amp;amp; pull",
    why: "A calm sentence about the day.",
  });
  assert.equal(twice.headline, "Push &amp; pull");
  assert.equal(isValidDayReadAgentResult(twice, baseline), false);

  // The other entities, and the ampersand decoded LAST.
  assert.equal(decodeCommonEntities("a &lt;b&gt; &quot;c&quot; &#39;d&#39;&nbsp;e"), `a <b> "c" 'd' e`);
  assert.equal(decodeCommonEntities("&amp;lt;"), "&lt;", "decoding must not cascade in one pass");
  // Prose with nothing to decode comes back byte-identical, same object.
  const clean = { kind: "train", headline: "Good to train.", why: "You're due." };
  assert.equal(decodeDayReadAgentProse(clean), clean);
});

test("migration 85 decodes stored day-read prose and is idempotent", () => {
  resetTables("day_reads");
  const migration = MIGRATIONS.find((m) => m.version === 85);
  assert.ok(migration, "migration 85 must exist");
  assert.equal(
    MIGRATIONS.filter((m) => m.version === 85).length,
    1,
    "one migration per integer version"
  );
  assert.equal(
    MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0),
    85,
    "85 is the newest rung"
  );

  const rows = [
    ["2026-03-01", "Push session &amp; run complete", "Legs &amp; lungs both got a turn."],
    ["2026-03-02", "Good to train.", "Nothing&#39;s holding you back today."],
    ["2026-03-03", "Lower body.", "You're due and everything reads clear."],
  ];
  for (const [date, headline, why] of rows) {
    db.prepare(`INSERT INTO day_reads (date, kind, headline, why, focus) VALUES (?, 'train', ?, ?, NULL)`).run(
      date,
      headline,
      why
    );
  }

  migration.up(db);
  const after = () =>
    db
      .prepare(`SELECT date, headline, why FROM day_reads ORDER BY date`)
      .all()
      .map((r) => [r.date, r.headline, r.why]);
  const once = after();
  assert.deepEqual(once, [
    ["2026-03-01", "Push session & run complete", "Legs & lungs both got a turn."],
    ["2026-03-02", "Good to train.", "Nothing's holding you back today."],
    ["2026-03-03", "Lower body.", "You're due and everything reads clear."],
  ]);

  migration.up(db);
  assert.deepEqual(after(), once, "a second run must find nothing left to repair");
});
