// A write addressed by a spelling that is not the stored one lands on the row the one
// resolver means, and SAYS so; an agent's spelling is only ever a pointer to a stored row.
//
// Covered here:
//   - upsert_exercise / POST /api/exercises on "DB Bicep Curl" edits the stored
//     "Dumbbell Biceps Curl" (its supplied group is the person's) and the receipt names
//     the stored row with resolved_from; an exact (case-insensitive) hit carries nothing;
//   - update_exercise by a resolved spelling: the receipt names the row written; a `name`
//     that only echoes the target spelling is never a rename; a real rename still goes
//     through renameExercise; a write with no group never restamps the group's source;
//   - Tidy's agent merges: bookkeeping keyed by the stored row (the both-well-trained guard
//     reads the stored rows' history even when the agent misspells them), a merge reached
//     only through the resolver is never auto-applied, and the agent's group lands only on
//     a row its cluster named.
// Deterministic, offline (a one-off agents.json answers with a fixed body).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, repo, isoDaysAgo } from "./_seed.js";
import { findExerciseExact, updateExerciseByName, upsertExercise } from "../dist/repo/exercises.js";
import { reconcileExercises } from "../dist/coachOps.js";

const STORED = "Dumbbell Biceps Curl";
const ALIAS = "DB Bicep Curl";

beforeEach(() => {
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok"], enrich_enabled: false });
});

const source = (id) => ({ ...db.prepare("SELECT muscle_group, muscle_group_source FROM exercises WHERE id = ?").get(id) });

function seedCurl() {
  const id = Number(
    db
      .prepare("INSERT INTO exercises (name, muscle_group, muscle_group_source, mode) VALUES (?, 'biceps', 'classifier', 'reps')")
      .run(STORED).lastInsertRowid
  );
  db.prepare(`INSERT INTO exercise_aliases (alias, canonical, source) VALUES ('db bicep curl', ?, 'auto')`).run(STORED);
  return id;
}

// ---------- 1. receipts ----------

test("upsert on a resolved spelling edits the stored row and names it, with resolved_from", () => {
  const id = seedCurl();
  const before = repo.listExercises().length;
  const out = upsertExercise({ name: ALIAS, muscle_group: "forearms" });
  assert.equal(out.id, id, "the stored lift was written, not a second row");
  assert.equal(out.name, STORED, "the receipt names the row actually written");
  assert.equal(out.resolved_from, ALIAS, "and says which spelling was sent");
  assert.equal(repo.listExercises().length, before, "no new row");
  assert.deepEqual(source(id), { muscle_group: "forearms", muscle_group_source: "user" }, "the supplied group is the person's");

  const exact = upsertExercise({ name: STORED.toLowerCase(), mode: "reps" });
  assert.equal(exact.id, id);
  assert.equal(exact.resolved_from, undefined, "an exact (case-insensitive) hit carries nothing extra");
});

test("a write that sets no group never restamps the group's source", () => {
  const id = seedCurl();
  upsertExercise({ name: ALIAS, mode: "reps" });
  assert.deepEqual(source(id), { muscle_group: "biceps", muscle_group_source: "classifier" });
  updateExerciseByName(ALIAS, { cues: "Slow lowering" });
  assert.deepEqual(source(id), { muscle_group: "biceps", muscle_group_source: "classifier" });
  updateExerciseByName(STORED, { constraint_note: "Neutral grip" });
  assert.deepEqual(source(id), { muscle_group: "biceps", muscle_group_source: "classifier" });
});

test("update by a resolved spelling: the receipt names the stored row, and the target is never a rename", () => {
  const id = seedCurl();
  const out = updateExerciseByName(ALIAS, { muscle_group: "biceps" });
  assert.equal(out.id, id);
  assert.equal(out.name, STORED);
  assert.equal(out.resolved_from, ALIAS);
  assert.equal(source(id).muscle_group_source, "user");

  // An app that echoes the target spelling back as `name` is not asking to retitle the
  // stored lift to its abbreviation.
  const echoed = updateExerciseByName(ALIAS, { name: ALIAS, cues: "Elbows still" });
  assert.equal(echoed.name, STORED, "the stored name is untouched");
  assert.equal(echoed.rename_ignored, ALIAS);
  assert.equal(findExerciseExact(STORED)?.id, id);
  assert.equal(findExerciseExact(STORED)?.cues, "Elbows still", "the rest of the edit landed");

  // A genuine rename still lands, through renameExercise (the old spelling keeps resolving).
  const renamed = updateExerciseByName(ALIAS, { name: "Seated Dumbbell Biceps Curl" });
  assert.equal(renamed.id, id);
  assert.equal(renamed.name, "Seated Dumbbell Biceps Curl");
  assert.equal(repo.findExercise(STORED)?.id, id, "the old stored spelling resolves through its alias");

  assert.equal(updateExerciseByName("Nothing Like It", { cues: "x" }), null, "a name that resolves to nothing is a miss");
});

test("a plan change naming the slot's lift by another spelling updates that slot, never adds a twin", async () => {
  const { applyPlanChange } = await import("../dist/repo/plan.js");
  const id = seedCurl();
  repo.savePlanDay(3, "Arms", "Arms", [
    { exercise: STORED, sets: 3, rep_low: 8, rep_high: 12, target_weight: 30 },
    { exercise: "Triceps Rope Pushdown", sets: 3, rep_low: 10, rep_high: 15, target_weight: 50 },
  ]);
  const out = applyPlanChange({ day_number: 3, exercise: ALIAS, sets: 4, reason: "One more set." });
  assert.equal(out.action, "updated", JSON.stringify(out));
  const rows = db
    .prepare(
      `SELECT pi.sets AS sets FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
        WHERE pd.day_number = 3 AND pi.exercise_id = ?`
    )
    .all(id);
  assert.equal(rows.length, 1, "one slot for the one lift");
  assert.equal(rows[0].sets, 4);
});

// ---------- 2. Tidy's agent pass ----------

function fakeAgent(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-tidy-agent-"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      tidy: {
        command: "sh",
        args: ["-c", `printf '%s' ${JSON.stringify(JSON.stringify(body))}`],
        input: "arg",
        description: "test double",
        env_required: [],
        capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      },
    })
  );
  return file;
}

async function tidyWith(body) {
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = fakeAgent(body);
  try {
    return await reconcileExercises("tidy", undefined, { authoritativeGroups: false });
  } finally {
    if (previous === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
  }
}

const insertEx = (name, group) =>
  Number(
    db
      .prepare("INSERT INTO exercises (name, muscle_group, muscle_group_source, mode) VALUES (?, ?, 'legacy', 'reps')")
      .run(name, group).lastInsertRowid
  );
function logDays(id, days) {
  for (let d = 0; d < days; d++) {
    const session = repo.getOrCreateSession(isoDaysAgo(d * 2 + 1));
    db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 50, 10)").run(
      session.id,
      id
    );
  }
}

test("an agent merge reached only through the resolver is offered, never auto-applied", async () => {
  const curl = seedCurl();
  const plain = insertEx("Dumbbell Curl", "biceps");
  logDays(curl, 3);
  logDays(plain, 2);
  const res = await tidyWith({
    groups: [],
    // "DB Bicep Curl" is not a stored name: the resolver points it at the stored curl. The
    // pair is structurally related and "high", which would have folded it on the spot.
    merges: [{ from: ALIAS, into: "Dumbbell Curl", confidence: "high", why: "same" }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.merged.length, 0, "nothing folded on a spelling the agent was not handed");
  assert.deepEqual(
    res.suggested.map((s) => [s.from, s.into]),
    [[STORED, "Dumbbell Curl"]],
    "offered for a yes, under the stored names"
  );
  assert.ok(findExerciseExact(STORED), "the curl row stands");
  assert.ok(findExerciseExact("Dumbbell Curl"), "the plain curl row stands");
});

test("the both-well-trained guard reads the STORED rows' history, whatever the agent spelled", async () => {
  const curl = seedCurl();
  const other = insertEx("Dumbbell Curl", "biceps");
  logDays(curl, 9);
  logDays(other, 9);
  const res = await tidyWith({
    groups: [],
    merges: [{ from: ALIAS, into: "dumbbell curl", confidence: "high", why: "same lift" }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.merged.length, 0);
  assert.equal(res.suggested.length, 0, "two independently trained lifts are not even suggested");
  const skip = res.skipped.find((s) => s.from === STORED);
  assert.ok(skip, `skipped under the stored name: ${JSON.stringify(res.skipped)}`);
  assert.match(skip.reason, /independent history/);
  assert.ok(findExerciseExact(STORED) && findExerciseExact("Dumbbell Curl"), "both rows stand");
});

test("an agent's group lands only on a row its cluster named", async () => {
  const curl = seedCurl();
  logDays(curl, 1);
  const stray = Number(
    db
      .prepare("INSERT INTO exercises (name, muscle_group, muscle_group_source, mode) VALUES ('Cable Fly', NULL, NULL, 'reps')")
      .run().lastInsertRowid
  );
  logDays(stray, 1);
  const res = await tidyWith({
    // The cluster's members are the curl; its canonical resolves to a DIFFERENT stored lift.
    groups: [{ members: [STORED], canonical: "Cable Fly", group: "forearms" }],
    merges: [],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(source(stray).muscle_group, "forearms", "a lift the cluster never named is not re-filed");
  // …and the agent "renaming" the curl to another stored lift's name never folded the two:
  // an agent's rename onto an existing row is held to the same merge guards as a merge.
  assert.ok(findExerciseExact(STORED), "the curl row stands");
  assert.ok(findExerciseExact("Cable Fly"), "the fly row stands");
});

test("an agent rename onto another stored lift is a merge, and passes the merge guards first", async () => {
  const { renameExercise } = await import("../dist/repo/exercises.js");
  const curl = seedCurl();
  const fly = insertEx("Cable Fly", "chest");
  logDays(curl, 2);
  logDays(fly, 2);
  const refused = renameExercise(curl, "Cable Fly", { source: "agent" });
  assert.equal(refused.ok, false);
  assert.equal(refused.outcome, "rejected", "different lifts: never folded on an agent's word");
  assert.ok(findExerciseExact(STORED) && findExerciseExact("Cable Fly"));

  // A pair that only shares a muscle group waits for a person's yes instead.
  const hammer = insertEx("Hammer Curl", "biceps");
  logDays(hammer, 1);
  const parked = renameExercise(hammer, STORED, { source: "agent" });
  assert.equal(parked.outcome, "suggested");
  assert.equal(findExerciseExact("Hammer Curl")?.suggested_name, STORED);
  assert.ok(findExerciseExact("Hammer Curl"), "nothing merged yet");

  // A person's word still folds it.
  const merged = renameExercise(hammer, STORED, { source: "person" });
  assert.equal(merged.outcome, "merged");
  assert.equal(findExerciseExact("Hammer Curl"), undefined);
});

test("an agent never makes a display name LESS canonical; a fuller spelling still lands", async () => {
  const { renameExercise } = await import("../dist/repo/exercises.js");
  const curl = seedCurl();
  logDays(curl, 2);
  // The alias table's canonical side wins.
  const back = renameExercise(curl, ALIAS, { source: "agent" });
  assert.equal(back.outcome, "unchanged");
  assert.equal(findExerciseExact(STORED)?.id, curl, "the stored name stands");

  // An abbreviated spelling with no alias row is the same step backwards.
  const press = insertEx("Incline Dumbbell Press", "chest");
  logDays(press, 2);
  assert.equal(renameExercise(press, "Incline DB Press", { source: "agent" }).outcome, "unchanged");
  assert.ok(findExerciseExact("Incline Dumbbell Press"));

  // The other direction is a cleanup and lands.
  const row = insertEx("Seated DB Shoulder Press", "shoulders");
  logDays(row, 2);
  const forward = renameExercise(row, "Seated Dumbbell Shoulder Press", { source: "agent" });
  assert.equal(forward.outcome, "renamed", JSON.stringify(forward));
  assert.equal(findExerciseExact("Seated Dumbbell Shoulder Press")?.id, row);
});

test("Tidy reads each row's OWN logged days, even for a row it renamed earlier in the pass", async () => {
  const curl = seedCurl();
  const plain = insertEx("Dumbbell Curl", "biceps");
  logDays(curl, 9);
  logDays(plain, 9);
  const res = await tidyWith({
    // The station-word respelling lands first, so "Dumbbell Curl" is no longer a stored name.
    groups: [{ members: ["Dumbbell Curl"], canonical: "Dumbbell Curl Machine", group: "biceps" }],
    merges: [{ from: "Dumbbell Curl", into: STORED, confidence: "high", why: "same" }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.renamed.map((r) => r.into), ["Dumbbell Curl Machine"], JSON.stringify(res));
  assert.equal(res.merged.length, 0);
  assert.equal(res.suggested.length, 0, "two independently trained lifts are not even offered");
  assert.ok(res.skipped.some((s) => /independent history/.test(s.reason)), JSON.stringify(res.skipped));
});
