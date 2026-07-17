// The endurance v1 correlational builders in the personal-response model
// (src/repo/reaction-model.ts): mileage_recovery (bigger run weeks → next-week
// resting-HR shift) and easy_pace_efficiency (faster easy pace at a matched heart
// rate). Both are sparsity-gated — a detector that fires on thin data is a defect —
// and constitution-bound: plain second-person words + confidence WORDS, the
// internal coefficients (params) never crossing the public boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { buildReactionModel, reactionModelForCoach } from "../dist/repo/reaction-model.js";

const iso = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

function seedRestingHr(daysAgo, rhr) {
  db.prepare(
    `INSERT INTO daily_metrics (source, date, resting_hr, updated_at) VALUES ('apple', ?, ?, datetime('now'))`
  ).run(iso(daysAgo), rhr);
}

// A runner whose bigger running weeks are followed by a higher resting HR the next
// week. Weeks alternate high (40 km) / low (12 km); each week's RHR reflects the load
// of the chronologically-previous week, so the pair (this week's km, next week's RHR
// delta) is a clean positive correlation. Seeds `weeks` paired weeks (+ week 0 RHR).
function seedMileageRecovery(weeks) {
  for (let w = 0; w <= weeks; w++) {
    const rhr = w % 2 === 0 ? 56 : 50;
    for (const off of [1, 2, 4]) seedRestingHr(w * 7 + off, rhr); // >=2 nights/week
  }
  for (let w = 1; w <= weeks; w++) {
    const km = w % 2 === 1 ? 40 : 12;
    repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date: iso(w * 7 + 3) });
  }
}

test("mileage_recovery surfaces when bigger run weeks precede a higher next-week resting HR", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  seedMileageRecovery(10); // 10 paired weeks — well above the 6-week gate
  const pattern = buildReactionModel().patterns.find((p) => p.id === "mileage_recovery");
  assert.ok(pattern, "a mileage_recovery pattern is surfaced on a real coincidence");
  assert.match(pattern.statement, /resting heart rate/i);
  assert.match(pattern.statement, /higher|absorbing/i, "the positive correlation reads as RHR rising after big weeks");
  assert.deepEqual(new Set(pattern.domains), new Set(["endurance", "recovery"]));
  assert.ok(pattern.evidence_n >= 6);
  assert.ok(["observed", "strong"].includes(pattern.confidence));
});

test("mileage_recovery stays silent below the 6-paired-week gate", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  seedMileageRecovery(4); // only ~4 paired weeks
  assert.equal(
    buildReactionModel().patterns.find((p) => p.id === "mileage_recovery"),
    undefined
  );
});

test("mileage_recovery internal coefficients never cross the public boundary", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  seedMileageRecovery(10);
  const surfaced = reactionModelForCoach().patterns.find((p) => p.id === "mileage_recovery");
  assert.ok(surfaced, "the pattern is surfaced through the coach read");
  assert.equal(surfaced.params, undefined, "the internal params blob is stripped");
  assert.doesNotMatch(JSON.stringify(surfaced), /impact_score|"score"/);
});

// ── easy_pace_efficiency ──────────────────────────────────────────────────────

function garminSource(label) {
  return db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`).run(label).lastInsertRowid;
}

// One easy run: activities row carries distance/duration (→ pace), garmin_activities
// carries the avg HR + a low aerobic training effect (an easy effort).
function seedEasyRun(sourceId, daysAgo, { km = 10, paceMinKm, hr, te = 2.5 }) {
  const a = repo.addActivity({
    type: "run",
    distance_km: km,
    duration_min: Math.round(km * paceMinKm * 10) / 10,
    date: iso(daysAgo),
  });
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, avg_hr, aerobic_te)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`
  ).run(sourceId, `epe-${daysAgo}`, a.id, a.date, hr, te);
}

test("easy_pace_efficiency surfaces faster easy pace at a matched heart rate", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  const src = garminSource("epe-fast");
  // Older half: 6.0 min/km at ~140 bpm. Newer half: 5.5 min/km at ~140 bpm.
  for (const d of [118, 110, 100, 92, 84, 78]) seedEasyRun(src, d, { paceMinKm: 6.0, hr: 140 });
  for (const d of [42, 34, 26, 18, 10, 5]) seedEasyRun(src, d, { paceMinKm: 5.5, hr: 140 });
  const pattern = buildReactionModel().patterns.find((p) => p.id === "easy_pace_efficiency");
  assert.ok(pattern, "an easy_pace_efficiency pattern is surfaced");
  assert.match(pattern.statement, /same easy heart rate/i);
  assert.match(pattern.statement, /faster/i, "faster easy pace at matched HR reads as improvement");
  assert.match(pattern.statement, /sec\/km/i, "a real unit, never a score");
  assert.ok(pattern.domains.includes("endurance"));
  assert.equal(pattern.evidence_n, 12);
});

test("easy_pace_efficiency stays silent below the qualifying-run pool", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  const src = garminSource("epe-thin");
  for (const d of [110, 90, 70, 40, 20, 5]) seedEasyRun(src, d, { paceMinKm: 6.0, hr: 140 }); // only 6 runs
  assert.equal(
    buildReactionModel().patterns.find((p) => p.id === "easy_pace_efficiency"),
    undefined
  );
});

test("easy_pace_efficiency stays silent without matched-HR overlap between the halves", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  const src = garminSource("epe-nomatch");
  // Older runs all at ~130 bpm, newer runs all at ~160 bpm — no shared HR bucket, so a
  // pace difference cannot be attributed to fitness rather than to running harder.
  for (const d of [118, 110, 100, 92, 84]) seedEasyRun(src, d, { paceMinKm: 6.0, hr: 130 });
  for (const d of [42, 34, 26, 18, 10]) seedEasyRun(src, d, { paceMinKm: 5.5, hr: 160 });
  assert.equal(
    buildReactionModel().patterns.find((p) => p.id === "easy_pace_efficiency"),
    undefined
  );
});
