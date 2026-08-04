import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { planUpcomingNote } from "../dist/domain/training/plan-upcoming.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import * as repo from "../dist/repo.js";

// Dates are relative to the real "today" because planUpcomingNote() reads the
// live clock (no asOf param) — a fixed date would drift as the calendar moves.
const inDays = (n) => addDaysISO(localDateISO(), n);

function decision(overrides = {}) {
  return {
    effective_date: inDays(3),
    kind: "training_structure",
    domain: "training",
    summary: "Recovery week — volume halves, same movements.",
    rationale: null,
    source: "autonomy",
    source_ref_type: "plan_proposal",
    source_ref_key: "7",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: 7 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
    ...overrides,
  };
}

test("planUpcomingNote surfaces training + recovery changes, dropping other domains, soonest-first", () => {
  recordDecision(decision({ effective_date: inDays(2), summary: "training tweak", domain: "training", action: { proposal_id: 11 } }));
  recordDecision(decision({ effective_date: inDays(4), summary: "recovery week lands", domain: "recovery", action: { proposal_id: 12 } }));
  // Off the Plan tab: nutrition/health live on their own surfaces.
  recordDecision(decision({ effective_date: inDays(3), summary: "nutrition target", domain: "nutrition", action: { proposal_id: 13 } }));
  recordDecision(decision({ effective_date: inDays(3), summary: "lab flag", domain: "health", action: { proposal_id: 14 } }));

  const note = planUpcomingNote();
  assert.ok(note, "a note is present");
  assert.deepEqual(
    note.items.map((i) => i.summary),
    ["training tweak", "recovery week lands"]
  );
  assert.ok(note.items.every((i) => i.domain === "training" || i.domain === "recovery"));
});

test("planUpcomingNote dedupes against the recovery banner's draft proposal", () => {
  const draft = repo.createProposal(
    "auto",
    `${repo.RECOVERY_WEEK_INSTRUCTION_PREFIX} week — pull the volume back so the body absorbs the block.`,
    "",
    { summary: "A lighter recovery week.", days: [{ day_number: 1, name: "Recovery", focus: "Recovery", items: [] }] }
  );
  const rs = repo.recoveryWeekStatus();
  assert.equal(rs.state, "drafted");
  assert.equal(rs.proposal_id, draft.id);

  // The announced decision FOR that same recovery draft — the recovery banner
  // already shows it, so the forward note must not repeat it.
  recordDecision(decision({ effective_date: inDays(2), summary: "recovery draft (already on banner)", domain: "recovery", action: { proposal_id: rs.proposal_id } }));
  // A distinct training change still surfaces.
  recordDecision(decision({ effective_date: inDays(5), summary: "distinct training change", domain: "training", action: { proposal_id: 999 } }));

  const note = planUpcomingNote();
  assert.ok(note);
  assert.deepEqual(
    note.items.map((i) => i.summary),
    ["distinct training change"]
  );
});

test("planUpcomingNote is null when nothing training/recovery is waiting in the window", () => {
  assert.equal(planUpcomingNote(), null);
  // Beyond the 10-day forward window → still null.
  recordDecision(decision({ effective_date: inDays(40), summary: "far future" }));
  assert.equal(planUpcomingNote(), null);
  // Only an off-tab domain waiting → still null on the Plan surface.
  recordDecision(decision({ effective_date: inDays(3), summary: "nutrition only", domain: "nutrition", action: { proposal_id: 21 } }));
  assert.equal(planUpcomingNote(), null);
});

// ---- what already landed, and why ------------------------------------------
// The conference writes `action.user_explanation` — one sentence for the athlete —
// on every path it takes, and until now nothing anywhere read it. A hold that took
// effect today also dropped out of the forward window the moment its date arrived,
// which is exactly when someone starts wondering why their week looks different.

test("a case-conference hold reaches the Plan surface with its athlete-facing sentence", () => {
  recordDecision(
    decision({
      effective_date: inDays(0),
      kind: "case_conference",
      status: "review",
      autonomy_tier: "ask",
      summary: "Holding the current block.",
      action: {
        proposal_id: 31,
        user_explanation: "I am keeping the block as it is while your sleep settles, and I will look again on Monday.",
      },
    })
  );

  const note = planUpcomingNote();
  assert.ok(note, "a waiting decision alone is enough to produce a note");
  assert.deepEqual(note.items, [], "nothing is queued forward");
  assert.equal(note.awaiting.length, 1);
  assert.equal(note.awaiting[0].summary, "Holding the current block.");
  assert.match(note.awaiting[0].explanation, /keeping the block as it is/);
});

test("landed rows carry an explanation or stay off the surface entirely", () => {
  // An applied change with no conference sentence speaks through the plan items
  // themselves; repeating it here would say the same thing twice.
  recordDecision(
    decision({
      effective_date: inDays(-1),
      status: "applied",
      summary: "A bounded target step.",
      rationale: null,
      applied_at: `${inDays(-1)}T12:00:00Z`,
      action: { proposal_id: 41 },
    })
  );
  // A routine review hold with nothing written for a person is bookkeeping, not
  // accountability.
  recordDecision(
    decision({
      effective_date: inDays(0),
      status: "review",
      autonomy_tier: "ask",
      summary: "Held for review.",
      rationale: null,
      action: { proposal_id: 42 },
    })
  );
  assert.equal(planUpcomingNote(), null);
});

// The failure this exists to prevent: the brain's own good intent going stale in a
// drawer. A hold is an open question waiting on the athlete, so it must NOT age out
// the way a landed change does.
test("a hold waiting on the athlete does not age out of the surface", () => {
  recordDecision(
    decision({
      effective_date: inDays(-30),
      kind: "case_conference",
      status: "review",
      autonomy_tier: "ask",
      summary: "Raise the anchor lifts to three sets.",
      action: { proposal_id: 51, user_explanation: "Your recovery has room, so the anchor lifts can carry a third set." },
    })
  );
  const note = planUpcomingNote();
  assert.ok(note, "a month-old hold is still waiting, so it is still shown");
  assert.equal(note.awaiting.length, 1);
  assert.match(note.awaiting[0].explanation, /third set/);
  assert.ok(!note.landed, "it is an open question, not a landed change");
});

test("an APPLIED change older than the week window has stopped explaining anything", () => {
  recordDecision(
    decision({
      effective_date: inDays(-30),
      status: "applied",
      summary: "An old step.",
      rationale: "Three clean sessions a month ago.",
      applied_at: `${inDays(-30)}T12:00:00Z`,
      action: { proposal_id: 52 },
    })
  );
  assert.equal(planUpcomingNote(), null);
});

test("awaitingBrainDecisions is cross-domain — a labs conference has nowhere else to land", () => {
  recordDecision(
    decision({
      effective_date: null,
      domain: "health",
      kind: "case_conference",
      status: "review",
      autonomy_tier: "ask",
      summary: "Your markers moved together.",
      action: {
        proposal_id: 71,
        user_explanation: "Your endurance, body composition and metabolic markers all improved together.",
      },
    })
  );
  // The Plan tab is correctly scoped to training/recovery, so it does NOT show this.
  assert.equal(planUpcomingNote(), null);
  const waiting = repo.awaitingBrainDecisions();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].domain, "health");
  assert.match(waiting[0].explanation, /improved together/);
});

// "Waiting on you" answers to a sentence a conductor wrote FOR the athlete, and to
// nothing else. Falling back to `rationale` admitted almost every review/observed
// row — including two writers that are pure bookkeeping, one of whose rationale is
// machine register about immutability and Undo history.
test("bookkeeping rows stay off the waiting surface, and the real hold stays on", () => {
  // The per-directive audit row propagation re-derives every day.
  recordDecision(
    decision({
      effective_date: inDays(0),
      domain: "health",
      kind: "health_directive",
      status: "observed",
      autonomy_tier: "clinician",
      summary: "Ferritin watch directive.",
      rationale: "Ferritin sits below its optimal band.",
      source_ref_type: "directive",
      source_ref_key: "d-1",
      action: { directive_id: 1 },
    })
  );
  // The underfuelling coordination link: an immutable record of two decisions
  // being related, whose rationale talks about rewriting Undo history.
  recordDecision(
    decision({
      effective_date: inDays(0),
      domain: "cross_domain",
      kind: "recovery_adjustment",
      status: "observed",
      autonomy_tier: "observe",
      summary: "The protective fuel correction and recovery plan are linked.",
      rationale:
        "This immutable link records coordination without rewriting either original decision or its Undo history.",
      source_ref_type: null,
      source_ref_key: null,
      action: { recovery_decision_id: 9 },
    })
  );
  // The day read's own observation row — the Brief already speaks it.
  recordDecision(
    decision({
      effective_date: inDays(0),
      domain: "cross_domain",
      kind: "day_read",
      status: "observed",
      autonomy_tier: "observe",
      summary: "A steady day.",
      rationale: "Sleep and load both sit where they were last week.",
      source_ref_type: "day_read",
      source_ref_key: inDays(0),
      action: {},
    })
  );
  assert.deepEqual(repo.awaitingBrainDecisions(), [], "bookkeeping is not an open question");

  // …and a genuine hold with a conductor's own sentence is untouched by the filter.
  recordDecision(
    decision({
      effective_date: inDays(0),
      kind: "case_conference",
      status: "review",
      autonomy_tier: "ask",
      summary: "Holding the current block.",
      action: { proposal_id: 81, user_explanation: "I am keeping the block as it is while your sleep settles." },
    })
  );
  const waiting = repo.awaitingBrainDecisions();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].kind, "case_conference");
  assert.match(waiting[0].explanation, /keeping the block as it is/);
});

test("a clinician-tier conference hold still reaches the waiting surface", () => {
  recordDecision(
    decision({
      effective_date: null,
      domain: "health",
      kind: "case_conference",
      status: "review",
      autonomy_tier: "clinician",
      summary: "A lab finding needs your call.",
      action: { proposal_id: 91, user_explanation: "This one is worth a conversation with your doctor before we move." },
    })
  );
  const waiting = repo.awaitingBrainDecisions();
  assert.equal(waiting.length, 1, "tier is not the filter — the sentence is");
  assert.match(waiting[0].explanation, /worth a conversation/);
});

test("a garbled ?limit= cannot read as 'nothing is waiting'", () => {
  recordDecision(
    decision({
      effective_date: inDays(0),
      kind: "case_conference",
      status: "review",
      autonomy_tier: "ask",
      summary: "Holding the current block.",
      action: { proposal_id: 101, user_explanation: "I am keeping the block as it is while your sleep settles." },
    })
  );
  assert.equal(repo.awaitingBrainDecisions(Number("abc")).length, 1, "NaN falls back to the default");
  assert.equal(repo.awaitingBrainDecisions(0).length, 1);
});

test("the decisions endpoint payload lifts user_explanation out of the action blob", () => {
  recordDecision(
    decision({
      effective_date: inDays(0),
      kind: "case_conference",
      status: "review",
      autonomy_tier: "ask",
      summary: "Holding the current block.",
      action: { proposal_id: 61, user_explanation: "I am keeping the block as it is while your sleep settles." },
    })
  );
  const [row] = repo.listReadableBrainDecisions({ limit: 1 });
  assert.match(row.user_explanation, /keeping the block as it is/);
  // No conference sentence -> the decision's own rationale is the same register.
  recordDecision(
    decision({ effective_date: inDays(1), summary: "A step.", rationale: "Three clean sessions in a row.", action: { proposal_id: 62 } })
  );
  const [newest] = repo.listReadableBrainDecisions({ limit: 1 });
  assert.equal(newest.user_explanation, "Three clean sessions in a row.");
});
