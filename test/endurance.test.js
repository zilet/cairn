// Endurance / runner-first + hybrid support (v35). These pin the deterministic
// cores: primary_discipline round-trip, discipline-aware day-read rest behavior,
// endurance weekly stats, a cardio plan item round-trip (save→get with a null
// exercise_id), endurance PRs, and the connected-brain endurance markers
// (VO2max/RHR/HRV) — including the constitution invariant that they never leak a
// 0-100 grade / impact_score. Offline + deterministic, like the rest of the suite.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

// A reference date well clear of the recovery window (so an empty recovery fetch
// can't flip the read) — mirrors dayRead.test.js.
const REF = "2026-03-15";
const dayBefore = (base, n) =>
  new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

function seedActivity(date, { type = "run", duration_min = null, distance_km = null } = {}) {
  return db
    .prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, ?, ?, ?)`)
    .run(date, type, duration_min, distance_km);
}

beforeEach(() => {
  resetTables(
    "logged_sets", "sessions", "session_skips", "plan_items", "plan_days",
    "checkins", "daily_metrics", "garmin_daily_metrics", "activities", "health_documents", "health_directives"
  );
  // Reset the profile discipline + endurance goal to defaults so cases don't bleed.
  repo.setProfile({ primary_discipline: "strength", endurance_sport: "", endurance_goal: null });
});

// ---------- A.1 primary_discipline round-trip ----------
test("primary_discipline + endurance_sport round-trip through setProfile/getProfile", () => {
  const p = repo.setProfile({ primary_discipline: "endurance", endurance_sport: "running" });
  assert.equal(p.primary_discipline, "endurance");
  assert.equal(p.endurance_sport, "running");
  assert.equal(repo.getPrimaryDiscipline(), "endurance");

  // An unknown discipline value is rejected (leaves the existing value intact).
  const p2 = repo.setProfile({ primary_discipline: "triathlete" });
  assert.equal(p2.primary_discipline, "endurance", "invalid value leaves the prior discipline");

  // hybrid is accepted; '' clears endurance_sport.
  const p3 = repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "" });
  assert.equal(p3.primary_discipline, "hybrid");
  assert.equal(p3.endurance_sport, null);
});

test("a brand-new profile defaults primary_discipline to 'strength'", () => {
  // getCoachContext echoes the discipline at top level (default 'strength').
  const ctx = repo.getCoachContext();
  assert.equal(ctx.discipline.primary, "strength");
});

// ---------- A.4 discipline-aware day-read rest behavior ----------
test("strength athlete: a cardio activity does NOT count toward consecutive training days", () => {
  // 3 cardio days running, no lifting — a strength athlete's rest rule ignores cardio.
  for (let i = 1; i <= 3; i++) seedActivity(dayBefore(REF, i), { type: "run", duration_min: 45, distance_km: 8 });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 0, "cardio days are invisible to a strength athlete");
  assert.notEqual(r.kind, "rest");
});

test("endurance athlete: 3 consecutive cardio days earns REST (cardio counts as training)", () => {
  repo.setProfile({ primary_discipline: "endurance", endurance_sport: "running" });
  for (let i = 1; i <= 3; i++) seedActivity(dayBefore(REF, i), { type: "run", duration_min: 45, distance_km: 8 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.discipline, "endurance");
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "rest");
  assert.match(r.why, /several days running/i);
});

test("endurance athlete: a single short walk doesn't read as a hard training day", () => {
  repo.setProfile({ primary_discipline: "endurance" });
  // 10-minute walks below the 20-min / any-distance bar → not counted.
  for (let i = 1; i <= 3; i++) seedActivity(dayBefore(REF, i), { type: "walk", duration_min: 10 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 0, "sub-threshold movement is not a training day");
});

test("hybrid athlete: a mileage SPIKE this week earns an easier day", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // Prior 3 weeks: a modest base (~15 km/wk). This week: a big jump (~45 km), no
  // 3-day streak, so the spike rule (not the consecutive rule) is what trips rest.
  for (const wkBack of [7, 14, 21]) {
    seedActivity(dayBefore(REF, wkBack + 1), { type: "run", duration_min: 80, distance_km: 15 });
  }
  // This week (within the 6 days before REF), spread so consec stays < 3.
  seedActivity(dayBefore(REF, 1), { type: "run", duration_min: 120, distance_km: 25 });
  seedActivity(dayBefore(REF, 3), { type: "run", duration_min: 110, distance_km: 22 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.endurance_volume.volume_spike, true, "mileage jump is flagged as a spike");
  assert.ok(r.signals.consecutive_training_days < 3, "spike, not the consecutive-day rule, drives this");
  // A genuine spike now earns an EASY day, not a forced rest — a suggestion, not a
  // gate (and matching the read's own "an easier day lets it absorb" wording). The
  // hard runs this week made the recent days loading, so the spike caveat applies.
  assert.equal(r.kind, "easy");
  assert.match(r.why, /mileage|absorb|ramped/i);
});

// ---------- A.3 endurance weekly stats ----------
test("getWeeklyStats returns an endurance block with mileage, moving time, longest, and pace trend", () => {
  // Two runs THIS week (Monday-anchored), one in the prior week for the pace trend.
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const monday = (() => {
    const d = new Date(iso(today) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return iso(d);
  })();
  const thisWk1 = monday;
  const thisWk2 = iso(new Date(new Date(monday + "T00:00:00Z").getTime() + 864e5));
  const prevWk = iso(new Date(new Date(monday + "T00:00:00Z").getTime() - 3 * 864e5));

  seedActivity(thisWk1, { type: "run", duration_min: 50, distance_km: 10 }); // 5.0 min/km
  seedActivity(thisWk2, { type: "run", duration_min: 24, distance_km: 6 });  // 4.0 min/km
  seedActivity(prevWk, { type: "run", duration_min: 60, distance_km: 10 });  // 6.0 min/km (slower)

  const e = repo.getWeeklyStats().endurance;
  assert.ok(e, "endurance block present");
  assert.equal(e.week_km, 16, "10 + 6 km this week");
  assert.equal(e.week_moving_min, 74, "50 + 24 min this week");
  assert.equal(e.longest_km, 10, "longest single effort this week");
  // This week's blended pace (74/16 ≈ 4.63) is FASTER than last week's (6.0).
  assert.equal(e.pace_trend.dir, "faster");
  assert.ok(e.pace_trend.this_min_per_km < e.pace_trend.prev_min_per_km);
});

test("endurance weekly time-in-zone rolls up from synced Garmin activities", () => {
  // Need a garmin_source row to satisfy the NOT NULL source_id FK.
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','test')`).run();
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const monday = (() => {
    const d = new Date(iso(today) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return iso(d);
  })();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, date, type, hr_zones_json)
     VALUES (?, 'a1', ?, 'running', ?)`
  ).run(src.lastInsertRowid, monday, JSON.stringify([{ zone: 1, secs: 600 }, { zone: 2, secs: 1800 }]));
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, date, type, hr_zones_json)
     VALUES (?, 'a2', ?, 'running', ?)`
  ).run(src.lastInsertRowid, monday, JSON.stringify([{ zone: 2, secs: 1200 }]));

  const e = repo.getWeeklyStats().endurance;
  assert.equal(e.time_in_zone.Z1, 600);
  assert.equal(e.time_in_zone.Z2, 3000, "Z2 secs summed across both activities");
});

// ---------- B cardio plan item round-trip ----------
test("a cardio plan item round-trips (save → get) with a NULL exercise_id", () => {
  repo.savePlanDay(1, "Endurance", "Long run", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 16, target_zone: "Z2", note: "easy, conversational" },
    { exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }, // a strength item alongside it
  ]);
  const day = repo.getPlanDay(1);
  assert.equal(day.items.length, 2, "LEFT JOIN keeps the cardio item (no exercise_id) AND the strength item");
  const cardio = day.items.find((i) => i.kind === "cardio");
  assert.ok(cardio, "cardio item returned");
  assert.equal(cardio.target_distance_km, 16);
  assert.equal(cardio.target_zone, "Z2");
  // The stored row has a NULL exercise_id (no orphaned FK, no fabricated exercise).
  const raw = db.prepare(`SELECT exercise_id FROM plan_items WHERE plan_day_id = ? AND kind = 'cardio'`).get(day.id);
  assert.equal(raw.exercise_id, null, "cardio item stores no exercise_id");
  // The strength item is unaffected.
  const strength = day.items.find((i) => i.kind === "strength");
  assert.equal(strength.exercise, "Squat");
});

test("a cardio plan item carries a parsed interval structure through getPlan", () => {
  repo.savePlanDay(2, "Intervals", "Track", [
    { kind: "cardio", exercise: "Intervals", target_zone: "VO2", interval: [{ reps: 6, on: "400m", off: "90s" }] },
  ]);
  const item = repo.getPlanDay(2).items[0];
  assert.equal(item.kind, "cardio");
  assert.ok(Array.isArray(item.interval), "interval JSON is parsed back to an array");
  assert.equal(item.interval[0].reps, 6);
});

test("the iCal export renders a cardio plan item as an endurance line", () => {
  repo.savePlanDay(1, "Endurance", "Long run", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 12, target_zone: "Z2" },
  ]);
  const ics = repo.buildPlanICS({ now: new Date("2026-03-16T08:00:00Z"), startWeekday: 1 });
  assert.match(ics, /Long run.*12 km.*Z2/);
});

// ---------- B2 week-ahead floor reflects prescribed cardio ----------
// Regression: the deterministic floor used to hardcode every day to kind:'lift', so a
// runner saw zero runs in the Today week-ahead floor. It now reads plan_items.
test("weekAheadPlan floor marks lift / run / mixed days from plan_items", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.savePlanDay(2, "Easy run", "Aerobic", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 8, target_zone: "Z2" }]);
  repo.savePlanDay(3, "Run + lift", "Mixed", [
    { kind: "cardio", exercise: "Tempo", target_distance_km: 6, target_zone: "Z3" },
    { exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5 },
  ]);
  const { days } = repo.weekAheadPlan();
  assert.equal(days.length, 3);
  assert.equal(days[0].kind, "lift", "strength-only day → lift");
  assert.equal(days[1].kind, "run", "cardio-only day → run");
  assert.equal(days[2].kind, "mixed", "cardio + strength day → mixed");
});

test("weekAheadPlan returns no days when there is no plan", () => {
  assert.deepEqual(repo.weekAheadPlan().days, []);
});

// ---------- C endurance PRs ----------
test("getEndurancePRs surfaces longest distance/duration and fastest pace per distance", () => {
  seedActivity("2026-01-01", { type: "run", duration_min: 50, distance_km: 10 });   // 5.0 min/km
  seedActivity("2026-02-01", { type: "run", duration_min: 44, distance_km: 10 });   // 4.4 min/km (faster 10k)
  seedActivity("2026-03-01", { type: "run", duration_min: 120, distance_km: 21.1 }); // longest, ~5.69 min/km
  const prs = repo.getEndurancePRs("run");
  assert.equal(prs.longest_km.value, 21.1, "longest distance");
  assert.equal(prs.longest_min.value, 120, "longest duration");
  // Fastest 10k pace = the 4.4 effort; a 5k PR is also derived (the 10k covered it).
  const tenK = prs.best_pace.find((p) => p.distance_km === 10);
  assert.ok(tenK, "a 10k pace PR exists");
  assert.equal(tenK.min_per_km, 4.4);
  const fiveK = prs.best_pace.find((p) => p.distance_km === 5);
  assert.ok(fiveK, "a 5k PR is derived from the longer efforts that covered it");
});

test("getEndurancePRs is null-safe with no cardio logged", () => {
  const prs = repo.getEndurancePRs();
  assert.equal(prs.longest_km, null);
  assert.equal(prs.longest_min, null);
  assert.deepEqual(prs.best_pace, []);
});

// ---------- C.8 connected-brain endurance markers ----------
test("VO2max / resting HR / HRV become trending markers from the recovery data", () => {
  // Source-agnostic daily metrics over a few days → a trend the brain can read.
  repo.recordDailyMetrics("apple", "2026-03-01", { resting_hr: 58, hrv_ms: 45 });
  repo.recordDailyMetrics("apple", "2026-03-05", { resting_hr: 56, hrv_ms: 48 });
  repo.recordDailyMetrics("apple", "2026-03-10", { resting_hr: 54, hrv_ms: 52 });
  const { markers } = repo.prioritizeMarkers();
  const rhr = markers.find((m) => m.key === "resting hr");
  const hrv = markers.find((m) => m.key === "hrv");
  assert.ok(rhr, "resting HR is a tracked marker");
  assert.ok(hrv, "HRV is a tracked marker");
  assert.equal(rhr.latest.value, 54, "latest resting HR");
  assert.equal(rhr.trend.n, 3, "trend built from 3 readings");
  assert.equal(rhr.trend.dir, "falling", "resting HR falling over the window");
  assert.ok(rhr.optimal, "resting HR carries an optimal-zone band");
  assert.equal(rhr.optimal.dir, "high", "higher resting HR is worse");
  assert.equal(hrv.optimal.dir, "low", "lower HRV is worse");
});

test("a lab VO2max reading wins over the wearable estimate (no double-counting)", () => {
  // Wearable VO2max in garmin_daily_metrics…
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','t2')`).run();
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, vo2max) VALUES (?, '2026-03-01', 48)`).run(src.lastInsertRowid);
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, vo2max) VALUES (?, '2026-03-08', 49)`).run(src.lastInsertRowid);
  // …and a lab VO2max document (the source of truth).
  repo.addHealthDocument({ kind: "bloodwork", doc_date: "2026-03-10", parsed_json: { markers: [{ name: "VO2max", value: 52, unit: "mL/kg/min" }] }, enrichment_status: "done" });
  const vo2 = repo.prioritizeMarkers().markers.filter((m) => m.key === "vo2max");
  assert.equal(vo2.length, 1, "exactly one VO2max marker (no wearable + lab duplicate)");
  assert.equal(vo2[0].latest.value, 52, "the lab reading wins");
});

// ---------- GOLDEN: endurance markers never leak a 0-100 grade / impact_score ----------
test("GOLDEN: wearable endurance markers carry no impact_score / 0-100 grade over the API boundary", () => {
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','t3')`).run();
  for (const [d, v, rhr, hrv] of [["2026-03-01", 38, 70, 30], ["2026-03-05", 38, 71, 28], ["2026-03-10", 37, 72, 26]]) {
    db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, vo2max, resting_hr, hrv_ms) VALUES (?, ?, ?, ?, ?)`).run(src.lastInsertRowid, d, v, rhr, hrv);
  }
  const { markers } = repo.prioritizeMarkers();
  const wearable = markers.filter((m) => ["vo2max", "resting hr", "hrv"].includes(m.key));
  assert.ok(wearable.length >= 3, "all three wearable markers present");
  for (const m of wearable) {
    assert.ok(!("impact_score" in m), `${m.key} must not serialize impact_score`);
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== "number") continue;
      assert.ok(!/grade|rating|percent|pct|out_of|score/i.test(k), `${m.key}.${k} must not be a grade-shaped field`);
    }
  }
});

// ---------- v37 endurance goal: race + standing modes ----------
test("a race goal round-trips and derives weeks/days-to-race + a phase hint", () => {
  // Pick the race date relative to a fixed 'today' we pass into the reader so the
  // test is deterministic (getEnduranceGoal accepts an explicit today).
  repo.setProfile({ endurance_goal: { mode: "race", event: "Cambridge Half", date: "2026-11-01", distance_km: 21.1, target: "sub-1:45", weekly_km: 40, weekly_sessions: 4 } });
  const g = repo.getEnduranceGoal("2026-09-06"); // ~8 weeks out
  assert.equal(g.mode, "race");
  assert.equal(g.is_race, true);
  assert.equal(g.event, "Cambridge Half");
  assert.equal(g.days_to_race, 56);
  assert.equal(g.weeks_to_race, 8);
  assert.equal(g.phase, "build", "8 weeks out reads as the build phase");
  // Two weeks out → taper; one day after → past.
  assert.equal(repo.getEnduranceGoal("2026-10-20").phase, "taper");
  assert.equal(repo.getEnduranceGoal("2026-11-02").phase, "past");
});

test("a standing goal has no date/phase — maintain, not ramp", () => {
  repo.setProfile({ endurance_goal: { mode: "standing", label: "10k-ready", distance_km: 10, weekly_km: 25, weekly_sessions: 3 } });
  const g = repo.getEnduranceGoal("2026-09-06");
  assert.equal(g.mode, "standing");
  assert.equal(g.is_race, false);
  assert.equal(g.label, "10k-ready");
  assert.equal(g.distance_km, 10);
  assert.ok(!("phase" in g) || g.phase == null, "standing goals carry no periodization phase");
});

test("an unusable endurance goal clears it; a race without a date is rejected", () => {
  repo.setProfile({ endurance_goal: { mode: "race", event: "No Date 5k" } }); // no date
  assert.equal(repo.getEnduranceGoal("2026-09-06"), null, "a dateless race is rejected (can't periodize)");
  repo.setProfile({ endurance_goal: { mode: "standing", distance_km: 10 } });
  assert.ok(repo.getEnduranceGoal(), "standing goal set");
  repo.setProfile({ endurance_goal: null });
  assert.equal(repo.getEnduranceGoal(), null, "null clears the goal");
});

test("the endurance goal surfaces in getCoachContext (orthogonal to discipline)", () => {
  repo.setProfile({ primary_discipline: "strength", endurance_goal: { mode: "standing", label: "10k-ready", distance_km: 10 } });
  const ctx = repo.getCoachContext();
  assert.equal(ctx.discipline.primary, "strength", "discipline unchanged — running is 'on the side'");
  assert.ok(ctx.endurance_goal, "endurance_goal present in coach context");
  assert.equal(ctx.endurance_goal.mode, "standing");
});

// ---------- run compliance (closing the runner loop) ----------
// This-week Monday-anchored seeding, mirroring the getWeeklyStats endurance test.
const thisWeekMonday = () => {
  const iso = (d) => d.toISOString().slice(0, 10);
  const d = new Date(iso(new Date()) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
};

test("getRunCompliance: prescribed plan cardio vs this week's logged runs, in plain words", () => {
  // Plan day with one cardio item prescribing 16 km.
  repo.savePlanDay(1, "Run", "Endurance", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 16 },
  ]);
  // This week: a 10 km run logged on Monday.
  seedActivity(thisWeekMonday(), { type: "run", duration_min: 50, distance_km: 10 });

  const rc = repo.getRunCompliance();
  assert.equal(rc.prescribed_sessions, 1, "one cardio item prescribed");
  assert.equal(rc.prescribed_km, 16, "prescribed km summed from the cardio item");
  assert.equal(rc.actual_sessions, 1, "one cardio effort logged this week");
  assert.equal(rc.actual_km, 10, "actual km reflects the seeded run");
  assert.equal(rc.pct_km, 0.63, "10 / 16 ≈ 0.63 (a proportion, not a 0-100 grade)");
  assert.equal(typeof rc.in_words, "string");
  assert.match(rc.in_words, /10 of 16 km/, "plain ratio in words");
  // Constitution: in_words is NOT a digit-only 0-100 score.
  assert.ok(!/^\s*\d{1,3}\s*$/.test(rc.in_words), "in_words is never a bare 0-100 number");
});

test("getRunCompliance: no plan cardio AND no runs → calm, null pct, no throw", () => {
  const rc = repo.getRunCompliance();
  assert.equal(rc.prescribed_sessions, 0);
  assert.equal(rc.prescribed_km, 0);
  assert.equal(rc.actual_sessions, 0);
  assert.equal(rc.actual_km, 0);
  assert.equal(rc.pct_km, null, "no prescribed km → pct_km null, never a divide-by-zero");
  assert.match(rc.in_words, /no runs prescribed/i);
});

test("getRunCompliance: a strength activity row does NOT count as a run", () => {
  repo.savePlanDay(1, "Run", "Endurance", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 8 }]);
  // A real run plus a stray strength-typed activity row on the same week.
  seedActivity(thisWeekMonday(), { type: "run", duration_min: 40, distance_km: 8 });
  seedActivity(thisWeekMonday(), { type: "strength_training", duration_min: 60, distance_km: null });
  const rc = repo.getRunCompliance();
  assert.equal(rc.actual_sessions, 1, "only the run counts; strength is filtered out");
  assert.equal(rc.actual_km, 8);
});

// ---------- cardio for a date ----------
test("getCardioForDate: returns the day's cardio with distance; excludes strength", () => {
  seedActivity("2026-02-10", { type: "run", duration_min: 45, distance_km: 9 });
  seedActivity("2026-02-10", { type: "strength_training", duration_min: 55, distance_km: null });
  const cardio = repo.getCardioForDate("2026-02-10");
  assert.equal(cardio.length, 1, "only the cardio effort comes back (strength excluded)");
  assert.equal(cardio[0].type, "run");
  assert.equal(cardio[0].distance_km, 9, "carries the logged distance");
  // A day with no cardio is an empty array, never a throw.
  assert.deepEqual(repo.getCardioForDate("2026-02-11"), []);
});
