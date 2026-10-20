// v2 wave 1 — "The team decides, you Undo". Under lead, a training target, a rotation
// and a restructure are decided and announced rather than asked (LEAD_DECIDED_KINDS);
// asks still waiting at the switch are re-decided through the ordinary sweep (dead
// premise first, then the thaw), never applied blindly; and the Changes feed projects
// the ledger in the athlete's register with the server-owned Undo.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { decideAutonomyTier, LEAD_DECIDED_KINDS } from "../dist/brain/autonomy.js";
import {
  adoptOrphanedDrafts,
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  buildProgressionWithAutonomy,
  revertDecision,
  thawParkedReviewDecisions,
} from "../dist/domain/brain/autonomy-service.js";
import { BRAIN_CHANGES_SEEN_KEY, brainChangesRead, markBrainChangesSeen } from "../dist/domain/brain/changes-feed.js";
import { BRAIN_CHANGE_OUTCOME_PHRASES } from "../dist/contracts/brain-changes.js";
import { connectedBrainRouter } from "../dist/routes/connected-brain.js";
import { registerConnectedBrainTools } from "../dist/surfaces/mcp/connected-brain.js";
import * as repo from "../dist/repo.js";
import { stampsByPlanKey } from "../dist/repo/prescription-authorship.js";
import { db } from "../dist/db.js";
import { savePlanDaySettled } from "./_seed.js";

const PRESS = "ZFeed Press";

function seedPress(weight = 100) {
  repo.savePlanDay(1, "Push", "chest", [{ exercise: PRESS, sets: 3, rep_low: 6, rep_high: 8, target_weight: weight }]);
}

function pressDraft(targetWeight = 105, extra = {}) {
  return repo.createProposal("stub", "auto: press step", "", {
    summary: `Raise the ${PRESS} to ${targetWeight}`,
    rationale: "Every set landed at the top of the range last week, so the load steps up.",
    changes: [{ day_number: 1, exercise: PRESS, target_weight: targetWeight, reason: "top of the range" }],
    ...extra,
  });
}

// The plan as the athlete sees it: every field but the surrogate row ids, which a
// whole-day restore re-mints.
function planContent() {
  return repo.getPlan().map(({ id: _day, ...day }) => ({
    ...day,
    items: day.items.map(({ id: _item, plan_day_id: _owner, ...item }) => item),
  }));
}

function feedRows(read = brainChangesRead()) {
  return read.days.flatMap((day) => day.changes);
}

function reviewRows() {
  return repo.listBrainDecisions({ status: "review", limit: 100 });
}

function backdateHours(id, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

// The hold an OLDER pass left under lead: before this wave a requested ask on a training
// target held for review under lead. Written the way that pass wrote it (a live review
// row recording the requested ask), because today's policy no longer produces one.
function olderLeadHold(proposalId, stamp = {}) {
  const held = applyProposalWithAutonomy(Number(proposalId), { user_locked: true });
  assert.equal(held.decision.status, "review");
  return repo.patchBrainDecision(Number(held.decision.id), {
    context: {
      ...held.decision.context,
      review_reason_code: "requested_review",
      policy_inputs: { ...held.decision.context.policy_inputs, requested_tier: "ask", user_locked: false },
      ...stamp,
    },
  });
}

function seedMaterialTrainingChange(index) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: `A material training change ${index}`,
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: false,
    context: null,
    action: { seed: index },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

// ---------- policy ----------

test("under lead the lapsing kinds are decided and announced; every floor still asks", () => {
  const base = { risk_class: "low", reversible: true, lead_mode: "lead" };
  assert.deepEqual([...LEAD_DECIDED_KINDS].sort(), ["exercise_rotation", "training_structure", "training_target"]);
  for (const kind of LEAD_DECIDED_KINDS) {
    const decided = decideAutonomyTier({ ...base, kind, requested_tier: "ask" });
    assert.equal(decided.tier, "announce", kind);
    assert.ok(decided.natural_boundary_required, `${kind} still waits for its natural boundary`);
    // A requested clinician with no clinical mark is an opinion, not the floor.
    assert.equal(decideAutonomyTier({ ...base, kind, requested_tier: "clinician" }).tier, "announce", kind);
    // The floors, in both directions.
    assert.equal(decideAutonomyTier({ ...base, kind, requested_tier: "ask", clinical: true }).tier, "clinician");
    assert.equal(
      decideAutonomyTier({ ...base, kind, risk_class: "clinical", requested_tier: "ask" }).tier,
      "clinician"
    );
    assert.equal(decideAutonomyTier({ ...base, kind, requested_tier: "ask", user_locked: true }).tier, "ask");
    assert.equal(decideAutonomyTier({ ...base, kind, requested_tier: "ask", clamp_refused: true }).tier, "ask");
    assert.equal(decideAutonomyTier({ ...base, kind, requested_tier: "ask", reversible: false }).tier, "ask");
    // The other postures keep the requested ask exactly.
    assert.equal(decideAutonomyTier({ ...base, kind, requested_tier: "ask", lead_mode: "announce_first" }).tier, "ask");
    assert.equal(
      decideAutonomyTier({ ...base, kind, requested_tier: "ask", lead_mode: "review_everything" }).tier,
      "ask"
    );
  }
  // Outside the lapsing kinds nothing moved.
  assert.equal(decideAutonomyTier({ ...base, kind: "nutrition_target", requested_tier: "ask" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, kind: "meal_plan", requested_tier: "ask" }).tier, "ask");
  // A goal change keeps the heads-up it already had under lead, and asks elsewhere.
  assert.equal(decideAutonomyTier({ ...base, kind: "training_target", goal_identity: true }).tier, "announce");
  assert.equal(
    decideAutonomyTier({ ...base, kind: "training_target", goal_identity: true, lead_mode: "announce_first" }).tier,
    "ask"
  );
});

test("a clinical change still asks, and never reaches the feed", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress();
  const draft = pressDraft(95, { summary: "Hold the press while the iron medication dosage is reviewed" });
  const held = applyProposalWithAutonomy(Number(draft.id), { requested_tier: "ask", clinical: true });
  assert.equal(held.review_required, true);
  assert.equal(held.tier, "clinician");
  assert.equal(held.decision.status, "review");
  assert.equal(repo.getProposal(Number(draft.id)).status, "draft", "nothing clinical applies on its own");
  assert.deepEqual(feedRows(), [], "a question is not a change");
});

// ---------- a lapsing kind lands, shows in the feed, and Undo restores it exactly ----------

test("a lapsing-kind change lands without a waiting row, appears in the feed, and Undo restores the snapshot exactly", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const before = planContent();
  const stampsBefore = stampsByPlanKey();
  const draft = pressDraft(105);

  const routed = applyProposalWithAutonomy(Number(draft.id), { requested_tier: "ask" });
  assert.equal(routed.review_required, undefined, "no question for the athlete");
  assert.equal(routed.announced, true);
  assert.equal(routed.decision.status, "announced");
  assert.deepEqual(reviewRows(), [], "no waiting row was written");
  assert.deepEqual(repo.awaitingBrainDecisions(), []);

  // Announced: in the feed as news, with the hold as its Undo.
  let read = brainChangesRead();
  let [row] = feedRows(read);
  assert.equal(row.id, Number(routed.decision.id));
  assert.equal(row.state, "announced");
  assert.equal(row.title, `Raise the ${PRESS} to 105`);
  assert.match(row.why, /top of the range/);
  assert.equal(row.lands_on, routed.effective_date);
  assert.match(row.status_line, /^Lands /);
  assert.deepEqual(row.outcome, { key: "too_early", phrase: BRAIN_CHANGE_OUTCOME_PHRASES.too_early });
  assert.ok(["tentative", "observed", "strong"].includes(row.confidence));
  assert.deepEqual(row.undo, { available: true, label: `Keep your current ${PRESS} target` });
  assert.equal(row.new, true);
  assert.equal(read.since_seen, 1);
  assert.match(read.since_seen_line, /^1 change (overnight|since you last looked)$/);

  // It lands at its boundary with the server snapshot behind it.
  const landed = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(landed.applied, [Number(routed.decision.id)]);
  assert.equal(repo.getPlan()[0].items[0].target_weight, 105);
  read = brainChangesRead({ asOf: routed.effective_date });
  [row] = feedRows(read);
  assert.equal(row.state, "applied");
  assert.equal(row.lands_on, null);
  assert.deepEqual(row.undo, { available: true, label: `Restore previous ${PRESS} target` });

  // Undo is the existing server revert, and it restores the plan exactly.
  const undone = revertDecision(row.id, "user undo");
  assert.equal(undone.ok, true, undone.error);
  assert.deepEqual(planContent(), before, "the snapshot is restored exactly");
  assert.deepEqual(stampsByPlanKey(), stampsBefore, "down to when each slot was prescribed");
  [row] = feedRows(brainChangesRead({ asOf: routed.effective_date }));
  assert.equal(row.state, "reverted");
  assert.deepEqual(row.outcome, { key: "stopped", phrase: BRAIN_CHANGE_OUTCOME_PHRASES.stopped });
  assert.deepEqual(row.undo, { available: false, label: null });
  assert.equal(row.new, false, "putting it back is the athlete's own act, not news");
});

test("holding an announced change is its Undo, and the feed says it was stopped", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  assert.equal(revertDecision(Number(routed.decision.id), "user hold").ok, true);
  const [row] = feedRows();
  assert.equal(row.state, "held");
  assert.equal(row.outcome.key, "stopped");
  assert.equal(row.undo.available, false);
  assert.equal(repo.getPlan()[0].items[0].target_weight, 100, "nothing landed");
});

// ---------- asks still waiting at the switch ----------

test("a stale ask whose target left the plan is retired by the sweep, never applied", () => {
  repo.setSettings({ lead_mode: "announce_first" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Decline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = repo.createProposal("stub", "auto: rotate", "", {
    summary: "Swap Decline Bench Press for Chest Dips on day 2",
    changes: [{ day_number: 2, swap: { from: "Decline Bench Press", to: "Chest Dips" }, reason: "stalled" }],
  });
  const held = applyProposalWithAutonomy(Number(draft.id), { requested_tier: "ask" });
  assert.equal(held.decision.status, "review", "an ask waiting under the older posture");
  // The plan moved on without the movement it asks about, then the athlete's team leads.
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  repo.setSettings({ lead_mode: "lead" });
  backdateHours(draft.id, 3);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.retired, 1);
  assert.equal(repo.getProposal(Number(draft.id)).status, "superseded");
  const closed = repo.getBrainDecision(Number(held.decision.id));
  assert.equal(closed.status, "superseded");
  assert.equal(closed.context.retire_reason, "premise_gone");
  const items = repo.getPlan().flatMap((day) => day.items.map((item) => item.exercise));
  assert.ok(!items.includes("Chest Dips"), "the dead swap never landed");
  assert.deepEqual(reviewRows(), []);
  const read = brainChangesRead();
  assert.deepEqual(feedRows(read), [], "a retired question is not a change");
  // …but it never silently disappears: one quiet set-aside line, in plain words.
  assert.equal(read.set_aside.length, 1);
  assert.equal(
    read.set_aside[0].line,
    "An older draft for Decline Bench Press was set aside: what it was about is no longer in your plan."
  );
  assert.equal(read.set_aside[0].label, "Today");
  assert.equal(read.since_seen, 0, "housekeeping is never news");
});

test("a surviving ask is re-decided through the autonomy path, the surprise budget in force", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const draft = pressDraft(105);
  // Parked by the pass before this one (thaw pass 2), which a stamp alone would skip.
  const hold = olderLeadHold(draft.id, { thaw_attempted: true, thaw_pass: 2 });
  for (let index = 0; index < 3; index += 1) seedMaterialTrainingChange(index);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.retired, 0);
  assert.equal(sweep.thawed, 1, "the older pass's stamp is owed one read by this one");
  const live = repo.getProposal(Number(draft.id)).autonomy;
  assert.equal(live.status, "announced", "re-decided under today's tier, not applied");
  const decision = repo.getBrainDecision(Number(live.id));
  assert.equal(decision.context.surprise_budget_deferred, true, "a full week still paces it");
  assert.notEqual(repo.getBrainDecision(Number(hold.id)).status, "review", "the old ask is closed");
  assert.equal(repo.getPlan()[0].items[0].target_weight, 100, "nothing was applied by the sweep");
  assert.equal(repo.getProposal(Number(draft.id)).status, "draft", "the draft waits for its boundary");
});

test("a hold read under another posture is read again once the athlete switches to lead", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const switched = pressDraft(105);
  olderLeadHold(switched.id, { thaw_attempted: true, thaw_pass: 3, thaw_lead_mode: "announce_first" });
  const settled = repo.createProposal("stub", "auto: second press step", "", {
    summary: `Raise the ${PRESS} to 110`,
    changes: [{ day_number: 1, exercise: PRESS, target_weight: 110, reason: "top of the range" }],
  });
  const settledHold = olderLeadHold(settled.id, { thaw_attempted: true, thaw_pass: 3, thaw_lead_mode: "lead" });

  const thaw = thawParkedReviewDecisions("lead");
  assert.equal(thaw.thawed, 1);
  assert.equal(repo.getProposal(Number(switched.id)).autonomy.status, "announced");
  assert.equal(repo.getBrainDecision(Number(settledHold.id)).status, "review", "already read under lead");
});

// ---------- the projection ----------

test("the feed shows only the team's changes, in the athlete's register, with no internals", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  // The athlete's own manual apply answered an ask: their act, not the team's change.
  const manual = pressDraft(102);
  repo.applyProposal(Number(manual.id));
  // A team change whose only written reason is a producer's machine note.
  const team = repo.createProposal("stub", "auto: nudge", "", {
    summary: `Raise the ${PRESS} to 107`,
    changes: [{ day_number: 1, exercise: PRESS, target_weight: 107, reason: "top of the range" }],
  });
  const applied = applyProposalWithAutonomy(Number(team.id));
  assert.equal(applied.decision.status, "applied");

  const read = brainChangesRead();
  const rows = feedRows(read);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, Number(applied.decision.id));
  assert.equal(row.state, "applied");
  // Neither the producer's note ("auto: nudge") nor the change's fragment ("top of the
  // range") is a sentence to the athlete, so nothing is said rather than either.
  assert.equal(row.why, null, "a producer's note or a fragment is never the why");
  assert.deepEqual(Object.keys(row).sort(), [
    "confidence",
    "day",
    "domain",
    "id",
    "lands_on",
    "new",
    // The date the change adapted, when one of the days ahead carries its plan day.
    "open_day",
    "outcome",
    // The same change as one uniform receipt (src/contracts/change-receipt.ts).
    "receipt",
    "state",
    "status_line",
    "title",
    "undo",
    "why",
  ]);
  assert.deepEqual(
    read.days.map((day) => day.label),
    ["Today"]
  );
  const json = JSON.stringify(read);
  assert.doesNotMatch(json, /autonomy_tier|verdict|evaluator|risk_class|score/i, "no internals, no grades");
  assert.ok(Object.values(BRAIN_CHANGE_OUTCOME_PHRASES).includes(row.outcome.phrase));
});

test("since_seen counts the team's changes after the marker, and the marker never moves back", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  applyProposalWithAutonomy(Number(pressDraft(105).id));
  assert.equal(brainChangesRead().since_seen, 1);

  const first = brainChangesRead();
  const seen = markBrainChangesSeen({ through: first.seen_through });
  assert.equal(seen.ok, true);
  let read = brainChangesRead();
  assert.equal(read.since_seen, 0);
  assert.equal(read.since_seen_line, null, "zero hides the Today line");
  assert.equal(read.seen_at, seen.seen_at);

  // An earlier `through` never walks the marker back.
  const earlier = new Date(Date.parse(seen.seen_at) - 60_000).toISOString();
  assert.equal(markBrainChangesSeen({ through: earlier }).seen_at, seen.seen_at);

  // A change after the marker is new again, and the count equals the new rows shown.
  db.prepare(`UPDATE app_state SET value = ? WHERE key = ?`).run(
    new Date(Date.now() - 60_000).toISOString(),
    BRAIN_CHANGES_SEEN_KEY
  );
  applyProposalWithAutonomy(
    Number(
      repo.createProposal("stub", "auto: step", "", {
        summary: `Raise the ${PRESS} to 110`,
        changes: [{ day_number: 1, exercise: PRESS, target_weight: 110, reason: "top of the range" }],
      }).id
    )
  );
  read = brainChangesRead();
  assert.equal(read.since_seen, feedRows(read).filter((row) => row.new).length);
  assert.ok(read.since_seen >= 1);
});

// ---------- producer labels never reach the athlete ----------

const BENCH = "Barbell Bench Press";

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// A bench history that EARNS a +5 lb step (the routineProgressionBudget seed), so the
// real deterministic producer writes its own draft.
function seedEarnedBench() {
  repo.upsertExercise({ name: BENCH, muscle_group: "chest" });
  savePlanDaySettled(1, "Push", "Push", [{ exercise: BENCH, sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }]);
  const ex = repo.findExercise(BENCH);
  for (const [daysAgo, weight] of [
    [28, 175],
    [21, 180],
    [10, 185],
  ]) {
    const session = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
    db.prepare(
      "INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 8, 2)"
    ).run(session.id, ex.id, weight);
  }
}

const PRODUCER_LABEL = /auto-progression|progression$|\bday \d+\b|→|swap .* →|evolve program/i;

test("a real auto-progression reads as the lift it moved, never the producer's label", () => {
  seedEarnedBench();
  repo.setSettings({ lead_mode: "lead" });
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true);
  assert.match(out.proposal.parsed.summary, /^Auto-progression for day 1/, "the producer still writes its label");
  assert.equal(out.proposal.instruction, "day 1 progression");

  const [row] = feedRows();
  assert.ok(row, "the progression is in the feed");
  assert.equal(row.title, `Raised your ${BENCH} target`, "the verb follows the snapshot: an earned step is a raise");
  assert.doesNotMatch(row.title, PRODUCER_LABEL);
  if (row.why != null) {
    assert.doesNotMatch(row.why, PRODUCER_LABEL);
    assert.notEqual(row.why, out.proposal.instruction);
  }
});

test("a real swap draft reads as the swap, and its why is the change's own reason", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const built = repo.buildSwapProposal(1, PRESS, "ZFeed Incline Press");
  assert.equal(built.ok, true);
  const routed = applyProposalWithAutonomy(Number(built.proposal.id), { requested_tier: "ask" });
  assert.equal(routed.decision.status, "announced");

  const [row] = feedRows();
  assert.equal(row.title, `Swapped ${PRESS} for ZFeed Incline Press`);
  assert.equal(row.why, `Rotate a same-pattern variation in for ${PRESS}.`);
  assert.doesNotMatch(`${row.title} ${row.why}`, PRODUCER_LABEL);
  assert.deepEqual(row.undo, { available: true, label: `Keep ${PRESS}` });
});

test("with nothing written for the athlete the why is null, never an invented cause", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: PRESS, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    { exercise: "ZFeed Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 },
  ]);
  const draft = repo.createProposal("stub", "evolve program", "", {
    summary: "Nudged two of your pressing and pulling targets",
    changes: [
      { day_number: 1, exercise: PRESS, target_weight: 105 },
      { day_number: 1, exercise: "ZFeed Row", target_weight: 85 },
    ],
  });
  applyProposalWithAutonomy(Number(draft.id));
  const [row] = feedRows();
  assert.equal(row.title, "Nudged two of your pressing and pulling targets");
  assert.equal(row.why, null, "the instruction is not a why, and no cause is made up");
});

test("an athlete-facing sentence that opens with a colon phrase still reads", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  applyProposalWithAutonomy(
    Number(
      repo.createProposal("stub", "auto: heads-up", "", {
        summary: `Heads up: the ${PRESS} moves to 105`,
        rationale: "Heads up: every set landed at the top of the range, so the load steps up.",
        changes: [{ day_number: 1, exercise: PRESS, target_weight: 105 }],
      }).id
    )
  );
  const [row] = feedRows();
  assert.equal(row.title, `Heads up: the ${PRESS} moves to 105`);
  assert.match(row.why, /^Heads up: every set landed/);
});

test("one decision is news once: seen when announced, its landing is not counted again", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  assert.equal(routed.decision.status, "announced");
  const first = brainChangesRead();
  assert.equal(first.since_seen, 1);
  markBrainChangesSeen({ through: first.seen_through });

  applyDueAnnouncedDecisions(routed.effective_date);
  const read = brainChangesRead({ asOf: routed.effective_date });
  const [row] = feedRows(read);
  assert.equal(row.state, "applied");
  assert.equal(row.new, false, "the announcement already told the athlete");
  assert.equal(read.since_seen, 0);
});

// ---------- REST + MCP near-mirror ----------

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", connectedBrainRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

function mcpTools() {
  const tools = new Map();
  registerConnectedBrainTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  return async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);
}

test("GET /api/brain/changes and get_brain_changes answer the same read; seen mirrors too", async () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  applyProposalWithAutonomy(Number(pressDraft(105).id));
  const call = mcpTools();

  await withServer(async (base) => {
    const rest = await (await fetch(`${base}/api/brain/changes?days=7`)).json();
    const mcp = await call("get_brain_changes", { days: 7 });
    assert.deepEqual({ ...mcp, seen_through: null }, { ...rest, seen_through: null }, "the two surfaces are one read");
    assert.equal(rest.since_seen, 1);

    const marked = await (
      await fetch(`${base}/api/brain/changes/seen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ through: rest.seen_through }),
      })
    ).json();
    assert.equal(marked.ok, true);
    assert.equal((await call("get_brain_changes", {})).since_seen, 0);
    const again = await call("mark_brain_changes_seen", {});
    assert.equal(again.ok, true);
    assert.ok(Date.parse(again.seen_at) >= Date.parse(marked.seen_at));
  });
});

// The live case from a real Today: a superseded conference draft whose own summary is
// engineering prose with an ISO date and a gate ("re-enter Back Squat at 185 x 3 x 5-7 …
// behind a brace gate; hold…"). The set-aside line is worded from what the draft touched
// and the receipt's machine reason — never that summary, and never twice for one draft.
function setAsideReceipt(proposalId, outcome, extra = {}) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: "A held draft was set aside instead of applied.",
    rationale: "A newer team review replaced this one. Nothing changed; a fresh read can pick this up from where you are now.",
    source: "case_conference",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposalId),
    status: "superseded",
    autonomy_tier: "ask",
    risk_class: "low",
    reversible: false,
    input_fingerprint: null,
    context: { thaw_receipt: true, review_reason_code: "source_superseded", ...extra },
    action: { proposal_id: Number(proposalId), outcome },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

test("a meal-plan draft retired as a stale plan reads in plain words, never the fallback", () => {
  for (const outcome of ["superseded_stale_plan", "some_future_outcome"]) {
    repo.recordDecision({
      effective_date: null,
      kind: "meal_plan",
      domain: "nutrition",
      summary: "A held draft was set aside instead of applied.",
      rationale: "This meal-plan draft sat unapplied for more than 14 days.",
      source: "autonomy",
      source_ref_type: "meal_plan",
      source_ref_key: outcome === "superseded_stale_plan" ? "901" : "902",
      status: "superseded",
      autonomy_tier: "ask",
      risk_class: "low",
      reversible: false,
      input_fingerprint: null,
      context: { thaw_receipt: true, review_reason_code: "stale_plan" },
      action: { meal_plan_id: outcome === "superseded_stale_plan" ? 901 : 902, outcome },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  }
  const lines = brainChangesRead().set_aside.map((row) => row.line);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line, "An older draft for a week of meals was set aside: it sat too long to still fit your week.");
  }
});

test("a set-aside draft is one plain line in the feed, never its agent summary, a date or a threshold", () => {
  const draft = repo.createProposal("case_conference", "case conference: weekly", "", {
    summary:
      "Week of 2026-09-28: re-enter Back Squat at 185 x 3 x 5-7 on Wednesday Lower A behind a brace gate; hold RIR >= 2.",
    changes: [{ day_number: 3, exercise: "Back Squat", target_weight: 185, reason: "brace gate" }],
  });
  setAsideReceipt(draft.id, "superseded_by_newer_review");
  // A later sweep filing a second receipt for the same draft says nothing new.
  setAsideReceipt(draft.id, "superseded_by_newer_review");
  const nutrition = repo.createProposal("case_conference", "case conference: weekly", "", {
    kind: "nutrition_target",
    summary: "Hold 2,350 kcal through 2026-10-04.",
  });
  setAsideReceipt(nutrition.id, "superseded_stale_proposal");

  const read = brainChangesRead();
  assert.deepEqual(feedRows(read), [], "nothing moved, so nothing is a change");
  assert.equal(read.since_seen, 0);
  const lines = read.set_aside.map((row) => row.line).sort();
  assert.deepEqual(lines, [
    "An older draft for Back Squat was set aside: a newer review replaced it.",
    "An older draft for your calorie target was set aside: it waited too long to still fit.",
  ]);
  for (const line of lines) {
    assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}|RIR|>=|brace gate|Week of|\.\./, line);
  }
  assert.ok(read.set_aside.every((row) => row.label === "Today" && Number(row.id) > 0));
});
