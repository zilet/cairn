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
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import {
  LEG_LOAD_LONG_DEFER_VARIANTS,
  LEG_LOAD_PLACEMENT_VARIANTS,
  LEG_LOAD_PULL_DEFER_VARIANTS,
  STRENGTH_PEAK_PULL_DEFER_VARIANTS,
} from "../dist/repo/run-progression.js";

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
    "plan_proposals",
    "app_state",
    "bodyweight_log",
    "profile"
  );
}

// Seed a runner with `weeks` weeks of easy running, `perWeek` runs/wk at `km` each.
// `from` is the day the history runs BACK from — REF unless a test needs to read the
// plan on some other morning and see the same runner.
function seedRunner({ weeks = 10, perWeek = 3, km = 9, from = REF } = {}) {
  const before = (n) => new Date(new Date(from + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < weeks; wk++) {
    const offsets = [1, 3, 5].slice(0, perWeek);
    for (const off of offsets) {
      repo.addActivity({ type: "run", duration_min: Math.round(km * 6), distance_km: km, date: before(wk * 7 + off) });
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

test("weeklyRunPlan stays quiet for cycling-only history", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "cycling", endurance_goal: null });
  for (const off of [2, 9, 16, 23]) {
    repo.addActivity({ type: "mountain_biking", duration_min: 75, distance_km: 25, date: back(off) });
  }
  const plan = repo.weeklyRunPlan(REF);
  assert.equal(plan.available, false);
  assert.deepEqual(plan.runs, []);
});

test("weeklyRunPlan still plans for a configured runner with no goal and no mileage logged this week", () => {
  // endurance_sport configured to running, but no formal endurance goal AND
  // nothing logged in the trailing week (e.g. a Monday before the first run) —
  // configuration alone must still supply running intent, not just a goal or
  // recent km. Prior mileage sits well outside the compliance/base windows.
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running", endurance_goal: null });
  for (const off of [30, 37, 44, 51, 58]) {
    repo.addActivity({ type: "run", duration_min: 50, distance_km: 8, date: back(off) });
  }
  const plan = repo.weeklyRunPlan(REF);
  assert.equal(plan.available, true, "a configured runner still gets a plan with no goal and a quiet week");
  assert.ok(plan.runs.length > 0, "the plan carries real runs, not the NO_RUN_PLAN shape");
});

test("weeklyRunPlan anchors mixed run and MTB history to running only", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running, MTB" });
  repo.addActivity({ type: "run", duration_min: 50, distance_km: 10, date: back(1) });
  repo.addActivity({ type: "mountain_biking", duration_min: 120, distance_km: 40, date: back(1) });
  const plan = repo.weeklyRunPlan(REF);
  const total = plan.runs.reduce((sum, run) => sum + Number(run.target_distance_km || 0), 0);
  assert.equal(plan.available, true);
  assert.ok(total <= 12, `run plan should build from ~10 running km, not 50 mixed km (got ${total})`);
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

test("weeklyRunPlan keeps recovery-week frequency as easy Z2 continuation without quality work", () => {
  repo.setProfile({ age: 40, primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 8 });
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: [],
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: back(2), proposal_id: proposal.id }));

  const plan = repo.weeklyRunPlan(REF);
  assert.equal(plan.available, true);
  assert.ok(plan.runs.length >= 2, "the recovery week retains running frequency");
  assert.ok(plan.runs.every((run) => run.kind_label !== "quality"), "quality work is removed during the deload");
  assert.ok(plan.runs.every((run) => /Z2|easy/i.test(String(run.target_zone))), "every continuation stays easy Z2");
  assert.match(plan.rationale.join(" "), /recovery week|easy Z2/i);
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

// ── weeklyRunPlan: PART 1 readiness/status gating + PART 3 directive shaping ──────

// A getRecoverySummary-shaped object with a chosen readiness band / training status,
// so the gating logic can be driven without wall-clock-anchored metric seeding.
function recoveryFixture({ band = "steady", readinessFresh = "fresh", status = null, statusFresh = "fresh" } = {}) {
  const tr = band === "low" ? 22 : band === "primed" ? 82 : 50;
  return {
    days: 14,
    has_data: true,
    sources: ["garmin"],
    recovery: {
      avg_training_readiness: tr,
      training_readiness: tr,
      readiness_band: band,
      training_status: status,
      acute_load: null,
    },
    quality: {
      training_readiness: { latest_value: tr, latest_date: REF, source: "garmin", sample_count: 5, window_days: 14, freshness: readinessFresh },
      training_status: { latest_value: status, latest_date: REF, source: "garmin", sample_count: 5, window_days: 14, freshness: statusFresh },
    },
    delta: { hrv: null, rhr: null, sleep: null },
    recent: { sleep: null, hrv: null, rhr: null },
    baseline: { sleep: null, hrv: null, rhr: null },
  };
}

const totalRunKm = (plan) => plan.runs.reduce((s, r) => s + (r.target_distance_km ?? 0), 0);

test("weeklyRunPlan eases volume + drops quality when fresh readiness is clearly LOW", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 }); // ~36 km base
  const steady = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "steady" }) });
  const low = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "low" }) });
  assert.ok(steady.available && low.available);
  assert.equal(low.quality_focus, null, "no hard session while readiness reads low");
  assert.ok(totalRunKm(low) < totalRunKm(steady), `low readiness eases volume (${totalRunKm(low)} < ${totalRunKm(steady)})`);
  assert.ok(low.rationale.some((r) => /readiness/i.test(r)), "the readiness ease is explained in plain words");
  NO_SCORE(low, "run plan low readiness"); // banded words only — never the 0-100 number
});

test("weeklyRunPlan ignores a STALE low readiness (staleness never gates)", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const steady = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "steady" }) });
  const staleLow = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "low", readinessFresh: "stale" }) });
  assert.equal(totalRunKm(staleLow), totalRunKm(steady), "a stale low readiness changes nothing");
  assert.equal(staleLow.quality_focus, steady.quality_focus);
});

test("weeklyRunPlan eases volume on a fresh STRAINED training status", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const steady = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ status: "PRODUCTIVE" }) });
  const strained = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ status: "STRAINED" }) });
  assert.ok(totalRunKm(strained) < totalRunKm(steady), "a strained status eases the week");
  assert.equal(strained.quality_focus, null);
  assert.ok(strained.rationale.some((r) => /strained/i.test(r)));
  NO_SCORE(strained, "run plan strained status");
});

// A firm anemia directive (real ledger shape): a "+"-joined marker label + a citation.
const ANEMIA_DIRECTIVE = {
  domain: "training",
  marker: "low ferritin+low hemoglobin+low MCV",
  directive: "While this anemia pattern is present, hold endurance volume and keep easy days genuinely easy.",
  citation: "IOC consensus on iron in athletes",
  uncertain: false,
};

test("a FIRM endurance-limiting directive caps volume + drops quality, cited in plain words", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [] });
  const held = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [ANEMIA_DIRECTIVE] });
  assert.ok(base.available && held.available);
  assert.notEqual(base.quality_focus, null, "the base week has a quality session to drop");
  assert.equal(held.quality_focus, null, "a firm hold drops the quality session");
  assert.ok(totalRunKm(held) < totalRunKm(base), `a firm hold caps the build (${totalRunKm(held)} < ${totalRunKm(base)})`);
  assert.match(held.why + " " + held.rationale.join(" "), /iron|hemoglobin|volume/i);
  assert.ok(held.runs.every((r) => r.kind_label !== "quality"), "no quality run remains");
  NO_SCORE(held, "firm hold plan");
});

test("an UNCERTAIN endurance-limiting directive drops quality but LEAVES volume", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [] });
  const soft = repo.weeklyRunPlan(REF, {
    block: { week_index: 1 },
    directives: [{ domain: "training", marker: "Ferritin", directive: "Ease running while ferritin recovers.", uncertain: true, citation: null }],
  });
  assert.equal(soft.quality_focus, null, "quality is suppressed even for an uncertain hold");
  assert.ok(Math.abs(totalRunKm(soft) - totalRunKm(base)) < 3, "but the weekly volume is left where it was");
});

test("a CV pro-aerobic directive (encourages aerobic work) does NOT suppress the run plan", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [] });
  const withCv = repo.weeklyRunPlan(REF, {
    block: { week_index: 1 },
    directives: [{ domain: "training", marker: "ApoB+LDL Cholesterol", directive: "Keep regular aerobic work in the week — it helps the whole cardiovascular cluster at once.", uncertain: true, citation: "ACC/AHA 2018" }],
  });
  assert.equal(withCv.quality_focus, base.quality_focus, "a pro-aerobic nudge leaves the quality session intact");
  assert.equal(totalRunKm(withCv), totalRunKm(base), "and leaves the volume unchanged");
});

test("weeklyRunPlan consumes an active anemia directive from the ledger (listActiveDirectives path)", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  repo.addDirective({
    source: "markers",
    domain: "training",
    marker: "low ferritin+low hemoglobin+low MCV",
    directive: "While this anemia pattern is present, hold endurance volume and keep easy days genuinely easy.",
    citation: "IOC consensus on iron in athletes",
    uncertain: false,
    status: "active",
  });
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } }); // no injected directives — reads the ledger
  assert.equal(plan.quality_focus, null);
  assert.match(plan.rationale.join(" "), /iron|hemoglobin/i);
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

test("enduranceTestsDue never prescribes running tests from cycling-only history", () => {
  repo.setProfile({ primary_discipline: "endurance", endurance_sport: "cycling", endurance_goal: null });
  for (const off of [3, 10, 17, 24]) {
    repo.addActivity({ type: "cycling", duration_min: 60, distance_km: 25, date: back(off) });
  }
  assert.deepEqual(repo.enduranceTestsDue(REF), []);
});

// ── weeklyRunPlan: the learned run-volume personal modifier ───────────────────

// A learned CONSERVATIVE run-volume default (the shape whatWorksForYou emits for a
// missed run_volume_adherence expectation): scale < 1, inside the declared 0.9–1.05
// band — both ends of which the model can actually produce.
const RUN_MODIFIER_EASE = {
  key: "training_target:run_volume_adherence:all:complete:all-phases",
  target: "run_volume_step",
  stage: null,
  scale: 0.9,
  bounds: { min: 0.9, max: 1.05 },
  confidence: "observed",
  evidence_n: 3,
  rationale: "a slightly more conservative run volume step is the earned default",
  never_overrides: ["injury", "allergy", "clinical", "lean_safe"],
};

// The mirror image: what the model emits after a sustained run of absorbed weeks with
// nothing missed and no symptom on record. Capped at 1.05 — the slowest lever there is.
const RUN_MODIFIER_ACCELERATE = { ...RUN_MODIFIER_EASE, scale: 1.05, rationale: "a slightly larger run volume step is the earned default" };

test("weeklyRunPlan: a learned conservative run-volume modifier eases the weekly build", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: null });
  const eased = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: RUN_MODIFIER_EASE });
  assert.ok(totalRunKm(eased) < totalRunKm(base), `the modifier eases volume (${totalRunKm(eased)} < ${totalRunKm(base)})`);
  assert.ok(eased.rationale.some((r) => /conservative volume step|easing the weekly build/i.test(r)), "the ease is explained in plain words");
  NO_SCORE(eased, "run plan eased by modifier");
});

test("weeklyRunPlan: an aligned (scale 1) run-volume modifier changes nothing", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: null });
  const aligned = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: { ...RUN_MODIFIER_EASE, scale: 1 } });
  assert.equal(totalRunKm(aligned), totalRunKm(base), "a met expectation holds the standard build, never accelerates it");
});

test("weeklyRunPlan: the run-volume modifier never exceeds the recovery/directive caps (they stay final)", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  // Recovery-down: an easing modifier can only ease FURTHER, never push the recovery-
  // reduced volume back up.
  const recDown = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "low" }), responseModifier: null });
  const recDownMod = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "low" }), responseModifier: RUN_MODIFIER_EASE });
  assert.ok(totalRunKm(recDownMod) <= totalRunKm(recDown), "the modifier never lifts a recovery-reduced week");
  // A firm anemia directive caps the build; the directive stays the outermost word, so
  // the eased plan lands at or below the (non-modified) firm-hold plan.
  const held = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [ANEMIA_DIRECTIVE], responseModifier: null });
  const heldMod = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [ANEMIA_DIRECTIVE], responseModifier: RUN_MODIFIER_EASE });
  assert.ok(totalRunKm(heldMod) <= totalRunKm(held), "the modifier never exceeds the directive cap");
});

test("weeklyRunPlan: an earned run-volume acceleration lifts an ordinary build week", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: null });
  const accelerated = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: RUN_MODIFIER_ACCELERATE });
  assert.ok(
    totalRunKm(accelerated) > totalRunKm(base),
    `a scale above 1 is honored, not discarded (${totalRunKm(accelerated)} > ${totalRunKm(base)})`
  );
  assert.ok(
    accelerated.rationale.some((r) => /nudging the weekly build up|absorbing the prescribed mileage/i.test(r)),
    "the acceleration is explained in plain words"
  );
  NO_SCORE(accelerated, "run plan accelerated by modifier");
});

test("weeklyRunPlan: an accelerated build stays inside one conservative weekly step", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });
  const base = totalRunKm(repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: null }));
  const accelerated = totalRunKm(
    repo.weeklyRunPlan(REF, { block: { week_index: 1 }, responseModifier: RUN_MODIFIER_ACCELERATE })
  );
  // The standard build is ~1.1; the ceiling is 1.12, so the most an acceleration can
  // add is ~1.8% on top of the ordinary week — mileage is capped tighter than the
  // composed levers ask for. A little slack absorbs km rounding.
  assert.ok(accelerated / base <= 1.05, `the ceiling holds (${accelerated} vs ${base})`);
});

test("weeklyRunPlan: an acceleration never overrides a protective week", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 12 });

  // Recovery-down: the week is already being protected, so the learned default is mute.
  const recDown = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "low" }), responseModifier: null });
  const recDownAccel = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, recovery: recoveryFixture({ band: "low" }), responseModifier: RUN_MODIFIER_ACCELERATE });
  assert.equal(totalRunKm(recDownAccel), totalRunKm(recDown), "a recovery-down week is untouchable");

  // A scheduled down week is a deliberate reset, not headroom.
  const downWeek = repo.weeklyRunPlan(REF, { block: { week_index: 4 }, responseModifier: null });
  const downWeekAccel = repo.weeklyRunPlan(REF, { block: { week_index: 4 }, responseModifier: RUN_MODIFIER_ACCELERATE });
  assert.equal(totalRunKm(downWeekAccel), totalRunKm(downWeek), "a scheduled down week is untouchable");

  // And a firm endurance-limiting health flag stays the outermost word.
  const held = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [ANEMIA_DIRECTIVE], responseModifier: null });
  const heldAccel = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, directives: [ANEMIA_DIRECTIVE], responseModifier: RUN_MODIFIER_ACCELERATE });
  assert.equal(totalRunKm(heldAccel), totalRunKm(held), "a health flag is never accelerated past");
});

// ── the OTHER direction of the hybrid read: lifting fatigue reaches the run week ─
//
// Endurance load has always reached strength decisions in real time. The reverse was
// a static calendar lookup (the plan's fixed leg-day weekday slots), so the long run
// could be sized and placed with no idea what the last lower-body session left behind.

// The composite shape strengthLegLoad emits after a real lower-body session: one prime
// mover at the full-session bar plus a second still carrying work.
const LEGS_SATURATED = {
  band: "saturated",
  saturated: true,
  saturated_groups: ["quads"],
  loaded_groups: ["glutes"],
  has_data: true,
};

function seedRacingRunner(from = REF) {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Test Half", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 },
  });
  seedRunner({ weeks: 10, perWeek: 3, km: 10, from });
}

const longKm = (plan) => plan.runs.find((r) => r.kind_label === "long")?.target_distance_km ?? null;
const said = (plan) => `${plan.why} ${plan.rationale.join(" ")}`;

test("saturated lower-body lifting defers the long-run floor-raise AND the race pull", () => {
  seedRacingRunner();
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  const held = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: LEGS_SATURATED });

  assert.ok(base.available && held.available);
  // The race pull is what lifts an ordinary build past its usual ~10% step.
  assert.match(said(base), /biggest step that still sits inside a safe build/i, "the base week takes the race pull");
  assert.doesNotMatch(said(held), /biggest step that still sits inside a safe build/i, "the pull is withheld");
  assert.ok(totalRunKm(held) <= totalRunKm(base), `the deferred week is never the bigger one (${totalRunKm(held)} vs ${totalRunKm(base)})`);

  // …and the demonstrated-long FLOOR-RAISE waits with it.
  assert.ok(longKm(held) < longKm(base), `the long run is not stepped up (${longKm(held)} < ${longKm(base)})`);

  // Both deferrals are said out loud, in plain words that name the legs, not a metric.
  assert.match(said(held), /quads/i, "the sentence names the muscles carrying the work");
  assert.doesNotMatch(said(held), /residual|saturat|acwr|band/i, "no engineering vocabulary reaches the athlete");
  NO_SCORE(held, "leg-load deferred plan");
});

test("the leg-load deferral rotates its wording rather than printing one literal", () => {
  seedRacingRunner();
  const words = new Set();
  for (let i = 0; i < 4; i++) {
    const plan = repo.weeklyRunPlan(back(i * 7), { block: { week_index: 1 }, legLoad: LEGS_SATURATED });
    words.add(plan.rationale.find((r) => /quads/i.test(r)) ?? "");
  }
  assert.ok(words.size > 1, "a state that holds for weeks does not print the same sentence every week");
});

test("with no lower-body lifting behind it, the run week is byte-for-byte what it always was", () => {
  // Absence is NEUTRAL: a runner who never lifts must get exactly the plan they got
  // before this read existed — the derived path and an explicitly-empty one agree.
  seedRacingRunner();
  const derived = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const absent = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  assert.deepEqual(derived, absent, "no leg residual → nothing changes");
  assert.match(said(derived), /biggest step that still sits inside a safe build/i, "and the race pull still fires");
});

// A genuine leg day: squats + RDLs, enough to saturate the prime movers.
function logLegDay(date) {
  for (let i = 0; i < 4; i++) repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  for (let i = 0; i < 3; i++) repo.logSetByName({ exercise: "Romanian Deadlift", weight: 185, reps: 8, rir: 2, date });
}

// REF is a Monday, and with no lower-body PLAN days the long run defaults to slot 6
// — Saturday of REF's week. FRIDAY is the morning before it lands.
const FRIDAY = fwd(4);

test("real logged lower-body work reaches the run builder with no injection", () => {
  // Read on the Friday, so the leg day that same day genuinely has not cleared by
  // the time Saturday's long run lands.
  seedRacingRunner(FRIDAY);
  const before = repo.weeklyRunPlan(FRIDAY, { block: { week_index: 1 } });
  logLegDay(FRIDAY);
  const after = repo.weeklyRunPlan(FRIDAY, { block: { week_index: 1 } });
  assert.doesNotMatch(said(after), /biggest step that still sits inside a safe build/i, "the pull defers off real logged sets");
  assert.ok(longKm(after) < longKm(before), "and so does the long-run raise");
});

// The residual decays continuously and the saturated band has an edge, so a Monday
// leg day used to read saturated on Monday and Tuesday, fresh on Wednesday, and the
// SAME week's long run therefore changed size depending on which morning the athlete
// opened the app. The size decisions now read the legs at the day the long run
// actually lands, so a Monday leg day is several half-lives away from it.
test("a leg day early in the week does not shrink a long run five days later", () => {
  seedRacingRunner(FRIDAY);
  const before = repo.weeklyRunPlan(FRIDAY, { block: { week_index: 1 } });
  logLegDay(REF); // Monday
  const after = repo.weeklyRunPlan(FRIDAY, { block: { week_index: 1 } });
  assert.equal(longKm(after), longKm(before), "Monday's lifting has cleared by Saturday");
  assert.match(said(after), /biggest step that still sits inside a safe build/i, "and the race pull is not withheld");
});

// Does a leg day still hold the long run? The wording rotates, so ask the decision.
const legLoadDeferred = (plan) =>
  /still carrying your recent lifting|haven't let go of the lifting|haven't cleared the weights|still working through the weights|is still in your|still working through your lifting/i.test(
    said(plan)
  );

// The one that broke: quads decay on a 60-hour half-life, so a Monday leg day sat
// saturated Monday and Tuesday, cleared Wednesday, and saturated again after
// Thursday's session — and since the week is rebuilt on every read, the SAME week's
// long run changed size between Tuesday and Wednesday with nothing logged.
//
// Framed as a DELTA against the same morning with no lifting behind it, because the
// running side has its own trailing windows that legitimately move day to day (the
// four-week longest, the endurance state). What must not move is the LIFTING's
// effect on the week, and that is what each pair below isolates.
test("a Monday leg day changes the week the same way — none at all — on Tuesday and on Wednesday", () => {
  seedRacingRunner();
  const opts = { block: { week_index: 1 }, volumeAnchorDate: REF };
  const tuesdayAlone = repo.weeklyRunPlan(fwd(1), opts);
  const wednesdayAlone = repo.weeklyRunPlan(fwd(2), opts);

  logLegDay(REF); // Monday — the day that used to flicker the band beneath the week
  const tuesday = repo.weeklyRunPlan(fwd(1), opts);
  const wednesday = repo.weeklyRunPlan(fwd(2), opts);

  assert.equal(longKm(tuesday), longKm(tuesdayAlone), "Tuesday: Monday's lifting does not shrink Saturday's long run");
  assert.equal(longKm(wednesday), longKm(wednesdayAlone), "Wednesday: nor does it on the other side of the band edge");
  assert.equal(totalRunKm(tuesday), totalRunKm(tuesdayAlone), "and the week is not resized either");
  assert.equal(totalRunKm(wednesday), totalRunKm(wednesdayAlone));
  // The deferral is a decision about the WEEK, so it is taken (or not) the same way
  // on both mornings.
  assert.equal(legLoadDeferred(tuesday), legLoadDeferred(wednesday), "the same week defers, or does not, on both days");
  assert.equal(legLoadDeferred(tuesday), false, "and with the long run five days out, it does not");
});

test("the long-run day is what the size read is anchored on, not the read date", () => {
  // The same leg day, asked about from four different mornings of the same week: the
  // answer cannot move, because the day it is about has not moved.
  seedRacingRunner();
  const opts = { block: { week_index: 1 }, volumeAnchorDate: REF };
  const mornings = [REF, fwd(1), fwd(2), fwd(3)];
  const alone = mornings.map((day) => longKm(repo.weeklyRunPlan(day, opts)));
  logLegDay(REF);
  const withLegDay = mornings.map((day) => repo.weeklyRunPlan(day, opts));
  assert.deepEqual(withLegDay.map(longKm), alone, "the long run is untouched from every morning of the week");
  assert.deepEqual(
    withLegDay.map(legLoadDeferred),
    [false, false, false, false],
    "and no morning of the week defers on its account"
  );
});

test("a runner's OWN mileage never counts as a reason to defer their build", () => {
  // The run builder already sees its own lane (the volume anchor, the endurance ACWR,
  // the recovery gates). Folding running back in as leg fatigue would defer every
  // build week a runner ever earns — so the read is strength-sourced by design.
  seedRacingRunner();
  repo.addActivity({ type: "run", duration_min: 110, distance_km: 18, date: back(1) }); // a big long run yesterday
  const derived = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const absent = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  assert.deepEqual(derived, absent, "a long run yesterday leaves the leg-load path silent");
  assert.doesNotMatch(said(derived), /lifting|weights/i, "nothing is deferred on account of the athlete's own running");
});

test("a strength block at its peak suppresses the race pull exactly as a taper does", () => {
  seedRacingRunner();
  const ordinary = repo.weeklyRunPlan(REF, { block: { week_index: 1, phase: "accumulation" } });
  const peak = repo.weeklyRunPlan(REF, { block: { week_index: 1, phase: "realization" } });
  const heaviest = repo.weeklyRunPlan(REF, { block: { week_index: 1, phase: "intensification" } });

  assert.match(said(ordinary), /biggest step that still sits inside a safe build/i);
  for (const [label, plan] of [["realization", peak], ["intensification", heaviest]]) {
    assert.doesNotMatch(said(plan), /biggest step that still sits inside a safe build/i, `${label} withholds the pull`);
    assert.ok(totalRunKm(plan) <= totalRunKm(ordinary), `${label} never asks for more (${totalRunKm(plan)})`);
    // The BASE plan is untouched — only the extra stretch is withheld.
    assert.equal(plan.runs.length, ordinary.runs.length, `${label} keeps the same runs`);
    assert.equal(plan.quality_focus, ordinary.quality_focus, `${label} keeps the quality session`);
    assert.match(said(plan), /lifting|strength/i, `${label} says why in plain words`);
    NO_SCORE(plan, `run plan under a ${label} block`);
  }
});

test("the hard running moves off the front of the week when the legs open it loaded from lifting", () => {
  seedRacingRunner();
  const base = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  const held = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: LEGS_SATURATED });
  const qualityDay = (plan) => plan.runs.find((r) => r.kind_label === "quality")?.day_number ?? null;
  assert.equal(qualityDay(base), 2, "the static placement puts quality mid-week");
  assert.ok(qualityDay(held) > qualityDay(base), `the quality run sits further down the week (${qualityDay(held)})`);
  // Placement only ever moves WHICH day — never how many runs there are.
  assert.equal(held.runs.length, base.runs.length);
  assert.equal(new Set(held.runs.map((r) => r.day_number)).size, held.runs.length, "no two runs collide on a day");
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

// ── the weekly cadence is the wrong home for a long-horizon claim ─────────────

test("applying a weekly run plan writes no eight-week aerobic expectation", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Apply Half", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 } });
  seedRunner({ weeks: 10, perWeek: 3, km: 10 });
  // A watch that IS reporting VO2max, so nothing here is silent merely for want of data.
  for (const off of [3, 10, 17]) {
    db.prepare(`INSERT INTO daily_metrics (source, date, vo2max, updated_at) VALUES ('apple', ?, ?, datetime('now'))`).run(back(off), 50);
  }

  const out = repo.buildRunPlanProposal(REF);
  assert.equal(out.ok, true);
  assert.equal(repo.applyProposal(out.proposal.id).ok, true);

  const written = db.prepare(`SELECT metric_key, COUNT(*) AS n FROM brain_expectations GROUP BY metric_key`).all();
  const byMetric = new Map(written.map((row) => [row.metric_key, row.n]));
  assert.ok(byMetric.get("run_volume_adherence") > 0, "the weekly claim the run plan CAN make is still written");
  assert.equal(
    byMetric.get("vo2max_trend"),
    undefined,
    "an eight-week aerobic trend is never attached to a decision that is remade every week"
  );
});

// ── the reading grammar, over the leg-load vocabulary ─────────────────────────
// Every sentence the hybrid read can put in front of the athlete, rendered with the
// arguments it is actually called with, held to the same line as the rest.

test("every leg-load phrasing holds the reading grammar", () => {
  const phrases = ["your quads", "your quads and glutes", "your quads, hamstrings and glutes", "your legs"];
  const rendered = [];
  for (const phrase of phrases) {
    for (const say of [
      ...LEG_LOAD_LONG_DEFER_VARIANTS,
      ...LEG_LOAD_PULL_DEFER_VARIANTS,
      ...LEG_LOAD_PLACEMENT_VARIANTS,
    ]) {
      rendered.push(say(phrase));
    }
  }
  // The strength-peak line names the BLOCK's phase, not a muscle.
  for (const phase of ["peak", "heaviest"]) {
    for (const say of STRENGTH_PEAK_PULL_DEFER_VARIANTS) rendered.push(say(phase));
  }
  for (const line of rendered) assert.equal(violatesReadingGrammar(line), null, `"${line}"`);
  // No scores, and no engineering register leaking through the band names.
  for (const line of rendered) {
    assert.doesNotMatch(line, /residual|saturat|acwr|\bband\b|half-life/i, `"${line}"`);
  }
});

test("each leg-load set is a variant SET, with no duplicate phrasings", () => {
  const sets = [
    ["LEG_LOAD_LONG_DEFER", LEG_LOAD_LONG_DEFER_VARIANTS, "your quads and glutes"],
    ["LEG_LOAD_PULL_DEFER", LEG_LOAD_PULL_DEFER_VARIANTS, "your quads and glutes"],
    ["LEG_LOAD_PLACEMENT", LEG_LOAD_PLACEMENT_VARIANTS, "your quads and glutes"],
    ["STRENGTH_PEAK_PULL_DEFER", STRENGTH_PEAK_PULL_DEFER_VARIANTS, "peak"],
  ];
  for (const [label, set, arg] of sets) {
    assert.ok(set.length >= 3, `${label}: a set, never one literal printed for weeks`);
    const rendered = set.map((say) => say(arg));
    assert.equal(new Set(rendered).size, rendered.length, `${label}: no duplicate phrasings`);
  }
});
