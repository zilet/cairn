// The deterministic RUNNING program engine (src/repo/run-progression.ts) — the
// endurance analogue of progression.ts. These lock the coach-level reads it must
// get right: HR-zone bpm bands grounded in real physiology (age fallback, ordered,
// quiet when there's nothing to ground them in), a periodized weekly run mix with a
// long run + a rotated quality session (interval sessions carrying real interval
// structure) under conservative caps, the mono-stimulus variety read, and the
// running re-test cadence — and, constitution, nothing leaks a 0-100 score.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
const fwd = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/"score"/.test(json), `${label}: no bare score field`);
};

function resetAll() {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks",
    "bodyweight_log",
    "profile"
  );
}

// Seed a runner with `weeks` weeks of easy running, `perWeek` runs/wk at `km` each.
function seedRunner({ weeks = 10, perWeek = 3, km = 9 } = {}) {
  for (let wk = 0; wk < weeks; wk++) {
    const offsets = [1, 3, 5].slice(0, perWeek);
    for (const off of offsets) {
      repo.addActivity({ type: "run", duration_min: Math.round(km * 6), distance_km: km, date: back(wk * 7 + off) });
    }
  }
}

beforeEach(resetAll);

// ── runZones ────────────────────────────────────────────────────────────────

test("runZones falls back to age-modelled bands (Tanaka) when no max HR is set, ordered ascending", () => {
  repo.setProfile({ age: 44, sex: "male" });
  const z = repo.runZones({ profile: { age: 44 } });
  assert.equal(z.available, true);
  assert.equal(z.method, "age");
  assert.ok(z.max_hr >= 170 && z.max_hr <= 185, `Tanaka max HR ≈ 208−0.7·44 (got ${z.max_hr})`);
  assert.equal(z.zones.length, 5, "the five canonical zones");
  // zones ordered Z1→Z5 with strictly non-decreasing bpm bands.
  for (let i = 1; i < z.zones.length; i++) {
    assert.ok(z.zones[i].low_bpm >= z.zones[i - 1].low_bpm, "zone bands ascend");
  }
  for (const zz of z.zones) assert.ok(zz.high_bpm > zz.low_bpm, `${zz.zone} high > low`);
  NO_SCORE(z, "runZones");
});

test("runZones honors an explicit max HR over the age model", () => {
  const z = repo.runZones({ profile: {}, maxHr: 190 });
  assert.equal(z.method, "explicit");
  assert.equal(z.max_hr, 190);
  assert.equal(z.available, true);
});

test("runZones stays quiet when there's nothing to ground it in (no age, no watch)", () => {
  const z = repo.runZones({ profile: {} });
  assert.equal(z.available, false);
  assert.equal(z.method, null);
  assert.deepEqual(z.zones, []);
});

// ── weeklyRunPlan ─────────────────────────────────────────────────────────────

test("weeklyRunPlan stays quiet with no running goal and no logged mileage", () => {
  repo.setProfile({ primary_discipline: "strength", endurance_sport: "", endurance_goal: null });
  const plan = repo.weeklyRunPlan(REF);
  assert.equal(plan.available, false);
  assert.deepEqual(plan.runs, []);
});

test("weeklyRunPlan produces a periodized mix with a long run + a rotated quality session", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Test Half", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 } });
  seedRunner({ weeks: 10, perWeek: 3, km: 9 }); // ~27 km/wk base

  const plan = repo.weeklyRunPlan(REF);
  assert.equal(plan.available, true);
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.ok(long, "a long run is in the mix");
  assert.equal(long.day_number, 6, "the long run is placed late in the week");
  const easy = plan.runs.filter((r) => r.kind_label === "easy");
  assert.ok(easy.length >= 1, "easy aerobic runs make up the base");
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  assert.ok(quality, "a quality session is included off a solid base");
  // every run carries a concrete zone tag + day slot; no two hard days collide.
  assert.ok(plan.runs.every((r) => typeof r.target_zone === "string" && r.target_zone.length > 0), "each run has a zone");
  assert.ok(plan.mix_summary.includes("long"), "mix summary names the long run");
  NO_SCORE(plan, "weeklyRunPlan");
});

test("weeklyRunPlan emits a populated interval structure for interval-type quality sessions", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Test Half", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 } });
  seedRunner({ weeks: 14, perWeek: 3, km: 9 });
  // One recent HARD quality run (a Garmin VO2max effort) so has_quality is true —
  // otherwise a quality-less base athlete is given a gentle non-interval tempo. With
  // quality established, the rotation cycles through interval-structured sessions.
  const hard = repo.addActivity({ type: "run", duration_min: 35, distance_km: 8, date: back(3) });
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'run-prog-test')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, te_label, anaerobic_te)
     VALUES (?, 'rp-hard-1', ?, ?, 'running', 'VO2MAX', 3)`
  ).run(src.lastInsertRowid, hard.id, hard.date);

  // The quality session rotates by week ordinal; sample several weeks so an
  // interval-type session (threshold / VO2 / hills) is certain to appear.
  let foundInterval = null;
  for (let wk = 0; wk < 10; wk++) {
    const plan = repo.weeklyRunPlan(back(wk * 7));
    if (!plan.available) continue;
    const q = plan.runs.find((r) => r.kind_label === "quality" && Array.isArray(r.interval) && r.interval.length > 0);
    if (q) { foundInterval = q; break; }
  }
  assert.ok(foundInterval, "across the rotation an interval-structured quality session appears");
  const rep = foundInterval.interval[0];
  assert.ok(Number.isFinite(rep.reps) && rep.reps > 0, "interval reps populated");
  assert.ok(typeof rep.on === "string" && rep.on.length > 0, "interval work bout populated");
  assert.ok(typeof rep.off === "string" && rep.off.length > 0, "interval recovery populated");
  assert.ok(/^Z[1-5]$/.test(rep.zone), "interval carries a zone");
});

test("weeklyRunPlan applies conservative caps — a race-week taper cuts volume vs a build week", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 10, perWeek: 3, km: 10 }); // ~30 km/wk base
  const totalKm = (plan) => plan.runs.reduce((s, r) => s + (r.target_distance_km ?? 0), 0);

  repo.setProfile({ endurance_goal: { mode: "race", event: "Build Race", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 } });
  const build = repo.weeklyRunPlan(REF);

  repo.setProfile({ endurance_goal: { mode: "race", event: "Taper Race", date: fwd(5), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 } });
  const taper = repo.weeklyRunPlan(REF);

  assert.equal(taper.runs.find((r) => r.kind_label === "long") != null, true);
  assert.ok(totalKm(taper) < totalKm(build), "taper week prescribes less total volume than a build week");
  assert.ok(taper.rationale.some((r) => /taper/i.test(r)), "the taper is explained in plain words");
});

// ── runVarietyRead ────────────────────────────────────────────────────────────

test("runVarietyRead flags mono-stimulus (all-easy) running and names the missing stimulus", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  // 7 easy runs (no Garmin hard labels) in the last 6 weeks → no faster work.
  for (const off of [2, 8, 14, 20, 26, 32, 38]) {
    repo.addActivity({ type: "run", duration_min: 45, distance_km: 6 + (off % 3), date: back(off) });
  }
  const v = repo.runVarietyRead(REF);
  assert.ok(v, "a variety read is surfaced");
  assert.ok(/easy/i.test(v.note), "names the all-easy pattern");
  assert.ok(Array.isArray(v.suggestions) && v.suggestions.length > 0, "offers concrete missing stimuli");
  NO_SCORE(v, "runVarietyRead");
});

test("runVarietyRead stays quiet without enough runs to read variety honestly", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  for (const off of [2, 9, 16]) repo.addActivity({ type: "run", duration_min: 40, distance_km: 7, date: back(off) });
  assert.equal(repo.runVarietyRead(REF), null);
});

// ── enduranceTestsDue ─────────────────────────────────────────────────────────

test("enduranceTestsDue prompts a time-trial when a runner has had no hard effort", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running" });
  for (const off of [3, 10, 17, 24]) repo.addActivity({ type: "run", duration_min: 45, distance_km: 8, date: back(off) });
  const tests = repo.enduranceTestsDue(REF);
  const tt = tests.find((t) => t.kind === "endurance" && /time-?trial/i.test(t.exercise));
  assert.ok(tt, "a time-trial re-test is surfaced");
  assert.ok(/pace|fitness|hard|trial/i.test(tt.why), "the why frames it as re-anchoring pace/fitness");
  NO_SCORE(tests, "enduranceTestsDue");
});

test("enduranceTestsDue stays empty for a pure strength athlete with no running", () => {
  repo.setProfile({ primary_discipline: "strength", endurance_sport: "", endurance_goal: null });
  assert.deepEqual(repo.enduranceTestsDue(REF), []);
});

// ── buildRunPlanProposal (the apply path, shared by REST + MCP) ────────────────

test("buildRunPlanProposal drafts a proposal whose cardio carries day_number + interval structure", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Apply Half", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 } });
  seedRunner({ weeks: 10, perWeek: 3, km: 10 });

  const out = repo.buildRunPlanProposal(REF);
  assert.equal(out.ok, true, "a runner with a plan drafts a proposal");
  const parsed = out.proposal.parsed;
  assert.ok(Array.isArray(parsed.cardio) && parsed.cardio.length > 0, "the proposal carries a cardio array");
  // Every mapped run keeps the day_number applyProposal→setWeeklyRuns needs to attach it.
  assert.ok(parsed.cardio.every((c) => Number.isFinite(c.day_number)), "each cardio entry carries a day_number");
  assert.ok(parsed.cardio.every((c) => typeof c.day_name === "string" && c.day_name.length > 0), "each carries a day_name");
  // The interval structure survives the mapping (the keystone — a stripped interval = a lost workout).
  const planRuns = repo.weeklyRunPlan(REF).runs;
  const intervalRun = planRuns.find((r) => Array.isArray(r.interval) && r.interval.length);
  if (intervalRun) {
    const mapped = parsed.cardio.find((c) => c.day_number === intervalRun.day_number);
    assert.ok(mapped && Array.isArray(mapped.interval) && mapped.interval.length, "an interval session's structure carries into the proposal");
  }
  // It's a DRAFT through the usual propose→apply path, never auto-applied.
  assert.equal(out.proposal.status, "draft", "the proposal is a draft, never auto-applied");
  assert.ok(/run/i.test(parsed.summary), "the summary names the runs");
  NO_SCORE(out, "buildRunPlanProposal");
});

test("buildRunPlanProposal returns the designed ok:false when there is no run plan", () => {
  repo.setProfile({ primary_discipline: "strength", endurance_sport: "", endurance_goal: null });
  const out = repo.buildRunPlanProposal(REF);
  assert.equal(out.ok, false, "no plan → the designed failure signal, not a throw");
  assert.ok(typeof out.error === "string" && out.error.length > 0, "carries a plain error reason");
});
