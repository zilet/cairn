// A session the athlete CHOSE for a day — written by them, or by an AI app over MCP
// (prepare_daily_session source athlete_override) — owns that day everywhere it is read.
// 2026-11-07 (live): a pull session planned over MCP on a Saturday the calendar calls
// rest read "A rest day. Nothing is planned." on the Plan day, and once logged it was
// named after the plan day ("Pull — heavy row") while Today's line said the title the
// athlete chose. Also: correcting a hand-logged activity's sport (update_activity).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { loggedSessionDay } from "../dist/repo/session-day.js";
import { localDateISO } from "../dist/repo/shared.js";

function seedPull() {
  repo.savePlanDay(5, "Pull — heavy row", "Pull-ups and rows", [
    { exercise: "Pull-Up", sets: 3, rep_low: 8, rep_high: 11 },
    { exercise: "Pendlay Row", sets: 3, rep_low: 6, rep_high: 9, target_weight: 155 },
    { exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 12, target_weight: 80 },
  ]);
  return db.prepare(`SELECT id FROM plan_days WHERE day_number = 5`).get().id;
}

function chosen(date, planDayNumber) {
  return repo.prepareDailySession({
    date,
    source: "athlete_override",
    ...(planDayNumber != null ? { day_number: planDayNumber } : {}),
    session: {
      name: "Pull-ups, upper, and light core",
      focus: "Pull-ups plus back, rear delts, and easy core",
      why: "You asked for a pull-up centered session.",
      est_minutes: 40,
      items: [
        { kind: "strength", exercise: "Pull-Up", sets: 4, rep_low: 6, rep_high: 8, target_weight: 0 },
        { kind: "strength", exercise: "Reverse Pec Deck", sets: 2, rep_low: 10, rep_high: 15, target_weight: 95 },
        { kind: "strength", exercise: "Dead Bug", sets: 2, rep_low: 6, rep_high: 8 },
      ],
    },
  });
}

test("the Plan day reads a chosen session before it starts, never 'nothing is planned'", () => {
  const today = localDateISO();
  chosen(today);
  const detail = dayDetail(today);
  assert.equal(detail.status, "today");
  assert.ok(detail.lift, "the chosen session is the day's lift");
  assert.equal(detail.lift.title, "Pull-ups, upper, and light core");
  assert.deepEqual(
    detail.lift.exercises.map((e) => [e.name, e.prescription]),
    [
      ["Pull-Up", "4 × 6–8"],
      ["Reverse Pec Deck", "2 × 10–15"],
      ["Dead Bug", "2 × 6–8"],
    ]
  );
  assert.doesNotMatch(detail.headline, /nothing is planned/i);
});

test("a chosen session on its plan day keeps the title the athlete chose once logged", () => {
  seedPull();
  const today = localDateISO();
  const prepared = chosen(today, 5);
  const sessionId = prepared.daily_session.session_id;
  const planDayId = db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(sessionId).plan_day_id;
  assert.equal(loggedSessionDay(sessionId, planDayId).title, "Pull-ups, upper, and light core", "before any set");
  repo.logSetByName({ exercise: "Pull-Up", weight: null, reps: 8, date: today });
  repo.logSetByName({ exercise: "Reverse Pec Deck", weight: 95, reps: 12, date: today });
  const after = loggedSessionDay(sessionId, planDayId);
  assert.equal(after.title, "Pull-ups, upper, and light core", "after the work");
  assert.equal(after.day_number, 5, "still that plan day's work — the week counts Pull done");
});

test("an accepted suggestion's title reads through the display rule on the Plan day", () => {
  const today = localDateISO();
  const sessionId = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(today).lastInsertRowid);
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, title, focus, why, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'agent_suggest', 'active', ?, 'Back', 'why', ?, 'test')`
  ).run(
    sessionId,
    today,
    "Pull — the week's one pull day",
    JSON.stringify([{ kind: "strength", exercise: "Pull-Up", sets: 3, rep_low: 6, rep_high: 8 }])
  );
  const lift = dayDetail(today).lift;
  assert.equal(lift.title, "Pull", "the week-count claim is dropped, as the strength line drops it");
  assert.equal(lift.day_number, null, "off the plan");
});

test("a correction refuses coerced junk and wins over a pending enrichment", () => {
  const row = repo.addActivity({ text: "ran 30 min", type: "run" });
  for (const bad of ["", true, 0, -5, "abc"]) {
    assert.equal(repo.correctActivity(row.id, { duration_min: bad }).code, "invalid_input", JSON.stringify(bad));
  }
  assert.equal(repo.correctActivity(row.id, { duration_min: null }).ok, true, "null clears");
  db.prepare(`UPDATE activities SET enrichment_status = 'pending' WHERE id = ?`).run(row.id);
  const fixed = repo.correctActivity(row.id, { duration_min: 40, distance_km: 8 });
  assert.equal(fixed.activity.pace, "5:00/km", "a run's pace follows its corrected length");
  assert.equal(fixed.activity.enrichment_status, "skipped", "a pending enrichment never lands over it");
});

test("a hand-logged activity's sport can be corrected; a watch row cannot", () => {
  const row = repo.addActivity({ text: "10 min session", type: "other" });
  const fixed = repo.correctActivity(row.id, { type: "Boxing" });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.activity.type, "boxing");
  assert.equal(repo.correctActivity(row.id, { type: "not a sport!" }).code, "invalid_input");
  assert.equal(repo.correctActivity(row.id, {}).code, "invalid_input");
  assert.equal(repo.correctActivity(999999, { type: "run" }).code, "not_found");
  const watch = repo.addActivity({ type: "run", duration_min: 30, source: "garmin", external_id: "x-1" });
  assert.equal(repo.correctActivity(watch.id, { type: "ride" }).code, "watch_imported");
});
