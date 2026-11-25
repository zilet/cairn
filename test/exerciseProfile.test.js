// The agent's exercise profile (src/repo/exercise-profile.ts): what a lift IS, filled by an agent
// where the curated tables answer nothing, and nowhere else.
//
// The order of authority is a person's own value, then the curated tables, then the profile,
// then the name classifier. These tests pin the three halves of that promise:
//   - FILL: a lift no table knows gets a pattern, a region and synergists, and the three
//     classifiers (classifyPattern, movementRegionKey, muscleCreditFor) then answer for it;
//   - NEVER OVERRIDE: where a curated table has an answer the profile cannot move it, a
//     person's stored group is never moved, and a disagreement is exposed on the detail read;
//   - THE BACKFILL: one serial job per lift on the existing enrichment queue, idempotent,
//     deferring on agent congestion, doing nothing without an agent, re-armed by a version bump.
//
// The "agents" are node scripts that read the prompt on stdin, log each spawn, and answer the
// way a profiling model would (the AGENTS_CONFIG pattern of test/dayReadRepair.test.js).
// Every lift name here is invented or a plain gym movement; nothing is athlete data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-exercise-profile-"));
const spawnLog = path.join(dir, "spawns.ndjson");
const script = path.join(dir, "agent.cjs");
fs.writeFileSync(
  script,
  `const fs = require("fs");
const [log, mode] = process.argv.slice(2);
const PROFILES = {
  "zzq gizmo drive": { pattern: "horizontal-push", region: "horizontal-press:incline", primary_group: "chest",
    secondary: [{ group: "triceps", share: 0.5 }, { group: "shoulders", share: 0.25 }],
    length_bias: "lengthened", compound: true, confidence: "high" },
  "zzq bad vocab": { pattern: "wobble", region: "nowhere", primary_group: "elbows",
    secondary: [{ group: "triceps", share: 0.5 }, { group: "hands", share: 0.5 }, { group: "biceps", share: 0.7 }],
    length_bias: "sideways", compound: "maybe", confidence: "high" },
  "close-grip bench press": { pattern: "horizontal-push", region: "horizontal-press:flat", primary_group: "chest",
    secondary: [{ group: "forearms", share: 0.5 }], length_bias: "mid", compound: true, confidence: "high" },
  "zzq ambiguous move": { pattern: null, region: null, primary_group: null, secondary: [], confidence: "low" },
};
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const named = /\\nEXERCISE:\\n(\\{[^\\n]*\\})/.exec(input);
  let name = "";
  try { name = String(JSON.parse(named[1]).name || ""); } catch {}
  const kind = input.includes("GARMIN_CANDIDATES") ? "enrich" : input.includes("PROFILE (what this lift IS") ? "profile" : "other";
  fs.appendFileSync(log, JSON.stringify({ mode, kind, name }) + "\\n");
  if (mode === "bad") { process.stdout.write("this is not json at all"); return; }
  if (mode === "slow") { setTimeout(() => process.stdout.write("{}"), 2500); return; }
  const profile = PROFILES[name.toLowerCase()] || { pattern: null, region: null, primary_group: null, secondary: [], confidence: "low" };
  if (kind === "enrich") process.stdout.write(JSON.stringify({ canonical: name, mode: "reps", profile }));
  else if (kind === "profile") process.stdout.write(JSON.stringify(profile));
  else process.stdout.write("{}");
});
`
);
const agent = (mode) => ({ command: "node", args: [script, spawnLog, mode], input: "stdin" });
const cfg = path.join(dir, "agents.json");
fs.writeFileSync(
  cfg,
  JSON.stringify({ profiler: agent("profiler"), slow: agent("slow"), bad: agent("bad"), bad2: agent("bad") }),
);
process.env.AGENTS_CONFIG = cfg;

const { db, repo } = await import("./_seed.js");
const profileMod = await import("../dist/repo/exercise-profile.js");
const { classifyPattern, classifyPatternCurated, MOVEMENT_PATTERNS } = await import("../dist/repo/exercise-variations.js");
const { movementRegionKey, movementRegionKeyCurated, MOVEMENT_REGIONS } = await import("../dist/repo/movement-region.js");
const { HALF_SHARE, TOUCHED_SHARE, muscleCreditFor, primaryMuscleGroup } = await import("../dist/repo/muscle-credit.js");
const { classifyMuscleGroup } = await import("../dist/repo/exercise-canon.js");
const enrich = await import("../dist/enrich.js");
const { getExerciseDetail, recheckExerciseGroups, getExercise } = await import("../dist/repo/exercises.js");
const { runAgent } = await import("../dist/agents.js");
const { AgentBusyError, isAgentBusyError } = await import("../dist/agent-busy.js");
const contracts = await import("../dist/agent-contracts.js");

const {
  EXERCISE_PROFILE_RULES_VERSION,
  exerciseIdsNeedingProfile,
  exerciseProfileFor,
  getExerciseProfile,
  sanitizeExerciseProfile,
  writeExerciseProfile,
} = profileMod;

const spawns = () =>
  fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

beforeEach(() => {
  fs.rmSync(spawnLog, { force: true });
  repo.setSettings({ enrich_enabled: true, disabled_agents: ["slow", "bad", "bad2"] });
});

const UNKNOWN = "Zzq Gizmo Drive"; // no table in the repo knows this lift
const GOOD = {
  pattern: "horizontal-push",
  region: "horizontal-press:incline",
  primary_group: "chest",
  secondary: [
    { group: "triceps", share: 0.5 },
    { group: "shoulders", share: 0.25 },
  ],
  length_bias: "lengthened",
  compound: true,
  confidence: "high",
};

function lift(name, group) {
  const row = group === undefined ? repo.findOrCreateExercise(name) : repo.upsertExercise({ name, muscle_group: group });
  return Number(row.id);
}

// One logged set on `date`, straight into the tables (the backfill's scope reads them).
function logRaw(id, date = "2026-07-01") {
  const session = db.prepare("INSERT INTO sessions (date) VALUES (?)").run(date);
  db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 50, 8)").run(
    Number(session.lastInsertRowid),
    id,
  );
}

// A lift the athlete trains: it has a logged set, so the backfill considers it.
function trained(name, group, date) {
  const id = lift(name, group);
  logRaw(id, date);
  return id;
}

function planRaw(id) {
  const day = db.prepare("INSERT INTO plan_days (day_number, name) VALUES ((SELECT COALESCE(MAX(day_number), 0) + 1 FROM plan_days), 'Fixture')").run();
  db.prepare("INSERT INTO plan_items (plan_day_id, position, exercise_id, sets) VALUES (?, 1, ?, 3)").run(Number(day.lastInsertRowid), id);
}

test("the fixture lift is unknown to every table (the premise of the fill tests)", () => {
  assert.equal(classifyMuscleGroup(UNKNOWN), null);
  assert.equal(classifyPatternCurated(UNKNOWN), null);
  assert.equal(movementRegionKeyCurated(UNKNOWN), null);
  assert.deepEqual(muscleCreditFor(UNKNOWN, null), []);
});

// ---- vocabulary ----------------------------------------------------------------------

test("an agent's out-of-vocabulary values are dropped field by field, never invented", () => {
  const clean = sanitizeExerciseProfile({
    pattern: "wobble",
    region: "nowhere",
    primary_group: "elbows",
    secondary: [
      { group: "triceps", share: 0.5 },
      { group: "hands", share: 0.5 }, // not a group
      { group: "biceps", share: 0.7 }, // not a share the credit model has
    ],
    length_bias: "sideways",
    compound: "maybe",
    confidence: "certain",
  });
  assert.equal(clean.pattern, null);
  assert.equal(clean.region, null);
  assert.equal(clean.primary_group, null);
  assert.deepEqual(clean.secondary, [{ group: "triceps", share: 0.5 }]);
  assert.equal(clean.length_bias, null);
  assert.equal(clean.compound, null);
  assert.equal(clean.confidence, "low", "an unreadable confidence is the one that is never applied");

  const valid = sanitizeExerciseProfile({ ...GOOD, region: " Horizontal-Press:Incline ", primary_group: "Lats" });
  assert.equal(valid.region, "horizontal-press:incline", "spelling is folded, the value is checked");
  assert.equal(valid.primary_group, "back", "a group alias folds onto the canonical taxonomy");

  const withPrimary = sanitizeExerciseProfile({ primary_group: "chest", secondary: [{ group: "chest", share: 0.5 }] });
  assert.deepEqual(withPrimary.secondary, [], "the primary is never its own synergist");
});

test("a profile with nothing usable is stored as low and never applied", () => {
  const id = lift("Zzq Bad Vocab");
  writeExerciseProfile(id, { pattern: "wobble", region: "nowhere", primary_group: "elbows", confidence: "high" });
  const row = getExerciseProfile(id);
  assert.equal(row.confidence, "low", "a profile that says nothing in-vocabulary cannot claim confidence");
  assert.equal(classifyPattern("Zzq Bad Vocab", undefined, { profile: true }), null);
  assert.deepEqual(muscleCreditFor("Zzq Bad Vocab", null), []);
});

test("every answer the curated region rules give is in the region vocabulary", () => {
  const names = [
    "Flat Barbell Bench Press", "Incline Dumbbell Press", "Decline Bench Press", "Overhead Press", "Arnold Press",
    "Weighted Dips", "Leg Extension", "Lying Leg Curl", "Standing Calf Raise", "Seated Calf Raise", "Barbell Curl",
    "Hammer Curl", "Reverse Curl", "Cable Pushdown", "Skull Crusher", "Overhead Triceps Extension", "Triceps Kickback",
    "Lateral Raise", "Face Pull", "Reverse Pec Deck", "Triceps Extension",
  ];
  let seen = 0;
  for (const name of names) {
    const region = movementRegionKeyCurated(name);
    if (!region) continue;
    seen++;
    assert.ok(MOVEMENT_REGIONS.includes(region), `${name} -> ${region} must be in the vocabulary`);
  }
  assert.ok(seen >= 15, `the sample exercised the rules (${seen})`);
  for (const pattern of ["horizontal-push", "curl", "mobility", "rear-delt"]) assert.ok(MOVEMENT_PATTERNS.includes(pattern));
});

test("the profile's two shares are the credit model's counted and touched shares", () => {
  assert.deepEqual([...profileMod.PROFILE_SHARES], [HALF_SHARE, TOUCHED_SHARE]);
});

// ---- the fill ------------------------------------------------------------------------

test("a profile fills a lift the tables do not know: pattern, region and synergists", () => {
  const id = lift(UNKNOWN);
  // Before: nothing answers, and the credit read is cached under that answer.
  assert.deepEqual(muscleCreditFor(UNKNOWN, null), []);
  assert.equal(classifyPattern(UNKNOWN, undefined, { profile: true }), null);

  const written = writeExerciseProfile(id, GOOD, { source: "agent", agent: "profiler" });
  assert.equal(written.written, true);

  assert.equal(classifyPattern(UNKNOWN, undefined, { profile: true }), "horizontal-push");
  assert.equal(movementRegionKey(UNKNOWN, null, { profile: true }), "horizontal-press:incline");
  assert.deepEqual(
    muscleCreditFor(UNKNOWN, null).map((c) => [c.group, c.share, c.role]),
    [
      ["chest", 1, "primary"],
      ["triceps", 0.5, "secondary"],
      ["shoulders", 0.25, "secondary"],
    ],
    "the credit read answers for the lift, and the cache that held the old answer was dropped",
  );
  assert.equal(primaryMuscleGroup(UNKNOWN, null), "chest");
  // A spelling that resolves onto the lift reads its profile too.
  assert.equal(exerciseProfileFor("zzq  gizmo drive")?.exercise_id, id);
});

test("pattern and region stay curated-only unless a progress read opts in (nothing on today's card moves)", () => {
  const id = lift(UNKNOWN);
  writeExerciseProfile(id, GOOD, { source: "agent", agent: "profiler" });
  // The default call is what reach hosts, supersets, region de-duplication, plan ordering and
  // hold progression make: a newly filled value must not reshape a card.
  assert.equal(classifyPattern(UNKNOWN), null);
  assert.equal(classifyPattern(UNKNOWN, "chest"), "horizontal-push", "the stored-group hint is the curated tier and still answers");
  assert.equal(movementRegionKey(UNKNOWN), null);
  assert.equal(movementRegionKey(UNKNOWN, null), null);
});

test("a low-confidence profile is stored but never applied", () => {
  const id = lift(UNKNOWN);
  writeExerciseProfile(id, { ...GOOD, confidence: "low" });
  assert.equal(getExerciseProfile(id).confidence, "low");
  assert.equal(classifyPattern(UNKNOWN, undefined, { profile: true }), null);
  assert.equal(movementRegionKey(UNKNOWN, null, { profile: true }), null);
  assert.deepEqual(muscleCreditFor(UNKNOWN, null), []);
});

// ---- never override ------------------------------------------------------------------

test("where a curated table has an answer the profile cannot move it, and the detail read says so", () => {
  const name = "Barbell Bench Press";
  const id = lift(name);
  const before = {
    pattern: classifyPattern(name),
    patternWithProfile: classifyPattern(name, undefined, { profile: true }),
    region: movementRegionKey(name, null, { profile: true }),
    credit: muscleCreditFor(name, getExercise(id).muscle_group),
  };
  assert.equal(before.pattern, "horizontal-push");
  assert.equal(before.region, "horizontal-press:flat");
  assert.equal(getExerciseDetail(name).profile, null, "before the first read the detail carries no profile");

  writeExerciseProfile(id, {
    pattern: "vertical-push",
    region: "vertical-press",
    primary_group: "shoulders",
    secondary: [{ group: "biceps", share: 0.5 }],
    confidence: "high",
  });

  assert.equal(classifyPattern(name), before.pattern);
  assert.equal(classifyPattern(name, undefined, { profile: true }), before.patternWithProfile, "the curated pattern wins even when the progress read opts in");
  assert.equal(movementRegionKey(name, null, { profile: true }), before.region, "and so does the curated region");
  assert.deepEqual(muscleCreditFor(name, getExercise(id).muscle_group), before.credit, "the curated credit is untouched");

  const detail = getExerciseDetail(name);
  assert.equal(detail.profile.pattern, "vertical-push", "the row is stored as the agent said it");
  assert.equal(detail.profile.disagrees_with_curated, true);
  for (const field of ["pattern", "region", "secondary"]) {
    assert.ok(detail.profile.disagreements.includes(field), `${field} in ${detail.profile.disagreements}`);
  }
  assert.equal(detail.profile.source, "agent");
  assert.equal(detail.profile.rules_version, EXERCISE_PROFILE_RULES_VERSION);
});

test("a profile that fills a gap is not a disagreement", () => {
  const id = lift(UNKNOWN);
  writeExerciseProfile(id, GOOD);
  const detail = getExerciseDetail(UNKNOWN);
  assert.equal(detail.profile.disagrees_with_curated, false);
  assert.deepEqual(detail.profile.disagreements, []);
});

test("a person's group is never moved by a profile, a credit read or the group re-check", () => {
  const name = "Close-Grip Bench Press";
  const id = lift(name, "forearms"); // the person's own filing (muscle_group_source = user)
  assert.equal(getExercise(id).muscle_group_source, "user");
  writeExerciseProfile(id, { primary_group: "triceps", pattern: "triceps", confidence: "high" });

  assert.equal(getExercise(id).muscle_group, "forearms");
  assert.equal(primaryMuscleGroup(name, "forearms"), "forearms", "the stored group is the primary, whatever the profile says");
  recheckExerciseGroups();
  assert.equal(getExercise(id).muscle_group, "forearms");
  assert.equal(getExercise(id).muscle_group_source, "user");
  assert.equal(getExerciseDetail(name).profile.stored_group_differs, true, "the mismatch is shown on the pull read, not acted on");
});

test("an agent never overwrites a person's profile row", () => {
  const id = lift(UNKNOWN);
  writeExerciseProfile(id, { ...GOOD, primary_group: "chest" }, { source: "user" });
  const attempt = writeExerciseProfile(id, { ...GOOD, primary_group: "back" }, { source: "agent", agent: "profiler" });
  assert.equal(attempt.written, false);
  assert.equal(getExerciseProfile(id).primary_group, "chest");
  assert.equal(getExerciseProfile(id).source, "user");
  assert.equal(exerciseIdsNeedingProfile(EXERCISE_PROFILE_RULES_VERSION + 1).includes(id), false, "nothing re-asks over a person's row");
});

test("a profile leaves with its lift", () => {
  const id = lift(UNKNOWN);
  writeExerciseProfile(id, GOOD);
  db.prepare("DELETE FROM exercises WHERE id = ?").run(id);
  assert.equal(getExerciseProfile(id), null, "ON DELETE CASCADE");
});

// ---- the one 'exercise' call returns the profile too ---------------------------------

test("the 'exercise' enrichment lands the profile from the same call, and the fill-only group rule decides the group", async () => {
  const id = lift(UNKNOWN); // no group, no classifier answer
  assert.equal(getExercise(id).muscle_group, null);
  await enrich.processExerciseJob(id);
  const calls = spawns().filter((s) => s.kind === "enrich");
  assert.equal(calls.length, 1, "one agent call per lift classifies it AND profiles it");
  const profile = getExerciseProfile(id);
  assert.equal(profile.pattern, "horizontal-push");
  assert.equal(profile.agent, "profiler");
  assert.equal(getExercise(id).muscle_group, "chest", "a high-confidence primary offered to the existing fill-only group rule fills an empty group");
  assert.equal(getExercise(id).muscle_group_source, "agent");
});

test("the 'exercise' enrichment never moves a person's group", async () => {
  const name = "Close-Grip Bench Press";
  const id = lift(name, "forearms");
  await enrich.processExerciseJob(id);
  assert.equal(getExercise(id).muscle_group, "forearms");
  assert.equal(getExercise(id).muscle_group_source, "user");
  assert.ok(getExerciseProfile(id), "the profile is still stored");
});

// ---- the backfill --------------------------------------------------------------------

test("the backfill profiles every lift once, serially, and a second boot asks nothing", async () => {
  const a = trained(UNKNOWN);
  const b = trained("Close-Grip Bench Press");
  const c = trained("Zzq Ambiguous Move");
  assert.deepEqual(exerciseIdsNeedingProfile().sort((x, y) => x - y), [a, b, c].sort((x, y) => x - y));

  assert.equal(enrich.enqueueExerciseProfileBackfill(), 3);
  await enrich.whenEnrichQueueIdle();
  const first = spawns();
  assert.equal(first.length, 3, "one agent call per lift");
  assert.ok(first.every((s) => s.kind === "profile"), "the backfill asks for the profile alone");
  for (const id of [a, b, c]) assert.ok(getExerciseProfile(id), `lift ${id} has a row`);
  assert.equal(getExerciseProfile(c).confidence, "low", "an unanswerable lift is settled, not retried forever");
  assert.equal(getExercise(a).muscle_group, null, "the backfill changes nothing but the profile (no regroup)");
  assert.equal(getExercise(a).name, UNKNOWN, "and renames nothing");

  fs.rmSync(spawnLog, { force: true });
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 0, "idempotent: nothing is lacking");
  await enrich.whenEnrichQueueIdle();
  assert.equal(spawns().length, 0, "and no agent was spawned");
});

test("the backfill resumes where it stopped: only the lifts without a row are asked", async () => {
  const a = trained(UNKNOWN);
  const b = trained("Close-Grip Bench Press");
  writeExerciseProfile(a, GOOD, { source: "agent", agent: "profiler" });
  assert.deepEqual(exerciseIdsNeedingProfile(), [b]);
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 1);
  await enrich.whenEnrichQueueIdle();
  assert.deepEqual(spawns().map((s) => s.name), ["Close-Grip Bench Press"]);
});

test("a bumped rules version re-arms the backfill", async () => {
  const id = trained(UNKNOWN);
  writeExerciseProfile(id, GOOD, { source: "agent", agent: "profiler", rulesVersion: EXERCISE_PROFILE_RULES_VERSION - 1 });
  assert.deepEqual(exerciseIdsNeedingProfile(), [id], "a row from older rules is listed again");
  assert.deepEqual(exerciseIdsNeedingProfile(EXERCISE_PROFILE_RULES_VERSION + 1), [id], "and so is every row once the version moves past it");

  assert.equal(enrich.enqueueExerciseProfileBackfill(), 1);
  await enrich.whenEnrichQueueIdle();
  assert.equal(getExerciseProfile(id).rules_version, EXERCISE_PROFILE_RULES_VERSION);
  assert.deepEqual(exerciseIdsNeedingProfile(), []);
});

test("with no agent the backfill does nothing and nothing else changes", async () => {
  const id = lift(UNKNOWN);
  repo.setSettings({ disabled_agents: ["profiler", "slow", "bad", "bad2"] });
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 0);
  await enrich.processExerciseProfileJob(id); // a job that was already queued is a quiet no-op too
  await enrich.whenEnrichQueueIdle();
  assert.equal(getExerciseProfile(id), null);
  assert.equal(spawns().length, 0);

  repo.setSettings({ enrich_enabled: false, disabled_agents: ["slow", "bad", "bad2"] });
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 0, "enrichment off queues nothing either");
});

test("agent congestion defers the job: nothing is written, nothing failed, no other agent tried", async () => {
  const id = lift(UNKNOWN);
  const prior = process.env.CAIRN_MAX_AGENT_PROCS;
  process.env.CAIRN_MAX_AGENT_PROCS = "1";
  try {
    // One background run holds the only permit for ~2.5 s.
    const holder = runAgent("slow", "hold the permit", { timeoutMs: 15_000 });
    await new Promise((r) => setTimeout(r, 400));
    await assert.rejects(
      () => enrich.processExerciseProfileJob(id, { timeoutMs: 150 }),
      (e) => {
        assert.ok(isAgentBusyError(e), "the job throws the typed busy error for the drain to defer on");
        return true;
      },
    );
    assert.equal(getExerciseProfile(id), null, "a deferred lift is not classified blind");
    assert.equal(spawns().filter((s) => s.mode === "profiler").length, 0, "the profiling agent was never spawned or rotated to");
    await holder;
  } finally {
    if (prior === undefined) delete process.env.CAIRN_MAX_AGENT_PROCS;
    else process.env.CAIRN_MAX_AGENT_PROCS = prior;
  }
  assert.equal(
    enrich.enrichFailureAction({ kind: "exercise_profile", id }, new AgentBusyError("profiler", 150)),
    "defer",
    "the drain's policy for this kind is defer, not fail",
  );
});

// ---- scope, pacing and manners of the backfill ---------------------------------------

test("only lifts on the plan or with a logged set are queued: the plan first, then the most recently trained", () => {
  const never = lift("Zzq Never Logged"); // a seeded row nobody trains
  const old = trained("Zzq Old Lift", undefined, "2026-06-01");
  const recent = trained("Zzq Recent Lift", undefined, "2026-11-01");
  const planned = lift("Zzq Planned Lift");
  planRaw(planned);
  const placeholder = Number(db.prepare("INSERT INTO exercises (name) VALUES ('Unknown')").run().lastInsertRowid);
  logRaw(placeholder, "2026-11-20"); // a legacy placeholder with sets: still not a movement

  const ids = exerciseIdsNeedingProfile();
  assert.deepEqual(ids, [planned, recent, old], "plan first, then newest training; never-logged and placeholder rows are not queued");
  assert.ok(!ids.includes(never) && !ids.includes(placeholder));
  assert.deepEqual(exerciseIdsNeedingProfile(undefined, 2), [planned, recent], "the limit takes the head of that order");
});

test("a placeholder-named exercise never gets a profile", () => {
  const placeholder = Number(db.prepare("INSERT INTO exercises (name) VALUES ('Unknown')").run().lastInsertRowid);
  const attempt = writeExerciseProfile(placeholder, GOOD, { source: "agent", agent: "profiler" });
  assert.equal(attempt.written, false);
  assert.equal(getExerciseProfile(placeholder), null);
  assert.equal(writeExerciseProfile(placeholder, GOOD, { source: "user" }).written, false, "not even a person's");
  assert.deepEqual(muscleCreditFor("Unknown", null), [], "so its legacy sets credit nothing new");
});

test("one boot queues at most 12 lifts; the next boot takes the rest", async () => {
  assert.equal(enrich.EXERCISE_PROFILE_BACKFILL_PER_BOOT, 12);
  for (let i = 1; i <= 14; i++) trained(`Zzq Cap Lift ${String(i).padStart(2, "0")}`, undefined, `2026-07-${String(i).padStart(2, "0")}`);
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 12);
  await enrich.whenEnrichQueueIdle();
  assert.equal(spawns().length, 12);
  assert.equal(exerciseIdsNeedingProfile().length, 2, "the two oldest wait for a later boot");
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 2);
  await enrich.whenEnrichQueueIdle();
  assert.equal(spawns().length, 14);
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 0);
});

test("other work queued during a backfill runs ahead of the remaining profile jobs", async () => {
  for (let i = 1; i <= 5; i++) trained(`Zzq Wait Lift ${i}`, undefined, `2026-07-0${i}`);
  const fresh = lift("Zzq Gizmo Drive"); // a new lift's enrichment (its own agent call, tagged 'enrich')
  assert.equal(enrich.enqueueExerciseProfileBackfill(), 5);
  // The drain has taken the first profile job; four wait. A new lift's enrichment arrives now.
  enrich.enqueueEnrich("exercise", fresh);
  const pending = enrich.pendingEnrichJobsForTests();
  assert.equal(pending[0].kind, "exercise", "it is ahead of every waiting profile job");
  assert.ok(pending.slice(1).every((job) => job.kind === "exercise_profile"));
  // The review refresh and other non-profile kinds keep their place ahead of the profile jobs too.
  enrich.enqueueEnrich("garmin_export", 999_999);
  assert.deepEqual(
    enrich.pendingEnrichJobsForTests().map((j) => j.kind).filter((k) => k !== "exercise_profile"),
    ["exercise", "garmin_export"],
    "FIFO among the non-profile jobs",
  );
  assert.equal(enrich.pendingEnrichJobsForTests().at(-1).kind, "exercise_profile");
  await enrich.whenEnrichQueueIdle();
  const kinds = spawns().map((s) => s.kind).filter((k) => k !== "other");
  assert.equal(kinds[0], "profile", "the job already running finished first");
  assert.equal(kinds[1], "enrich", "then the new lift, before any remaining profile job");
  assert.equal(kinds.filter((k) => k === "profile").length, 5);
});

test("a profile job makes ONE attempt with the picked agent: no rotation, no repair re-spawn", async () => {
  const id = trained(UNKNOWN);
  repo.setSettings({ disabled_agents: ["profiler", "slow"] }); // bad and bad2 both usable, both answer garbage
  await enrich.processExerciseProfileJob(id);
  const profileSpawns = spawns().filter((s) => s.kind === "profile");
  assert.equal(profileSpawns.length, 1, `one spawn, not a rotation over two agents or a JSON repair: ${JSON.stringify(profileSpawns)}`);
  assert.equal(getExerciseProfile(id), null, "a failure leaves the lift for a later boot");
  assert.deepEqual(exerciseIdsNeedingProfile(), [id]);
});

// ---- the contract --------------------------------------------------------------------

test("the structured-output schemas name every field the profile writer reads", () => {
  const named = (schema, trail = "") => {
    const out = [];
    if (!schema || typeof schema !== "object") return out;
    if (schema.items) out.push(...named(schema.items, trail ? `${trail}[]` : "[]"));
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      const p = trail ? `${trail}.${key}` : key;
      out.push(p, ...named(sub, p));
    }
    return out;
  };
  const read = ["pattern", "region", "primary_group", "secondary", "secondary[].group", "secondary[].share", "length_bias", "compound", "confidence"];
  const profileOnly = new Set(named(contracts.EXERCISE_PROFILE_SCHEMA));
  const enrichSchema = new Set(named(contracts.EXERCISE_ENRICH_SCHEMA));
  for (const field of read) {
    assert.ok(profileOnly.has(field), `EXERCISE_PROFILE_SCHEMA must name ${field}`);
    assert.ok(enrichSchema.has(`profile.${field}`), `EXERCISE_ENRICH_SCHEMA must name profile.${field}`);
  }
});

test("the profile prompt offers exactly the engine's vocabularies", async () => {
  const { buildExerciseProfilePrompt, buildExerciseEnrichPrompt } = await import("../dist/prompt/program.js");
  for (const prompt of [buildExerciseProfilePrompt({ name: UNKNOWN }), buildExerciseEnrichPrompt({ name: UNKNOWN })]) {
    for (const pattern of MOVEMENT_PATTERNS) assert.ok(prompt.includes(pattern), `prompt lists pattern ${pattern}`);
    for (const region of MOVEMENT_REGIONS) assert.ok(prompt.includes(region), `prompt lists region ${region}`);
    assert.ok(prompt.includes("OUTPUT CONTRACT"));
    assert.ok(prompt.includes(UNKNOWN), "the lift's own facts ride along");
  }
});

test("the profile prompt never carries the lift's constraint note (it can hold pain or injury text)", async () => {
  const { buildExerciseProfilePrompt } = await import("../dist/prompt/program.js");
  const prompt = buildExerciseProfilePrompt({
    name: UNKNOWN,
    muscle_group: "chest",
    equipment: "a barbell",
    constraint_note: "left shoulder pinches after the surgery",
  });
  assert.ok(!prompt.includes("pinches"), "the note text is not sent");
  assert.ok(!prompt.includes("constraint_note"), "nor its key");
  assert.ok(prompt.includes("a barbell") && prompt.includes("chest"), "the mechanics' own facts still are");
});
