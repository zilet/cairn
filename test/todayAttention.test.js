// The Today LEAD arbitration (src/domain/brain/today-attention.ts): which ONE
// surface earns the position of prominence today. Deterministic, additive, and
// score-free — the internal ranking must never reach the client.
import assert from "node:assert/strict";
import test from "node:test";
import { decideTodayAttention, briefState } from "../dist/domain/brain/today-attention.js";
import { readToday } from "../dist/domain/brain/day-read-use-case.js";
import { configureDayReadRefresh } from "../dist/dayread-refresh.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const TABLES = ["insights", "sessions", "logged_sets", "day_reads", "suggestions", "plan_days", "plan_items"];

// A quiet read that is literally yesterday's conclusion reached by yesterday's
// route — the case this whole feature exists for.
function repeatRead(extra = {}) {
  return {
    kind: "rest",
    why: "Nothing's moved since yesterday.",
    focus: null,
    est_minutes: null,
    ...extra,
    signals: {
      logged_today: { sets: 0, activities: [] },
      continuity: {
        quiet_streak: 1,
        yesterday: { kind: "rest", rule_code: "r1", why: "x" },
        repeat_of_yesterday: true,
      },
      ...(extra.signals || {}),
    },
  };
}

function freshRead(extra = {}) {
  return {
    kind: "train",
    why: "Recovered and ready.",
    focus: "Lower",
    est_minutes: 45,
    ...extra,
    signals: {
      logged_today: { sets: 0, activities: [] },
      continuity: { quiet_streak: 0, yesterday: null, repeat_of_yesterday: false },
      ...(extra.signals || {}),
    },
  };
}

// A session with logged sets and no 1-tap feedback yet.
function seedSessionAwaitingFeedback(date) {
  const session = db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(date);
  const exercise = repo.upsertExercise({ name: "Attention Squat", muscle_group: "legs" });
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 5)`
  ).run(Number(session.lastInsertRowid), Number(exercise.id));
  return Number(session.lastInsertRowid);
}

const surfaces = (attention) => attention.items.map((item) => item.surface);
const tierOf = (attention, surface) => attention.items.find((item) => item.surface === surface)?.tier ?? null;

test("a fresh Brief keeps the lead even when every other surface has something", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  seedSessionAwaitingFeedback(today);
  repo.addInsight({ kind: "connection", text: "Sleep tracks your protein days.", status: "new" });
  repo.addInsight({ kind: "weekly_read", text: "A solid week.", status: "new" });

  const attention = decideTodayAttention(today, freshRead({ signals: { fuel: { bucket: "behind" } } }), {
    today,
  });

  assert.equal(attention.primary, "brief");
  assert.equal(attention.brief_state, "new_read");
  assert.equal(tierOf(attention, "brief"), "lead");
  // Everything else is still present and ordered — nothing was dropped.
  assert.deepEqual(surfaces(attention).sort(), ["brief", "feedback", "fuel", "insight", "weekly"]);
});

test("a repeat-of-yesterday Brief yields the lead to a session awaiting feedback", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  seedSessionAwaitingFeedback(today);

  const attention = decideTodayAttention(today, repeatRead(), { today });

  assert.equal(attention.primary, "feedback");
  assert.equal(attention.brief_state, "repeat_of_yesterday");
  assert.equal(tierOf(attention, "feedback"), "lead");
  assert.equal(tierOf(attention, "brief"), "supporting");
});

test("a repeat-of-yesterday Brief yields the lead to a genuinely new insight", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  repo.addInsight({ kind: "connection", text: "Your best lifts follow rest days.", status: "new" });

  const attention = decideTodayAttention(today, repeatRead(), { today });

  assert.equal(attention.primary, "insight");
  assert.equal(tierOf(attention, "brief"), "supporting");
});

test("an already-seen insight never displaces the Brief, however quiet the day", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  repo.addInsight({ kind: "connection", text: "You already read this one.", status: "seen" });

  const attention = decideTodayAttention(today, repeatRead(), { today });

  assert.equal(attention.primary, "brief");
  assert.equal(tierOf(attention, "insight"), "supporting");
});

test("an actionable fuel state is surfaced but never takes the lead — the Brief already voices it", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);

  const attention = decideTodayAttention(today, repeatRead({ signals: { fuel: { bucket: "behind" } } }), { today });

  assert.equal(attention.primary, "brief");
  assert.ok(surfaces(attention).includes("fuel"));
});

test("feedback outranks a new insight, which outranks a fresh weekly read", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  seedSessionAwaitingFeedback(today);
  repo.addInsight({ kind: "weekly_read", text: "How the week went.", status: "new" });
  repo.addInsight({ kind: "connection", text: "A brand new connection.", status: "new" });

  const attention = decideTodayAttention(today, repeatRead(), { today });

  assert.deepEqual(surfaces(attention), ["feedback", "insight", "weekly", "brief"]);
  assert.deepEqual(
    attention.items.map((item) => item.tier),
    ["lead", "supporting", "quiet", "quiet"]
  );
});

test("answered feedback stops competing, so the Brief takes the lead back", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  seedSessionAwaitingFeedback(today);
  repo.setSessionFeedback(today, { soreness: 2, performance: 4 });

  const attention = decideTodayAttention(today, repeatRead(), { today });

  assert.equal(attention.primary, "brief");
  assert.ok(!surfaces(attention).includes("feedback"));
});

test("the decision is deterministic — identical state serializes identically", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  seedSessionAwaitingFeedback(today);
  repo.addInsight({ kind: "connection", text: "Stable across calls.", status: "new" });
  const read = repeatRead({ signals: { fuel: { bucket: "behind" } } });

  const first = decideTodayAttention(today, read, { today });
  const second = decideTodayAttention(today, read, { today });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("GOLDEN: the serialized decision leaks no score-like number anywhere", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  seedSessionAwaitingFeedback(today);
  repo.addInsight({ kind: "connection", text: "No numbers, please.", status: "new" });
  repo.addInsight({ kind: "weekly_read", text: "Still no numbers.", status: "new" });

  const attention = decideTodayAttention(today, repeatRead({ signals: { fuel: { bucket: "behind" } } }), { today });

  // Same contract markers carry for `impact_score`: the ranking orders, it never ships.
  const walk = (value, path) => {
    if (value == null) return;
    if (typeof value === "number") assert.fail(`numeric leak at ${path}: ${value}`);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        assert.ok(!/score|rank|priority|weight/i.test(key), `score-like key at ${path}.${key}`);
        walk(entry, `${path}.${key}`);
      }
    }
  };
  walk(JSON.parse(JSON.stringify(attention)), "attention");
  assert.doesNotMatch(JSON.stringify(attention), /\d/);
});

test("absent, partial and unparseable input degrade to no decision, never a throw", () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);

  assert.equal(decideTodayAttention(today, null, { today }), null);
  assert.equal(decideTodayAttention(today, undefined, { today }), null);
  assert.equal(decideTodayAttention("", repeatRead(), { today }), null);
  // A routed PAST date renders archival state and arbitrates nothing.
  assert.equal(decideTodayAttention(localDaysAgo(3), repeatRead(), { today }), null);

  // A read with no signals at all (a legacy cached row) still decides, and the
  // Brief keeps the lead — absence can never demote it.
  const bare = decideTodayAttention(today, { kind: "rest" }, { today });
  assert.equal(bare.primary, "brief");
  assert.equal(bare.brief_state, "new_read");
});

test("briefState only yields on a quiet day whose own prose admits the repeat", () => {
  // A train day is always news — there is a session to do.
  assert.equal(briefState({ kind: "train", signals: { continuity: { repeat_of_yesterday: true } } }), "new_read");
  // A done day is always news — the debrief is today's story.
  assert.equal(briefState({ kind: "done", signals: { continuity: { repeat_of_yesterday: true } } }), "new_read");
  // Work logged today makes even a quiet read news again.
  assert.equal(
    briefState({
      kind: "easy",
      signals: { trained_today: true, continuity: { repeat_of_yesterday: true } },
    }),
    "new_read"
  );
  // A steered read is the athlete's own question — it leads.
  assert.equal(
    briefState({ kind: "rest", override: "rough night", signals: { continuity: { repeat_of_yesterday: true } } }),
    "new_read"
  );
  // A settled run of quiet days reads as settled, not as a repeat.
  assert.equal(
    briefState({
      kind: "rest",
      signals: { logged_today: { sets: 0 }, continuity: { quiet_streak: 3, repeat_of_yesterday: false } },
    }),
    "settled_quiet"
  );
});

test("readToday attaches the decision for today and omits it for a past date", async () => {
  resetTables(...TABLES);
  const today = localDaysAgo(0);
  const past = localDaysAgo(4);
  configureDayReadRefresh({ today: () => today, setTimer: () => 0, clearTimer: () => {} });

  const live = repo.dayRead(today);
  repo.saveDayRead(today, { ...live, headline: "Rest today.", source: "deterministic", override: null });
  const archived = repo.dayRead(past);
  repo.saveDayRead(past, { ...archived, headline: "Rest then.", source: "deterministic", override: null });

  const now = await readToday({ date: today });
  const then = await readToday({ date: past });

  assert.ok(now.attention, "today's Brief carries the lead decision");
  assert.equal(typeof now.attention.primary, "string");
  assert.ok(Array.isArray(now.attention.items) && now.attention.items.length > 0);
  assert.equal(now.attention.items[0].surface, now.attention.primary);
  assert.equal(then.attention, undefined, "a past date arbitrates nothing");
  // Every field the Brief already carried is untouched.
  assert.equal(typeof now.kind, "string");
  assert.ok("periodization_context" in now);
});
