// Request-path waits and wasted work: a read that writes nothing, a chat capture that
// answers before its bookkeeping, a stale how-to served at once, a Garmin pass that
// does not refetch what a finished activity already holds.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";
import { latestMeasuredRmr } from "../dist/repo/metabolism.js";
import { completeInstantFoodCapture } from "../dist/chatTurns.js";
import { classifyChatRoute } from "../dist/chatRouting.js";
import { explainExercise } from "../dist/coachOps.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "food_notes", "ai_cache", "exercises", "garmin_activities", "day_reads");
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

function recordSql(fn) {
  const seen = [];
  const real = db.prepare.bind(db);
  db.prepare = (sql) => {
    seen.push(String(sql));
    return real(sql);
  };
  try {
    fn();
  } finally {
    db.prepare = real;
  }
  return seen;
}

test("a measured-RMR read with nothing to clear issues no profile write", () => {
  const sql = recordSql(() => latestMeasuredRmr());
  assert.equal(sql.filter((s) => /UPDATE\s+profile/i.test(s)).length, 0);
});

test("an instant chat food capture hands back its turn before the day-read bookkeeping runs", async () => {
  const today = localDaysAgo(0);
  const baseline = repo.dayRead(today);
  repo.saveDayRead(today, {
    ...baseline,
    headline: "Warm.",
    why: "Written by the coach.",
    source: "agent",
    agent: "claude",
    override: null,
  });
  assert.ok(repo.getCachedDayRead(today), "precondition: a warm read is cached");

  const raw = "Log turkey and rice for lunch";
  const routing = classifyChatRoute({ message: raw, has_image: false });
  const user = repo.addChatMessage("user", raw);
  const turn = repo.createChatTurn({ message: raw, routing, user_message_id: user.id });
  const done = completeInstantFoodCapture(turn.id, raw);

  assert.equal(done.turn.status, "done");
  assert.equal(repo.listFoodNotes(10).length, 1);
  assert.ok(repo.getCachedDayRead(today), "invalidation has not run inside the request");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(repo.getCachedDayRead(today), null, "it ran right after, and the read is still invalidated");
});

test("a stored Garmin activity reports which per-activity fetches it already holds", () => {
  assert.equal(repo.garminStoredFetchState("nope"), null);
  repo.upsertGarminActivity(
    {
      external_id: "g-held",
      date: "2026-01-01",
      type: "running",
      training_load: 80,
      hr_zones: [{ zone: 1, secs: 10, low_hr: 100 }],
    },
    null
  );
  repo.upsertGarminActivity({ external_id: "g-bare", date: "2026-01-01", type: "running" }, null);
  const held = repo.garminStoredFetchState("g-held");
  assert.deepEqual(held, { detail: true, zones: true, sets: false });
  const bare = repo.garminStoredFetchState("g-bare");
  assert.deepEqual(bare, { detail: false, zones: false, sets: false });
});

test("a stale how-to is served at once while the rewrite runs off the request", async () => {
  const ex = repo.upsertExercise({ name: "Bulgarian Split Squat", muscle_group: "legs" });
  const explanation = {
    setup: "Front foot far enough forward to stay balanced.",
    move: "Lower smoothly, then drive through the front midfoot.",
    feel: "Front-leg quad and glute.",
  };
  repo.saveAiCache("exercise_explanation", "legacy-key", {
    result: { ok: true, exercise: ex.name, explanation },
    chosen_agent: "stub",
    ref_table: "exercises",
    ref_id: ex.id,
    freshForMs: 60_000,
  });
  const out = await explainExercise("stub", ex.name, undefined, { serveStale: true });
  assert.equal(out.ok, true);
  assert.equal(out.stale, true);
  assert.equal(out.cached, true);
  assert.deepEqual(out.explanation, explanation);
  // Let the background rewrite settle so it cannot land in the next test.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (db.prepare(`SELECT COUNT(*) AS n FROM ai_cache WHERE kind='exercise_explanation'`).get().n > 1) break;
  }
});
