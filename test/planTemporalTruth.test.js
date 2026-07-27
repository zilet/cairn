import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, repo, resetTables } from "./_seed.js";
import { isPlanProposalResult } from "../dist/agent-contracts.js";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

beforeEach(() => {
  resetTables(
    "brain_expectations",
    "brain_rollbacks",
    "brain_decisions",
    "movement_tolerance_observations",
    "training_symptom_events",
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "recovery_cycles",
    "strength_objectives",
    "logged_sets",
    "sessions",
    "activities",
    "plan_proposals",
    "plan_items",
    "plan_days",
    "exercises"
  );
});

function seedPlan(name = "Temporal Bench Press") {
  repo.savePlanDay(1, "Push", "Chest", [{ exercise: name, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }]);
}

function createFreshnessProposal(instruction = "bounded freshness") {
  return repo.createProposal("stub", instruction, "", {
    summary: "A bounded target step.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "The current picture supports this.",
      },
    ],
  });
}

test("historical proposal reasons require structured provenance at agent acceptance", () => {
  const base = {
    summary: "A dated adjustment.",
    as_of_date: "2026-07-17",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "Yesterday's clean sets earned a small step.",
      },
    ],
  };
  assert.equal(isPlanProposalResult(base), false);
  assert.equal(
    isPlanProposalResult({
      ...base,
      changes: [
        {
          ...base.changes[0],
          reason_provenance: {
            reason_code: "top_of_range",
            evidence_date: "2026-07-16",
            as_of_date: "2026-07-17",
            source_ref_type: "session",
            source_ref_key: "2026-07-16",
          },
        },
      ],
    }),
    true
  );
});

test("July 16 evidence stays absolutely anchored through July 17 proposal, July 20 apply, and later render", () => {
  seedPlan();
  const raw = db
    .prepare(
      `INSERT INTO plan_proposals
        (created_at, agent, instruction, raw_output, parsed_json, status)
       VALUES ('2026-07-17 12:00:00', 'legacy', 'dated proposal', '', ?, 'applied')`
    )
    .run(
      JSON.stringify({
        summary: "A small step after yesterday.",
        changes: [
          {
            day_number: 1,
            exercise: "Temporal Bench Press",
            target_weight: 105,
            reason: "Yesterday's clean sets earned a small step.",
          },
        ],
      })
    );
  const proposalId = Number(raw.lastInsertRowid);
  repo.recordDecision({
    effective_date: "2026-07-20",
    kind: "training_target",
    domain: "training",
    summary: "A small step after yesterday.",
    rationale: "Yesterday's clean sets earned a small step.",
    source: "legacy",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposalId),
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {
      plan_proposal_id: proposalId,
      changes: [{ day_number: 1, exercise: "Temporal Bench Press", target_weight: 105 }],
    },
    specialist: null,
    applied_at: "2026-07-20T12:00:00Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });

  const proposal = repo.getProposal(proposalId);
  assert.match(proposal.parsed.changes[0].reason, /July 16, 2026/);
  assert.doesNotMatch(proposal.parsed.changes[0].reason, /yesterday/i);
  assert.deepEqual(proposal.parsed.changes[0].reason_provenance, {
    reason_code: "training_evidence",
    evidence_date: "2026-07-16",
    as_of_date: "2026-07-17",
    source_ref_type: "training_evidence_snapshot",
    source_ref_key: "",
  });

  const rendered = repo.getPlanDay(1).items[0];
  assert.match(rendered.brain_change_summary, /July 16, 2026/);
  assert.match(rendered.brain_change_reason, /July 16, 2026/);
  assert.doesNotMatch(`${rendered.brain_change_summary} ${rendered.brain_change_reason}`, /yesterday/i);
});

test("changed training evidence blocks autonomous apply with a review hold", () => {
  seedPlan();
  const proposal = repo.createProposal("stub", "freshness CAS", "", {
    summary: "A bounded target step.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "Two clean exposures support this.",
      },
    ],
  });
  repo.logSetByName({
    exercise: "Temporal Bench Press",
    weight: 100,
    reps: 8,
    rir: 2,
    date: localDateISO(),
  });

  const result = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(result.applied, false);
  assert.equal(result.review_required, true);
  assert.equal(result.review_reason_code, "stale_snapshot");
  assert.equal(result.proposal.status, "draft");
  assert.deepEqual(result.decision.context.proposal_freshness.changed_components, ["training"]);
});

test("proposal freshness covers injury, recovery, goals, and session notes", () => {
  const cases = [
    {
      label: "injury",
      mutate: () =>
        repo.addContextEvent({
          kind: "injury",
          title: "Right knee",
          start_date: localDateISO(),
          meta: { area: "knee" },
        }),
      component: "context",
    },
    {
      label: "recovery",
      mutate: () => repo.addCheckin(localDateISO(), { energy: 2, sleep_feel: 2, soreness: 3 }),
      component: "context",
    },
    {
      label: "goal",
      mutate: () => repo.setProfile({ goal_weight_lb: 180, goal_date: "2026-12-01" }),
      component: "context",
    },
    {
      label: "session note",
      mutate: () =>
        db.prepare(`INSERT INTO sessions (date, notes, kind) VALUES (?, 'Knee felt unstable', 'strength')`).run(
          localDateISO()
        ),
      component: "training",
    },
  ];

  for (const scenario of cases) {
    resetTables(
      "brain_expectations",
      "brain_rollbacks",
      "brain_decisions",
      "movement_tolerance_observations",
      "training_symptom_events",
      "daily_session_outcomes",
      "daily_session_decisions",
      "daily_session_compositions",
      "recovery_cycles",
      "logged_sets",
      "sessions",
      "activities",
      "plan_proposals",
      "plan_items",
      "plan_days",
      "exercises",
      "context_events",
      "checkins"
    );
    seedPlan();
    const proposal = repo.createProposal("stub", `freshness ${scenario.label}`, "", {
      summary: "A bounded target step.",
      changes: [
        {
          day_number: 1,
          exercise: "Temporal Bench Press",
          target_weight: 105,
          reason: "The current picture supports this.",
        },
      ],
    });
    scenario.mutate();
    const freshness = repo.verifyProposalEvidenceFreshness(proposal.parsed, localDateISO());
    assert.equal(freshness.status, "changed", scenario.label);
    assert.ok(freshness.changed_components.includes(scenario.component), scenario.label);
  }
});

test("proposal freshness includes symptom lifecycle and movement-tolerance facts", () => {
  const today = localDateISO();
  const cases = [
    {
      label: "symptom creation",
      setup: () => null,
      mutate: () => repo.reportTrainingSymptom({ area_text: "left shoulder", onset_on: today }),
    },
    {
      label: "symptom resolution",
      setup: () => repo.reportTrainingSymptom({ area_text: "left shoulder", onset_on: today }),
      mutate: (symptom) => repo.resolveTrainingSymptom(symptom.id, today),
    },
    {
      label: "symptom recurrence",
      setup: () => {
        const symptom = repo.reportTrainingSymptom({ area_text: "left shoulder", onset_on: today });
        repo.resolveTrainingSymptom(symptom.id, today);
        return symptom;
      },
      mutate: (symptom) => repo.recurTrainingSymptom(symptom.id, { on: today, movement: "Temporal Bench Press" }),
    },
    {
      label: "movement tolerance",
      setup: () => repo.reportTrainingSymptom({ area_text: "left shoulder", onset_on: today }),
      mutate: (symptom) =>
        repo.recordMovementTolerance({
          symptom_event_id: symptom.id,
          movement: "Temporal Bench Press",
          observed_on: today,
          pain_free: true,
        }),
    },
  ];

  for (const scenario of cases) {
    resetTables(
      "movement_tolerance_observations",
      "training_symptom_events",
      "plan_proposals",
      "plan_items",
      "plan_days",
      "exercises"
    );
    seedPlan();
    const subject = scenario.setup();
    const proposal = createFreshnessProposal(`freshness ${scenario.label}`);
    scenario.mutate(subject);
    const freshness = repo.verifyProposalEvidenceFreshness(proposal.parsed, today);
    assert.equal(freshness.status, "changed", scenario.label);
    assert.ok(freshness.changed_components.includes("training"), scenario.label);
  }
});

test("proposal freshness includes recovery-cycle scheduling and lifecycle status", () => {
  const today = localDateISO();
  const schedule = () =>
    repo.scheduleRecoveryCycle({
      effective_on: today,
      recheck_on: addDaysISO(today, 2),
      exit_on: addDaysISO(today, 3),
      overlay: { version: 1, working_set_fraction: 0.5, effort: "easy" },
      reason: "Temporary easy work",
    });

  seedPlan();
  const beforeSchedule = createFreshnessProposal("freshness recovery schedule");
  schedule();
  assert.deepEqual(repo.verifyProposalEvidenceFreshness(beforeSchedule.parsed, today).changed_components, ["training"]);

  resetTables("recovery_cycles", "plan_proposals", "plan_items", "plan_days", "exercises");
  seedPlan();
  const cycle = schedule();
  const beforeActivation = createFreshnessProposal("freshness recovery status");
  repo.activateRecoveryCycle(cycle.id, today);
  assert.deepEqual(repo.verifyProposalEvidenceFreshness(beforeActivation.parsed, today).changed_components, ["training"]);
});

test("proposal freshness includes bounded plan-relevant daily outcome facts", () => {
  const today = localDateISO();
  seedPlan();
  const sessionId = Number(db.prepare(`INSERT INTO sessions (date, kind) VALUES (?, 'strength')`).run(today).lastInsertRowid);
  const compositionId = Number(
    db
      .prepare(
        `INSERT INTO daily_session_compositions
          (version, session_id, date, source, status, title, items_json, request_fingerprint)
         VALUES (1, ?, ?, 'manual_plan', 'active', 'Outcome fixture', '[]', 'outcome-fixture')`
      )
      .run(sessionId, today).lastInsertRowid
  );
  const baseline = {
    schema_version: 2,
    confidence: "moderate",
    reason_codes: ["partial_session"],
    confounders: [],
    completed: [],
    substituted: [],
    skipped: ["Temporal Bench Press"],
    reordered: false,
    dose_context: { comparable: false, partial: true, non_comparable_reasons: ["partial"] },
    feedback: { soreness: null, performance: null, joint_pain: null },
    dose_evidence: [],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes
      (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'in_progress', ?)`
  ).run(compositionId, sessionId, today, JSON.stringify(baseline));
  const proposal = createFreshnessProposal("freshness daily outcome");

  db.prepare(`UPDATE daily_session_outcomes SET facts_json = ? WHERE composition_id = ?`).run(
    JSON.stringify({
      ...baseline,
      confidence: "high",
      reason_codes: ["completed_as_suggested"],
      completed: ["Temporal Bench Press"],
      skipped: [],
      dose_context: { comparable: true, partial: false, non_comparable_reasons: [] },
    }),
    compositionId
  );
  assert.deepEqual(repo.verifyProposalEvidenceFreshness(proposal.parsed, today).changed_components, ["training"]);
});

test("proposal freshness includes the active user-owned strength objective lifecycle", () => {
  const cases = [
    {
      label: "create",
      setup: () => null,
      mutate: () =>
        repo.setStrengthObjective({
          exercise: "Temporal Bench Press",
          target_kind: "explicit_est_1rm",
          target_est_1rm: 150,
        }),
    },
    {
      label: "change",
      setup: () =>
        repo.setStrengthObjective({
          exercise: "Temporal Bench Press",
          target_kind: "explicit_est_1rm",
          target_est_1rm: 150,
        }),
      mutate: (objective) =>
        db.prepare(`UPDATE strength_objectives SET target_est_1rm = 155 WHERE id = ?`).run(objective.id),
    },
    {
      label: "supersede",
      setup: () =>
        repo.setStrengthObjective({
          exercise: "Temporal Bench Press",
          target_kind: "explicit_est_1rm",
          target_est_1rm: 150,
        }),
      mutate: (objective) => repo.setStrengthObjectiveStatus(objective.id, "archived"),
    },
  ];
  for (const scenario of cases) {
    resetTables("strength_objectives", "plan_proposals", "plan_items", "plan_days", "exercises");
    seedPlan();
    const objective = scenario.setup();
    const proposal = createFreshnessProposal(`objective ${scenario.label}`);
    scenario.mutate(objective);
    const freshness = repo.verifyProposalEvidenceFreshness(proposal.parsed, localDateISO());
    assert.equal(freshness.status, "changed", scenario.label);
    assert.ok(freshness.changed_components.includes("context"), scenario.label);
  }
});

test("proposal plan fingerprint includes item rationale and exercise authority fields", () => {
  const cases = [
    {
      label: "plan item note",
      mutate: () => db.prepare(`UPDATE plan_items SET note = 'Use a controlled pause'`).run(),
    },
    {
      label: "exercise muscle group",
      mutate: () => db.prepare(`UPDATE exercises SET muscle_group = 'shoulders'`).run(),
    },
    {
      label: "exercise equipment",
      mutate: () => db.prepare(`UPDATE exercises SET equipment = 'a cable machine'`).run(),
    },
  ];
  for (const scenario of cases) {
    resetTables("plan_proposals", "plan_items", "plan_days", "exercises");
    seedPlan();
    const proposal = createFreshnessProposal(`plan authority ${scenario.label}`);
    scenario.mutate();
    assert.deepEqual(
      repo.verifyProposalEvidenceFreshness(proposal.parsed, localDateISO()).changed_components,
      ["plan"],
      scenario.label
    );
  }
});

test("new proposal evidence dates are server-owned and strictly calendar-valid", () => {
  seedPlan();
  const payload = {
    summary: "A bounded target step.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "The current picture supports this.",
      },
    ],
  };
  assert.throws(
    () => repo.createProposal("stub", "future bypass", "", { ...payload, as_of_date: "2099-01-01" }),
    /server date/
  );
  assert.throws(
    () => repo.createProposal("stub", "stale bypass", "", { ...payload, as_of_date: "2020-01-01" }),
    /server date/
  );
  assert.throws(
    () => repo.createProposal("stub", "invalid calendar", "", { ...payload, as_of_date: "2034-99-99" }),
    /server date/
  );
  assert.throws(
    () =>
      repo.createProposal("stub", "future evidence", "", {
        ...payload,
        changes: [
          {
            ...payload.changes[0],
            reason_provenance: {
              reason_code: "training_evidence",
              evidence_date: "2099-01-01",
              as_of_date: localDateISO(),
            },
          },
        ],
      }),
    /cannot be after/
  );
});

test("relative comparable-exposure progression prose is dated before plan persistence", () => {
  seedPlan();
  repo.logSetByName({
    date: localDateISO(),
    exercise: "Temporal Bench Press",
    weight: 100,
    reps: 8,
    day_number: null,
  });
  const proposal = repo.createProposal("stub", "relative progression rationale", "", {
    summary: "Hold this dose.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "The last two comparable exposures came in under this dose — hold it here and let the movement catch up.",
      },
    ],
  });
  assert.equal(
    applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply", explicit_user_request: true }).applied
      .length,
    1
  );
  const reason = repo.getPlanDay(1).items[0].brain_change_reason;
  assert.doesNotMatch(reason, /\blast two comparable exposures\b/i);
  assert.match(reason, /\btwo comparable exposures through [A-Z][a-z]+ \d{1,2}, \d{4}\b/);
});

test("moving session, recovery, performance, and exposure prose is anchored before plan persistence", () => {
  seedPlan();
  const evidenceDate = addDaysISO(localDateISO(), -1);
  const cases = [
    "The previous session and prior comparable exposure support this step.",
    "Recent soreness, recent recovery, and recent performance support holding here.",
    "The last session followed recent exposures and previous comparable sets.",
    "The last exposure and prior recovery support this dose.",
  ];
  let target = 100;
  for (const reason of cases) {
    target += 5;
    const proposal = repo.createProposal("stub", "durable rationale", "", {
      summary: reason,
      changes: [
        {
          day_number: 1,
          exercise: "Temporal Bench Press",
          target_weight: target,
          reason,
          reason_provenance: {
            reason_code: "training_evidence",
            evidence_date: evidenceDate,
            as_of_date: localDateISO(),
          },
        },
      ],
    });
    assert.equal(
      applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply", explicit_user_request: true }).applied
        .length,
      1
    );
    const stored = repo.getPlanDay(1).items[0].brain_change_reason;
    assert.doesNotMatch(
      stored,
      /\b(?:previous|prior|last) session\b|\b(?:recent|last|previous|prior) (?:soreness|recovery|performance|exposures?)\b|\bprevious comparable sets\b/i
    );
    assert.match(stored, /[A-Z][a-z]+ \d{1,2}, \d{4}/);
  }
});

test("presentation-only rows do not invalidate proposal evidence", () => {
  seedPlan();
  const proposal = repo.createProposal("stub", "presentation stability", "", {
    summary: "A bounded target step.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "The current picture supports this.",
      },
    ],
  });
  db.prepare(
    `INSERT INTO insights (kind, text, status) VALUES ('continuity', 'A different rendering sentence.', 'new')`
  ).run();
  db.prepare(
    `INSERT INTO diagnostic_events (source, kind, level, fingerprint, message)
     VALUES ('process', 'test_telemetry', 'warning', 'proposal-noise', 'Regenerable operator telemetry')`
  ).run();
  assert.equal(repo.verifyProposalEvidenceFreshness(proposal.parsed, localDateISO()).status, "current");
});

test("changed evidence also compare-and-set blocks an already announced boundary apply", () => {
  seedPlan();
  const proposal = repo.createProposal("stub", "boundary freshness CAS", "", {
    summary: "A bounded target step.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "The recorded exposures support this.",
      },
    ],
  });
  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  assert.equal(scheduled.announced, true);
  repo.logSetByName({
    exercise: "Temporal Bench Press",
    weight: 100,
    reps: 8,
    rir: 2,
    date: localDateISO(),
  });

  const boundary = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(boundary.applied, []);
  assert.deepEqual(boundary.failed, [scheduled.decision.id]);
  const held = repo.getBrainDecision(scheduled.decision.id);
  assert.equal(held.status, "review");
  assert.equal(held.context.review_reason_code, "stale_snapshot");
  assert.deepEqual(held.context.proposal_freshness.changed_components, ["training"]);
  assert.equal(repo.getProposal(proposal.id).status, "draft");
});

test("legacy proposals remain explicitly applicable and report unverified freshness", () => {
  seedPlan();
  const raw = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES ('legacy', '', '', ?)`)
    .run(
      JSON.stringify({
        summary: "Legacy target.",
        changes: [
          { day_number: 1, exercise: "Temporal Bench Press", target_weight: 105, reason: "A conservative step." },
        ],
      })
    );
  const result = repo.applyProposal(Number(raw.lastInsertRowid));
  assert.equal(result.ok, true);
  assert.equal(result.proposal_freshness.status, "unverified");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 105);
});

test("an explicitly scheduled legacy proposal compares its scheduling snapshot and applies at the boundary", () => {
  seedPlan();
  const rawParsed = {
    summary: "Legacy target.",
    changes: [
      {
        day_number: 1,
        exercise: "Temporal Bench Press",
        target_weight: 105,
        reason: "A conservative step.",
      },
    ],
  };
  const raw = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES ('legacy', '', '', ?)`)
    .run(JSON.stringify(rawParsed));
  const proposalId = Number(raw.lastInsertRowid);
  const scheduled = applyProposalWithAutonomy(proposalId, {
    requested_tier: "announce",
    explicit_user_request: true,
  });
  assert.equal(scheduled.announced, true);
  assert.match(scheduled.decision.context.proposal_evidence.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    JSON.parse(db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(proposalId).parsed_json),
    rawParsed,
    "scheduling does not rewrite the immutable legacy payload"
  );

  const boundary = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(boundary.failed, []);
  assert.deepEqual(boundary.applied, [scheduled.decision.id]);
  assert.equal(repo.getProposal(proposalId).status, "applied");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 105);
});

test("a new-exercise baseline cue is persisted exactly once", () => {
  seedPlan("Temporal Back Squat");
  const proposal = repo.createProposal("stub", "rotate", "", {
    summary: "A close variation.",
    changes: [
      {
        day_number: 1,
        swap: { from: "Temporal Back Squat", to: "Temporal Front Squat" },
        reason: "Rotate the pattern; start light and log your actual working value.",
      },
    ],
  });
  assert.equal(repo.applyProposal(proposal.id).ok, true);
  const note = String(repo.getPlanDay(1).items[0].note);
  assert.equal((note.match(/start light/gi) ?? []).length, 1);
  assert.equal((note.match(/log your actual/gi) ?? []).length, 1);
  const decision = repo.listBrainDecisions({ limit: 10 }).find((item) => item.source_ref_key === String(proposal.id));
  assert.equal(decision.action.changes[0].reason_provenance.reason_code, "training_evidence");
  assert.equal(decision.action.proposal_evidence.fingerprint, proposal.parsed.proposal_truth.evidence.fingerprint);
});

test("athlete-facing decision rationale and Undo identifiers remain escaped", () => {
  const source = readFileSync(new URL("../src/client/today-cards-client.ts", import.meta.url), "utf8");
  assert.match(source, /escHtml\(item\.brain_change_summary/);
  assert.match(source, /escHtml\(item\.brain_change_reason \|\| item\.note\)/);
  assert.match(source, /escAttr\(item\.brain_decision_id\)/);
});
