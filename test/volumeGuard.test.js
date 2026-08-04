// Prescribed VOLUME has no ladder back up.
//
// Nothing in the progression or push ladder can RAISE an item's `sets`, so a set
// reduction is permanent unless something deliberately gives it back. These cover
// the three guards on that:
//   1. an applied change lowers `sets` by at most ONE step per revision;
//   2. a set-reducing conference revision is structural (announce), never quiet;
//   3. the reduction records what it owes, and a cleared hold climbs back one set
//      per boundary — stopping at the recorded prior, and never over a number the
//      athlete has since chosen themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { getBrainDecision } from "../dist/repo/brain-decisions.js";
import { runCaseConference } from "../dist/domain/brain/case-conference.js";
import { runUnderfuelingControlLoop } from "../dist/domain/brain/underfueling-service.js";
import { changesReduceSets, openVolumeRestoreTargets } from "../dist/repo/volume-guard.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

function seedPlan(sets = 5) {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets, rep_low: 6, rep_high: 8, target_weight: 115 },
    { exercise: "Incline DB Press", sets, rep_low: 8, rep_high: 12, target_weight: 50 },
  ]);
}

function planSets(exercise) {
  const item = repo.getPlanDay(1).items.find((entry) => entry.exercise === exercise);
  return item ? item.sets : null;
}

// Apply a sets change the way the coaching loop does: a draft proposal through the
// real apply path (clamp on), never a direct write. `volume_cause: "fuel"` is what
// the fuel-protection prescription stamps on its own changes; pass it as null in
// `extra` to model a cut something ELSE asked for.
function applySetsChange(exercise, sets, extra = {}) {
  const change = {
    day_number: 1,
    exercise,
    sets,
    reason: "Fuelling is short right now.",
    volume_cause: "fuel",
    ...extra,
  };
  if (change.volume_cause == null) delete change.volume_cause;
  const proposal = repo.createProposal("test", "volume change", "", { summary: "cut volume", changes: [change] });
  return repo.applyProposal(proposal.id);
}

// Several changes naming the same item inside ONE proposal — the shape that walked
// an item down several steps in a single apply.
function applyChanges(changes) {
  const proposal = repo.createProposal("test", "volume change", "", { summary: "cut volume", changes });
  return repo.applyProposal(proposal.id);
}

// ── 1. the step clamp ─────────────────────────────────────────────────────────

test("an applied change that would drop 5 sets to 1 lands as 4 — one step, not a collapse", () => {
  seedPlan(5);
  const result = applySetsChange("Barbell Bench Press", 1);
  assert.equal(result.ok, true, "the change applies");
  assert.equal(planSets("Barbell Bench Press"), 4, "volume came down exactly one step");
});

test("a second application steps 4 to 3 — the descent is gradual, never refused", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1);
  assert.equal(planSets("Barbell Bench Press"), 4);
  applySetsChange("Barbell Bench Press", 1);
  assert.equal(planSets("Barbell Bench Press"), 3, "the halver keeps proposing; the clamp keeps it one step");
});

test("the clamp is transparent — the receipt says what was requested and what applied", () => {
  seedPlan(5);
  const result = applySetsChange("Barbell Bench Press", 1);
  const clamp = (result.clamped || []).find((entry) => entry.field === "sets");
  assert.ok(clamp, "the adjustment is reported, never silent");
  assert.equal(clamp.requested, 1);
  assert.equal(clamp.applied, 4);
  assert.equal(clamp.exercise, "Barbell Bench Press");
});

test("raising sets is untouched, and a one-step cut passes through unchanged", () => {
  seedPlan(3);
  applySetsChange("Barbell Bench Press", 6);
  assert.equal(planSets("Barbell Bench Press"), 6, "increases are not stepped");
  applySetsChange("Barbell Bench Press", 5);
  assert.equal(planSets("Barbell Bench Press"), 5, "a single-step cut is exactly what was asked for");
});

// The path that actually cut live volume: applyFuelProtection halves `sets`,
// buildProgressionProposal re-emits it alongside the deloaded target on ONE change,
// and the next apply halves what the last one left. These pin the whole arc for
// that exact shape — clamped on the way down, recorded, and reversible.
test("a fuel-protection deload's halved sets is stepped while its load step still lands", () => {
  seedPlan(5);
  const result = applySetsChange("Barbell Bench Press", 3, { target_weight: 104 });
  assert.equal(result.ok, true);
  assert.equal(planSets("Barbell Bench Press"), 4, "the volume half descends one step");
  assert.equal(
    repo.getPlanDay(1).items.find((item) => item.exercise === "Barbell Bench Press").target_weight,
    104,
    "the load half is untouched by the volume clamp"
  );
});

test("the repeated halver cannot ratchet a lift down, and every step stays owed back", () => {
  seedPlan(5);
  // What the halver does unattended: ceil(n/2) against whatever the last apply left.
  applySetsChange("Barbell Bench Press", 3, { target_weight: 104 }); // ceil(5/2)
  applySetsChange("Barbell Bench Press", 2, { target_weight: 94 }); // ceil(4/2)
  applySetsChange("Barbell Bench Press", 2, { target_weight: 85 }); // ceil(3/2)
  assert.equal(planSets("Barbell Bench Press"), 2, "three passes cost three sets, not four");

  const recorded = latestVolumeRestore();
  assert.equal(recorded[0].applied_sets, 2);
  assert.equal(recorded[0].restore_to, 5, "the halver's damage is owed back in full");

  // …and the whole descent is walked back one set at a time.
  for (const expected of [3, 4, 5]) {
    const built = repo.buildVolumeRestoreProposal();
    assert.equal(built.ok, true);
    assert.equal(built.proposal.parsed.changes[0].sets, expected);
    repo.applyProposal(built.proposal.id);
    assert.equal(planSets("Barbell Bench Press"), expected);
  }
  assert.equal(repo.buildVolumeRestoreProposal().ok, false, "back where it started, and it stops there");
});

// A revision is ONE step, however many entries it is written as. Each change used to
// be clamped against the row's live value, so a payload naming the same item three
// times walked 5 → 4 → 3 → 2 inside a single apply — and the ledger, keeping only the
// first entry, recorded {5 → 4} over a plan holding 2. openVolumeRestoreTargets read
// that mismatch as the athlete's own edit and voided the chain: three sets gone, and
// nothing owed.
test("a proposal naming one lift three times still moves it a single step", () => {
  seedPlan(5);
  const result = applyChanges([
    { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "Fuelling is short right now." },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "Fuelling is short right now." },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "Fuelling is short right now." },
  ]);
  assert.equal(result.ok, true, "the revision applies");
  assert.equal(planSets("Barbell Bench Press"), 4, "one revision, one set — not three");
});

test("the duplicate-change ledger matches the plan, so the debt survives", () => {
  seedPlan(5);
  applyChanges([
    { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "Fuelling is short right now." },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "Fuelling is short right now." },
  ]);
  const recorded = latestVolumeRestore();
  assert.equal(recorded.length, 1, "one item, one entry");
  assert.equal(recorded[0].prior_sets, 5, "where the revision found it");
  assert.equal(recorded[0].applied_sets, 4, "where the revision actually left it");
  assert.equal(recorded[0].restore_to, 5);

  const open = openVolumeRestoreTargets();
  assert.deepEqual(
    open.map((entry) => entry.exercise),
    ["Barbell Bench Press"],
    "the chain is intact — the set is still owed back"
  );
});

// The ledger's own half of the same guard: even if a future path let the plan move
// further than one step, the recorded chain has to describe where the plan ENDED UP,
// never where the first entry left it.
test("the ledger records the last value an item was left at, not the first", () => {
  seedPlan(5);
  // Two entries the clamp lets through untouched: down one, then back up.
  applyChanges([
    { day_number: 1, exercise: "Barbell Bench Press", sets: 4, reason: "Fuelling is short right now." },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 6, reason: "Room to add one back." },
  ]);
  assert.equal(planSets("Barbell Bench Press"), 6);
  assert.equal(latestVolumeRestore()[0].applied_sets, 6, "the entry reads where the plan actually stands");
  assert.deepEqual(openVolumeRestoreTargets(), [], "a revision that ended above where it started owes nothing");
});

test("a manual edit is never stepped — the athlete drives", () => {
  seedPlan(5);
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 1, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
  assert.equal(planSets("Barbell Bench Press"), 1, "a direct plan edit takes the value given");
});

// ── 2. a volume cut is structural ─────────────────────────────────────────────

test("changesReduceSets reads the plan, not the model's account of itself", () => {
  seedPlan(4);
  assert.equal(changesReduceSets([{ day_number: 1, exercise: "Barbell Bench Press", sets: 2 }]), true);
  assert.equal(changesReduceSets([{ day_number: 1, exercise: "Barbell Bench Press", sets: 4 }]), false);
  assert.equal(changesReduceSets([{ day_number: 1, exercise: "Barbell Bench Press", sets: 6 }]), false);
  assert.equal(changesReduceSets([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 95 }]), false);
  assert.equal(changesReduceSets([{ day_number: 1, exercise: "Barbell Bench Press", remove: true }]), true);
  assert.equal(changesReduceSets([{ day_number: 1, exercise: "Not On The Plan", sets: 1 }]), false);
});

const opinion = (domain, overrides = {}) => ({
  domain,
  recommendation: "Keep the change bounded.",
  rationale: "The shared snapshot supports a cautious next step.",
  evidence_keys: [`${domain}:evidence`],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "quiet_apply",
  ...overrides,
});

function conductorDecision(revision) {
  return {
    kind: "case_conference",
    domain: "training",
    summary: "Keep the next change bounded.",
    rationale: "The shared snapshot supports one reversible step.",
    risk_class: "low",
    reversible: true,
    autonomy_tier: "quiet_apply",
    parallel_actions: [],
    resolved_conflicts: [{ key: "injury_load", resolution: "Use only the already-cleared small step." }],
    deferred: [],
    expectations: [],
    review_window: "Review in two weeks.",
    user_explanation: "I made one bounded change and will review the response.",
    revision,
  };
}

async function conferenceWith(revision) {
  return runCaseConference(
    "stub",
    { question: "Make the next bounded adjustment.", domains: ["training", "recovery"] },
    {
      context: () => ({ injury: "shoulder pain", training: "progress load" }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision(revision),
    }
  );
}

test("a set-reducing conference revision announces — it never takes the quiet load-step tier", async () => {
  seedPlan(5);
  repo.setSettings({ lead_mode: "lead" });
  const result = await conferenceWith({
    type: "plan_update",
    summary: "Trim bench volume",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 2 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.execution.tier, "announce", "a plan-wide volume cut is structural");
  assert.notEqual(result.execution.applied, true, "it does not land quietly");
  assert.equal(planSets("Barbell Bench Press"), 5, "the plan is untouched until the boundary");
});

test("a load-only conference revision keeps its prior quiet-apply behavior", async () => {
  seedPlan(5);
  repo.setSettings({ lead_mode: "lead" });
  const result = await conferenceWith({
    type: "plan_update",
    summary: "Small bench step",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.execution.applied, true, "one bounded load step still lands");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
});

// ── 3. the road back up ───────────────────────────────────────────────────────

function latestVolumeRestore() {
  const row = db
    .prepare(
      `SELECT action_json FROM brain_decisions
        WHERE status = 'applied' AND json_extract(action_json, '$.volume_restore') IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get();
  return row ? JSON.parse(row.action_json).volume_restore : null;
}

test("a reduction records the volume it owes back", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1);
  const recorded = latestVolumeRestore();
  assert.ok(Array.isArray(recorded) && recorded.length === 1, "one item carries a debt");
  assert.deepEqual(recorded[0], {
    day_number: 1,
    exercise: "Barbell Bench Press",
    prior_sets: 5,
    applied_sets: 4,
    restore_to: 5,
    cause: "fuel",
  });
});

test("a second cut inherits the older target — 5 to 4 to 3 still owes 5 back", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1);
  applySetsChange("Barbell Bench Press", 1);
  const recorded = latestVolumeRestore();
  assert.equal(recorded[0].applied_sets, 3);
  assert.equal(recorded[0].restore_to, 5, "the chain's original target is carried forward, never lowered");
});

test("an ordinary increase records no debt", () => {
  seedPlan(3);
  applySetsChange("Barbell Bench Press", 4);
  assert.equal(latestVolumeRestore(), null, "there is nothing owed for volume the athlete gained");
});

test("the climb back gives one set per boundary and stops at the recorded prior", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1); // 5 -> 4
  applySetsChange("Barbell Bench Press", 1); // 4 -> 3

  const first = repo.buildVolumeRestoreProposal();
  assert.equal(first.ok, true, "volume is owed");
  assert.equal(first.proposal.parsed.changes.length, 1);
  assert.equal(first.proposal.parsed.changes[0].sets, 4, "one set back, not the whole cut at once");
  repo.applyProposal(first.proposal.id);
  assert.equal(planSets("Barbell Bench Press"), 4);

  const second = repo.buildVolumeRestoreProposal();
  assert.equal(second.ok, true);
  assert.equal(second.proposal.parsed.changes[0].sets, 5);
  repo.applyProposal(second.proposal.id);
  assert.equal(planSets("Barbell Bench Press"), 5, "home");

  const third = repo.buildVolumeRestoreProposal();
  assert.equal(third.ok, false, "nothing left to give back — it never overshoots");
  assert.equal(planSets("Barbell Bench Press"), 5);
});

test("the restore pass is idempotent — repeated passes never stack drafts or double-step", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1);

  const a = repo.buildVolumeRestoreProposal();
  const b = repo.buildVolumeRestoreProposal();
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(
    b.proposal.parsed.changes.map((change) => change.sets),
    a.proposal.parsed.changes.map((change) => change.sets),
    "an un-applied draft re-derives the same step"
  );
  assert.equal(repo.getProposal(a.proposal.id).status, "superseded", "the stale card is retired, not stacked");
  const open = db
    .prepare(`SELECT COUNT(*) AS n FROM plan_proposals WHERE status = 'draft' AND agent = 'volume-restore'`)
    .get();
  assert.equal(open.n, 1, "at most one restore card is ever open");

  repo.applyProposal(b.proposal.id);
  assert.equal(planSets("Barbell Bench Press"), 5);
  assert.equal(repo.buildVolumeRestoreProposal().ok, false, "applying it twice cannot climb past the prior");
});

test("a manual edit after the cut voids that item's restore — Cairn does not fight the athlete", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1); // 5 -> 4, owes 5
  applySetsChange("Incline DB Press", 1); // 5 -> 4, owes 5

  // The athlete sets bench themselves; the plan no longer reads what Cairn left.
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 115 },
    { exercise: "Incline DB Press", sets: 4, rep_low: 8, rep_high: 12, target_weight: 50 },
  ]);

  const open = openVolumeRestoreTargets();
  assert.deepEqual(
    open.map((entry) => entry.exercise),
    ["Incline DB Press"],
    "only the untouched item is still owed"
  );
  const built = repo.buildVolumeRestoreProposal();
  assert.equal(built.ok, true);
  assert.deepEqual(
    built.proposal.parsed.changes.map((change) => change.exercise),
    ["Incline DB Press"]
  );
  repo.applyProposal(built.proposal.id);
  assert.equal(planSets("Barbell Bench Press"), 2, "the athlete's own number stands");
  assert.equal(planSets("Incline DB Press"), 5);
});

test("an item that has left the plan is simply forgotten", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1);
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Incline DB Press", sets: 4, rep_low: 8, rep_high: 12, target_weight: 50 },
  ]);
  assert.equal(repo.buildVolumeRestoreProposal().ok, false, "no debt survives the movement itself");
});

test("every athlete-facing restore string holds the reading grammar", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1);
  const built = repo.buildVolumeRestoreProposal();
  assert.equal(built.ok, true);
  const parsed = built.proposal.parsed;
  for (const sentence of [parsed.summary, parsed.rationale, ...parsed.changes.map((c) => c.reason)]) {
    assert.equal(violatesReadingGrammar(sentence), null, `"${sentence}" reads as coaching`);
  }
});

// ── the trigger: a cleared fuel read is the boundary ──────────────────────────

const fuelRead = (training) => ({
  state: "hold",
  signature: `test-${training}`,
  action: { kind: "hold", kcal_delta: 0, training, line: "Holding steady." },
  rationale: "test fixture",
  intake: {},
  correction: {},
});

test("the daily fuel pass gives volume back only once the hold has cleared", () => {
  seedPlan(5);
  repo.setSettings({ lead_mode: "lead" });
  applySetsChange("Barbell Bench Press", 1);

  const held = runUnderfuelingControlLoop("2026-08-04", { read: fuelRead("hold_aggression") });
  assert.equal(held.volume_restore, undefined, "while the read still holds, nothing is given back");
  assert.equal(planSets("Barbell Bench Press"), 4);

  const cleared = runUnderfuelingControlLoop("2026-08-04", { read: fuelRead("proceed") });
  assert.ok(cleared.volume_restore, "a cleared read starts the climb back");
  assert.equal(cleared.volume_restore.review_required !== true, true, "it is scheduled, not parked for review");
  const decisionId = cleared.volume_restore.decision?.id;
  assert.ok(decisionId, "the climb rides the decision ledger");
  const decision = getBrainDecision(Number(decisionId));
  assert.equal(decision.autonomy_tier, "announce", "volume coming back is announced, never quiet");
});

// ── the cut remembers WHY, so the climb back cannot borrow another story ──────

test("a fuel-caused cut climbs back on the fuel trigger, in the fuelling sentence", () => {
  seedPlan(5);
  repo.setSettings({ lead_mode: "lead" });
  applySetsChange("Barbell Bench Press", 1);
  assert.equal(latestVolumeRestore()[0].cause, "fuel");

  const built = repo.buildVolumeRestoreProposal({ cause: "fuel" });
  assert.equal(built.ok, true, "the fuel trigger owns this debt");
  const reason = built.proposal.parsed.changes[0].reason;
  assert.match(reason, /^Fuelling has settled/, "it says what actually cleared");
  assert.equal(violatesReadingGrammar(reason), null);

  const cleared = runUnderfuelingControlLoop("2026-08-04", { read: fuelRead("proceed") });
  assert.ok(cleared.volume_restore, "the fuel pass picks it up");
});

test("a cut fuelling never made keeps its debt but is not given back on a fuel story", () => {
  seedPlan(5);
  repo.setSettings({ lead_mode: "lead" });
  applySetsChange("Barbell Bench Press", 1, { volume_cause: null, reason: "The shoulder is still sore." });

  const recorded = latestVolumeRestore();
  assert.equal(recorded[0].cause, "policy", "the cut records the cause it actually had");
  assert.equal(recorded[0].restore_to, 5, "the set is still owed");
  assert.deepEqual(
    openVolumeRestoreTargets().map((entry) => entry.exercise),
    ["Barbell Bench Press"],
    "the debt is open"
  );
  assert.deepEqual(openVolumeRestoreTargets({ cause: "fuel" }), [], "…but not to the fuel trigger");

  assert.equal(repo.buildVolumeRestoreProposal({ cause: "fuel" }).ok, false, "the fuel pass has nothing to give back");
  const cleared = runUnderfuelingControlLoop("2026-08-04", { read: fuelRead("proceed") });
  assert.equal(cleared.volume_restore, undefined, "a cleared fuel read does not climb a cut it never asked for");
  assert.equal(planSets("Barbell Bench Press"), 4, "the plan is left exactly where the cut left it");
});

test("a policy cut's own restore sentence names no cause it cannot support", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1, { volume_cause: null, reason: "The shoulder is still sore." });
  const built = repo.buildVolumeRestoreProposal();
  assert.equal(built.ok, true);
  const reason = built.proposal.parsed.changes[0].reason;
  assert.doesNotMatch(reason, /Fuelling/, "no fuelling story over a cut fuelling never made");
  assert.equal(violatesReadingGrammar(reason), null);
});

test("a partly-climbed chain keeps its cause, so the next boundary still recognises it", () => {
  seedPlan(5);
  applySetsChange("Barbell Bench Press", 1); // 5 -> 4, fuel
  applySetsChange("Barbell Bench Press", 1); // 4 -> 3, fuel
  const first = repo.buildVolumeRestoreProposal({ cause: "fuel" });
  assert.equal(first.ok, true);
  repo.applyProposal(first.proposal.id);
  assert.equal(planSets("Barbell Bench Press"), 4);
  assert.equal(latestVolumeRestore()[0].cause, "fuel", "the step carries the cut's cause forward");
  const second = repo.buildVolumeRestoreProposal({ cause: "fuel" });
  assert.equal(second.ok, true, "the rest of the debt is still the fuel trigger's");
  assert.equal(second.proposal.parsed.changes[0].sets, 5);
});
