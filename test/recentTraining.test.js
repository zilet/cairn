// The unified "Lately" feed (repo.recentTraining) + the This-Week cardio rollup
// (repo.getWeeklyStats). This is what makes Today honest about BOTH modalities:
// the old Today "Recent" strip read only the activities table, so it was
// structurally blind to lifting (a separate table). These cases lock in:
//   - finished strength sessions AND cardio activities merge into one feed
//   - rows are normalized (kind / title / stats) and newest-first
//   - a Garmin-linked cardio row carries a real start time + body-reaction detail
//     (HR zones / effort / VO2 / temp) and a deterministic effort `note`
//   - a manual log stays honest: no faked timestamp, no detail
//   - getWeeklyStats counts cardio (week_cardio / week_cardio_km)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";

const TODAY = isoDaysAgo(0);

beforeEach(() => {
  for (const t of ["logged_sets", "session_skips", "sessions", "activities", "garmin_activities", "garmin_sources"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

// Link a Garmin activity row to a generic activity row (mirrors what sync does:
// upsertGarminActivity sets activity_id), carrying the rich body-reaction columns.
function seedGarminFor(activityId, date, fields = {}) {
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`).run("test-" + activityId);
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, start_time, type, name, duration_min, distance_km,
        avg_hr, max_hr, calories, training_effect, te_label, vo2max, avg_temp, hr_zones_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    src.lastInsertRowid, "ext-" + activityId, activityId, date,
    fields.start_time ?? `${date}T07:12:00`, fields.type ?? "running", fields.name ?? null,
    fields.duration_min ?? 47, fields.distance_km ?? 6.48,
    fields.avg_hr ?? 142, fields.max_hr ?? 168, fields.calories ?? 430,
    fields.training_effect ?? 3.2, fields.te_label ?? "TEMPO", fields.vo2max ?? 48, fields.avg_temp ?? 19,
    JSON.stringify(fields.hr_zones ?? [{ zone: 1, secs: 240 }, { zone: 2, secs: 1980 }, { zone: 3, secs: 540 }])
  );
}

test("recentTraining merges finished strength sessions with cardio, newest-first", () => {
  // A finished strength session.
  repo.logSetByName({ exercise: "Test Squat", weight: 225, reps: 5, date: TODAY });
  const sess = repo.getSessionByDate(TODAY);
  repo.finishSession(sess.id);
  // Two manual cardio logs.
  repo.addActivity({ type: "run", duration_min: 47, distance_km: 6.48, pace: "7:15/km", date: TODAY });
  repo.addActivity({ type: "walking", duration_min: 60, distance_km: 4.57, date: TODAY });

  const feed = repo.recentTraining(6);
  assert.equal(feed.length, 3, "all three surface");
  assert.ok(feed.some((r) => r.kind === "strength"), "lifting is present (the whole point)");
  assert.equal(feed.filter((r) => r.kind === "activity").length, 2, "both cardio rows present");

  const strength = feed.find((r) => r.kind === "strength");
  assert.ok(/\bset/.test(strength.stats) && /lb/.test(strength.stats), "strength stats read 'N sets · X lb'");
  assert.ok(strength.at, "a finished session carries a real timestamp (finished_at)");

  // Same date → the timestamped session sorts above the time-less manual logs.
  assert.equal(feed[0].kind, "strength", "real-timestamp row leads its day");
});

test("an open (unfinished) session does NOT appear in the feed", () => {
  repo.logSetByName({ exercise: "Test Bench", weight: 135, reps: 8, date: TODAY });
  // no finishSession → still open
  const feed = repo.recentTraining(6);
  assert.equal(feed.filter((r) => r.kind === "strength").length, 0, "the live session stays on Today, not Lately");
});

test("a manual cardio log stays honest: no faked time, no detail, no note", () => {
  repo.addActivity({ type: "walking", duration_min: 30, distance_km: 2.1, date: TODAY });
  const [row] = repo.recentTraining(6);
  assert.equal(row.kind, "activity");
  assert.equal(row.at, null, "no honest time-of-day for a date-keyed manual log");
  assert.equal(row.detail, null, "no body-reaction without a watch");
  assert.equal(row.note, null, "nothing to say is the calm default");
});

test("a Garmin-linked cardio row carries a real start time, body-reaction detail, and an effort note", () => {
  const act = repo.addActivity({ type: "run", duration_min: 47, distance_km: 6.48, pace: "7:15/km", date: TODAY });
  seedGarminFor(act.id, TODAY);

  const row = repo.recentTraining(6).find((r) => r.kind === "activity");
  assert.ok(row.at && row.at.includes("T"), "real Garmin start_time becomes `at`");
  assert.equal(row.source, "garmin");
  assert.ok(row.detail, "body-reaction detail present");
  assert.equal(row.detail.avg_hr, 142);
  assert.equal(row.detail.vo2max, 48);
  assert.equal(row.detail.avg_temp, 19);
  assert.ok(Array.isArray(row.detail.hr_zones) && row.detail.hr_zones.length === 3, "HR zones parsed");
  assert.equal(row.note, "tempo effort", "the effort label drives a calm deterministic note");
});

test("getWeeklyStats counts cardio this week (week_cardio / week_cardio_km)", () => {
  repo.addActivity({ type: "run", duration_min: 47, distance_km: 6.48, date: TODAY });
  repo.addActivity({ type: "walking", duration_min: 60, distance_km: 4.57, date: TODAY });
  const ws = repo.getWeeklyStats();
  assert.equal(ws.week_cardio, 2, "two cardio activities this week");
  assert.equal(ws.week_cardio_km, 11.1, "summed distance, rounded to 0.1");
});
