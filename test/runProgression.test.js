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
import { localDateISO } from "../dist/repo/shared.js";
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

function garminSource() {
  const existing = db.prepare(`SELECT id FROM garmin_sources LIMIT 1`).get();
  if (existing) return existing.id;
  return Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'run-zone-rhr')`).run().lastInsertRowid
  );
}

test("runZones ignores a stale Garmin resting HR and does not Karvonen from it", () => {
  const src = garminSource();
  const today = localDateISO();
  const stale = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 864e5).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, resting_hr) VALUES (?, ?, ?)`).run(src, stale, 48);
  const z = repo.runZones({ profile: { age: 40 } });
  assert.equal(z.available, true);
  assert.equal(z.reserve, false, "a 10-day-old night is absent, so zones stay %HRmax");
  assert.equal(z.rest_hr, null);
  assert.doesNotMatch(z.note, /resting HR/i);
});

test("runZones still Karvonens from a current Garmin resting HR", () => {
  const src = garminSource();
  const today = localDateISO();
  const fresh = new Date(Date.parse(`${today}T00:00:00Z`) - 1 * 864e5).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, resting_hr) VALUES (?, ?, ?)`).run(src, fresh, 52);
  const z = repo.runZones({ profile: { age: 40 } });
  assert.equal(z.available, true);
  assert.equal(z.reserve, true);
  assert.equal(z.rest_hr, 52);
  assert.match(z.note, /resting HR 52/);
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

// ── the two layers must agree about the SAME directive on the SAME morning ────
//
// The run builder honored an active endurance-hold directive and capped the week, and
// the day-planning signal state had no directive input at all — so on the very morning
// the plan was holding the running back, the Brief could resolve `push_bias` and offer
// the athlete room the week had already denied. Two layers, one athlete, opposite
// answers, both citing "the connected brain".

// A plan day plus two strongly-rated sessions: the ONLY thing that earns the backed
// tier, and it is earned from the training log alone (no wearable anywhere).
function seedBackedLifter() {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const day = repo.getPlanDay(1);
  const ex = repo.findExercise("Squat") ?? repo.upsertExercise({ name: "Squat", muscle_group: "quads" });
  for (const off of [4, 2]) {
    const session = repo.getOrCreateSession(back(off), day.id);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 185, 8, 2)`
    ).run(session.id, ex.id);
    repo.setSessionFeedback(back(off), { performance: 5 });
  }
}

test("an active endurance hold caps the week AND closes the same morning's push", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  // The running history ends a week back, deliberately: a run inside the last few days
  // raises its OWN interference caution, and a morning already braked cannot show that
  // the directive is what closed the push. The base is still a real runner's base.
  seedRunner({ weeks: 8, perWeek: 3, km: 12, from: back(6) });
  seedBackedLifter();

  // Before the directive: the week carries a quality session and the morning offers
  // the reach. Both halves of the baseline matter — without them the assertions below
  // would pass on a fixture that never had anything to take away.
  const openPlan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const openRead = repo.dayRead(REF);
  assert.notEqual(openPlan.quality_focus, null, "the base week has a quality session to drop");
  assert.ok(openRead.signals.push_bias, "the base morning is one the evidence positively backs");

  repo.addDirective({
    source: "markers",
    domain: "training",
    marker: "low ferritin+low hemoglobin+low MCV",
    directive: "While this anemia pattern is present, hold endurance volume and keep easy days genuinely easy.",
    citation: "IOC consensus on iron in athletes",
    uncertain: false,
    status: "active",
  });

  const heldPlan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const heldRead = repo.dayRead(REF);

  // The week is capped, exactly as before…
  assert.equal(heldPlan.quality_focus, null);
  assert.ok(totalRunKm(heldPlan) < totalRunKm(openPlan), "the firm hold still caps the build");
  // …and now the morning agrees instead of contradicting it.
  assert.equal(heldRead.signals.push_bias, undefined, "the Brief must not offer room the week has denied");
  assert.equal(heldRead.signals.signal_state.action.support, null);

  // It arrives as a BRAKE on the dimension it touches — a watch, never a constraint,
  // so it can hold the reach back without making the day easy or rest by itself.
  const load = heldRead.signals.signal_state.dimensions.training_load_tolerance;
  assert.equal(load.status, "watch");
  const item = load.evidence.find((e) => e.field === "endurance_hold_directive");
  assert.ok(item, "the directive rides in the dimension's evidence");
  assert.equal(item.direction, "caution");
  assert.match(load.reason, /directive/i, "the machine register records the directive");
  // The read is still a suggestion: the day is not turned easy or rest by a directive.
  assert.equal(heldRead.kind, "train");
  NO_SCORE(heldRead.signals.signal_state, "signal state with an endurance hold");

  // And a directive the athlete has dismissed contributes nothing at all.
  db.prepare(`UPDATE health_directives SET status = 'dismissed'`).run();
  const dismissed = repo.dayRead(REF);
  assert.ok(dismissed.signals.push_bias, "a dismissed directive is not evidence");
  assert.equal(
    dismissed.signals.signal_state.dimensions.training_load_tolerance.evidence.some(
      (e) => e.field === "endurance_hold_directive"
    ),
    false
  );
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

// ── the long run is placed off the RING, not merely off the leg days ────────────
// Adjacency in this template is cyclic (day 7 and day 1 are neighbours), so a rule
// that only asked "is this slot itself a leg day" could put the long run on Sunday
// with a heavy Monday waiting on the other side of the seam — and the week-layout
// read then flagged the run engine's OWN choice back at the athlete as a weekly
// nudge nobody could act on. The preference is tiered: a slot with no leg day on
// either side first, a merely-free slot second, and slot 6 last.
function planLowerDay(dayNumber, name = "Lower") {
  repo.savePlanDay(dayNumber, name, "Lower", [
    { exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
}
const longDay = (plan) => plan.runs.find((r) => r.kind_label === "long")?.day_number ?? null;

test("the long run takes the slot with clear days on BOTH sides of it, not merely a free one", () => {
  seedRacingRunner();
  planLowerDay(1, "Heavy legs"); // Monday
  planLowerDay(6, "Legs"); // Saturday
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  // Candidates run [6, 5, 7, 4]. 6 is a leg day; 5 touches Saturday; 7 touches both
  // Saturday and Monday across the seam. 4 is the only slot with air on each side.
  assert.equal(longDay(plan), 4, "Thursday is the one ring-clean slot this week has");
  assert.equal(new Set(plan.runs.map((r) => r.day_number)).size, plan.runs.length, "no two runs collide on a day");
});

test("when no ring-clean slot exists the long run is placed exactly as it always was", () => {
  seedRacingRunner();
  planLowerDay(1, "Heavy legs"); // Monday
  planLowerDay(5); // Friday
  planLowerDay(6); // Saturday
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  // Every candidate touches a leg day somewhere on the ring, so the second tier — the
  // old rule, "just not a leg day itself" — decides, and it picks 7 as it always did.
  // The week-layout read will flag that Sunday/Monday pair, and it is RIGHT to: this
  // week genuinely cannot be separated. The engine does not get to talk it out of it.
  assert.equal(longDay(plan), 7, "the pre-existing fallback still owns an unseparable week");
  assert.equal(new Set(plan.runs.map((r) => r.day_number)).size, plan.runs.length, "no two runs collide on a day");
});

test("a single mid-week leg day places the long run exactly where it always went", () => {
  seedRacingRunner();
  planLowerDay(3, "Legs"); // Wednesday — nowhere near the weekend
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  const bare = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  assert.equal(longDay(plan), 6, "Saturday, the default, is ring-clean here");
  assert.equal(longDay(bare), 6, "and a week with no lifting at all is unchanged");
});

test("the freshness floor still moves the long run, and still prefers a ring-clean slot", () => {
  seedRacingRunner();
  planLowerDay(1, "Heavy legs");
  planLowerDay(6, "Legs");
  const fresh = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: null });
  const loaded = repo.weeklyRunPlan(REF, { block: { week_index: 1 }, legLoad: LEGS_SATURATED });
  // The floor (slot >= 3 under a saturated read) cannot make the placement WORSE:
  // whatever it lands on is still the best available slot at or past the floor.
  assert.ok(longDay(loaded) >= 3, `the floor is respected (${longDay(loaded)})`);
  assert.equal(longDay(fresh), 4, "and the unfloored week still takes the ring-clean slot");
  assert.equal(new Set(loaded.runs.map((r) => r.day_number)).size, loaded.runs.length, "no two runs collide on a day");
});

// ── the volume anchor belongs to the WEEK, not to the morning it's read on ───
// The trailing-7-day base used to be read at the plan date, so a week rebuilt on
// Wednesday counted its OWN Monday and Tuesday runs as base fitness: the prescription
// grew as the athlete ran it, and the shortfall it is judged against could never
// appear. BOTH halves of the anchor now read the week that has already closed — the
// trailing window ends the day before this Monday, and the actuals term reads last
// week's compliance rather than this week's. Moving only the window left the max()
// still pulling this week's kilometres in through the other door.

test("a week's prescribed volume is the same from every morning of that week", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 10 }); // ~30 km/wk, all of it BEFORE this Monday
  // programState is pinned at the week's Monday on purpose. It is a DIFFERENT input
  // from the anchor — a live physiological/load read whose "spiking" status is a
  // protective brake — and leaving it live would let that brake mask (or be mistaken
  // for) the anchor's own stability. Pinning it isolates exactly the anchor. The
  // default-path behaviour under a big mid-week block is locked in the next test.
  const opts = { block: { week_index: 1 }, programState: repo.getProgramState(REF) };
  const monday = repo.weeklyRunPlan(REF, opts);
  assert.ok(monday.available);

  // A block bigger than the whole of LAST week (30 km) run inside THIS one. Anything
  // smaller never reaches max(actuals, base) at all, so it could not have exercised
  // the ratchet even when the ratchet was there.
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: REF });
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: fwd(1) });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: fwd(2) });

  const wednesday = repo.weeklyRunPlan(fwd(2), opts);
  assert.equal(wednesday.week_start, monday.week_start, "still the same week");
  assert.equal(
    totalRunKm(wednesday),
    totalRunKm(monday),
    `the week must not chase the runs it prescribes (Mon ${totalRunKm(monday)} → Wed ${totalRunKm(wednesday)})`
  );
  assert.equal(longKm(wednesday), longKm(monday), "nor may the long run grow mid-week");
});

test("a huge mid-week block never raises the same week's ask, brake or no brake", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 10 }); // 30 km last week
  const opts = { block: { week_index: 1 } };
  const monday = repo.weeklyRunPlan(REF, opts);
  assert.ok(monday.available);

  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: REF });
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: fwd(1) });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: fwd(2) });

  // Everything live, exactly as a caller with no opts gets it. The anchor read last
  // week's actuals, so 40 logged kilometres cannot become base fitness for the week
  // they were logged in: the ask never rises. The one thing still allowed to move the
  // week from inside it is the mileage-spike brake — a protective read of NOW, not a
  // volume ledger, and it can only ever pull the week DOWN. Asserted by name, so that
  // if some other input ever starts moving the week mid-week this fails loudly.
  const wednesday = repo.weeklyRunPlan(fwd(2), opts);
  assert.equal(wednesday.week_start, monday.week_start, "still the same week");
  assert.ok(
    totalRunKm(wednesday) <= totalRunKm(monday),
    `the week must never grow from its own runs (Mon ${totalRunKm(monday)} → Wed ${totalRunKm(wednesday)})`
  );
  assert.ok(
    totalRunKm(wednesday) < 40,
    `40 km logged this week must not become this week's anchor (${totalRunKm(wednesday)})`
  );
  assert.match(said(wednesday), /mileage jumped recently/i, "the only mid-week move is the spike brake");
  // …and the same for the LONG run, which the weekly total alone does not cover. The
  // demonstrated-longest read is a third anchored input: read at the plan date it made
  // Monday's own 15 km the floor for the week it was run in, so the long run rose
  // 11.5 → 15 km on Wednesday morning while the total was being braked DOWN — the
  // week chasing itself through the mix instead of through the factor.
  assert.ok(
    longKm(wednesday) <= longKm(monday),
    `nor may the long run grow from the week's own runs (Mon ${longKm(monday)} → Wed ${longKm(wednesday)})`
  );
});

test("the race ramp cannot raise a week from inside it — a demonstrated long is a ceiling, not a pull", () => {
  seedRacingRunner(); // the race is 84 days out from this Monday: an exact number of
  // weeks, so weeks_to_race — the ramp's OTHER live input — holds constant Mon–Sun and
  // this test is measuring prevLongForRamp alone.
  const opts = { block: { week_index: 1 } };
  const monday = repo.weeklyRunPlan(REF, opts);
  assert.ok(monday.available);
  assert.match(said(monday), /stepping up a touch more/i, "the race pull is live — the door under test is open");

  // 30 km in one day: three times this athlete's demonstrated longest, so the live
  // 28-day maximum the ramp reads triples on Tuesday while the anchored one it shares
  // with prevLong does not move at all.
  repo.addActivity({ type: "run", duration_min: 180, distance_km: 30, date: REF });

  // raceRamp routes prevLongKm to required_long_km and nowhere else, and that lands in
  // the mix as an upper bound beside the anchored prevLong. So the live read can only
  // loosen a bound something anchored already binds tighter. Every remaining mid-week
  // move belongs to a protective read (the spike brake, a thin trailing window) and
  // those only ever pull down — hence <= on every morning rather than equality.
  for (let day = 1; day < 7; day += 1) {
    const later = repo.weeklyRunPlan(fwd(day), opts);
    assert.equal(later.week_start, monday.week_start, `still the same week on day ${day + 1}`);
    assert.ok(
      totalRunKm(later) <= totalRunKm(monday),
      `day ${day + 1}: the race pull must not grow the week from its own runs (Mon ${totalRunKm(monday)} → ${totalRunKm(later)})`
    );
    assert.ok(
      longKm(later) <= longKm(monday),
      `day ${day + 1}: nor may the ramp's long-run ceiling (Mon ${longKm(monday)} → ${longKm(later)})`
    );
  }
});

// ── the race countdown belongs to the week, and ticks on its rollover ───────
// weeksBetween is Math.ceil(days / 7) read at the plan date, so a race that is not a
// whole number of weeks from Monday got one week closer INSIDE the week: the ask grew
// with nothing logged. Anchoring it to the week's Monday makes the countdown a property
// of the week — which must not become a countdown that never moves at all.

const raceWeekMornings = (raceOffsetDays) => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Test Half",
      date: fwd(raceOffsetDays),
      distance_km: 21.1,
      weekly_km: 35,
      weekly_sessions: 4,
    },
  });
  seedRunner({ weeks: 10, perWeek: 3, km: 10 });
  return Array.from({ length: 7 }, (_, day) => repo.weeklyRunPlan(fwd(day), { block: { week_index: 1 } }));
};

test("a race that is not a whole number of weeks out still reads the same from every morning", () => {
  // 78 days: ceil(78/7) is 12 on Monday and 11 from Tuesday, so this offset is exactly
  // the one that used to tick mid-week — the week grew 33.3 → 33.7 km on Tuesday.
  const week = raceWeekMornings(78);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (let i = 1; i < week.length; i += 1) {
    assert.equal(
      totalRunKm(week[i]),
      totalRunKm(week[0]),
      `${days[i]}: the countdown must not move the ask (Mon ${totalRunKm(week[0])} → ${totalRunKm(week[i])})`
    );
    assert.equal(longKm(week[i]), longKm(week[0]), `${days[i]}: nor the long run`);
  }
});

test("but the countdown still advances on the Monday rollover — the anchor must not freeze it", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Test Half", date: fwd(84), distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 },
  });
  // History that ENDS the day before this Monday, plus a normal week logged inside the
  // test week — so next Monday has a real closed week to anchor on and the race pull,
  // which is what says the number out loud, fires on both weeks.
  for (let wk = 1; wk < 11; wk += 1) {
    for (const off of [1, 3, 5]) {
      repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(wk * 7 - 6 + off) });
    }
  }
  for (const off of [0, 2, 4]) {
    repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: fwd(off) });
  }
  const weeksOut = (plan) => (plan.rationale.find((r) => /weeks? out/.test(r)) ?? "").match(/is (\d+) weeks? out/)?.[1] ?? null;

  const monday = weeksOut(repo.weeklyRunPlan(REF, { block: { week_index: 1 } }));
  assert.ok(monday, "the race pull names the number of weeks out");
  for (let day = 1; day < 7; day += 1) {
    assert.equal(weeksOut(repo.weeklyRunPlan(fwd(day), { block: { week_index: 1 } })), monday, `day ${day + 1} holds`);
  }
  assert.equal(
    Number(weeksOut(repo.weeklyRunPlan(fwd(7), { block: { week_index: 1 } }))),
    Number(monday) - 1,
    "and next Monday the race really is one week closer"
  );
});

// Anchoring the countdown to Monday must not anchor the question of whether there is
// still a countdown. raceRamp answers "has this race already happened" against whatever
// date it is handed, so the week's Monday kept a Wednesday race reading as still ahead
// for the rest of that week — the plan published a feasibility read and spoke a timeline
// toward an event the athlete had already run.

const RACE_WEEK_REF = { distance_km: 21.1, weekly_km: 35, weekly_sessions: 4 };
const seedRaceWeek = (raceDate) => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Test Half", date: raceDate, ...RACE_WEEK_REF } });
  seedRunner({ weeks: 10, perWeek: 3, km: 10 });
};
const timeline = (plan) => plan.rationale.find((line) => /where this is heading|by race day/i.test(line)) ?? null;

test("a race already run is behind the athlete from the next morning, not the next Monday", () => {
  seedRaceWeek(fwd(2)); // the race is this Wednesday
  const raceDay = repo.weeklyRunPlan(fwd(2), { block: { week_index: 1 } });
  assert.ok(raceDay.goal_feasibility, "on the day itself the race is still ahead of them");

  for (const day of [3, 4, 5, 6]) {
    const after = repo.weeklyRunPlan(fwd(day), { block: { week_index: 1 } });
    assert.equal(after.goal_feasibility, null, `day ${day + 1}: no feasibility read for a race already run`);
    assert.equal(timeline(after), null, `day ${day + 1}: and no timeline sentence either — ${timeline(after)}`);
  }
});

test("a Sunday race is behind them on Monday, when the anchor itself has moved past it", () => {
  // The one case the plan date and the week's Monday would agree on for the wrong
  // reason: the race sits on the last day of its own week, so nothing but the rollover
  // separates them. Next Monday's anchor IS after the race, so this passes either way —
  // it is here to pin that the guard does not somehow read a week behind.
  seedRaceWeek(fwd(6));
  assert.ok(repo.weeklyRunPlan(fwd(6), { block: { week_index: 1 } }).goal_feasibility, "race day still counts");
  const nextMonday = repo.weeklyRunPlan(fwd(7), { block: { week_index: 1 } });
  assert.equal(nextMonday.goal_feasibility, null, "and the Monday after it is done");
  assert.equal(timeline(nextMonday), null, "nothing is said about arriving anywhere");
});

test("race week still reads the same from every morning up to and including race day", () => {
  // The countdown stays Monday-anchored through race day: before this, the plan date
  // read gave weeks=1 on Monday and Tuesday but weeks=0 on the Wednesday, so the
  // feasibility read moved on the morning of the race itself.
  seedRaceWeek(fwd(2));
  const mornings = [0, 1, 2].map((day) => repo.weeklyRunPlan(fwd(day), { block: { week_index: 1 } }));
  for (const plan of mornings) assert.ok(plan.goal_feasibility, "the race is ahead on all three");
  for (let i = 1; i < mornings.length; i += 1) {
    assert.deepEqual(
      mornings[i].goal_feasibility,
      mornings[0].goal_feasibility,
      `morning ${i + 1} of race week must read exactly as its Monday did`
    );
    assert.equal(totalRunKm(mornings[i]), totalRunKm(mornings[0]), `morning ${i + 1}: and prescribe the same week`);
  }
});

// ── an absence is only evidence once the week has closed ────────────────────

test("an emptying trailing window is not detraining — the closed week decides", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 10, perWeek: 3, km: 10 }); // runs sit late in each week (offsets 1, 3, 5)
  const mornings = Array.from({ length: 7 }, (_, day) => repo.weeklyRunPlan(fwd(day), { block: { week_index: 1 } }));

  // The live status genuinely flips: by Wednesday the trailing seven days hold only what
  // the previous week's tail left in them. Nothing was logged and nothing changed — the
  // window slid. The status stays honest for every other consumer; it just no longer
  // shrinks a week whose own closed week carried 30 km.
  assert.equal(repo.getProgramState(REF).endurance?.status, "maintaining", "Monday reads steady");
  assert.equal(repo.getProgramState(fwd(2)).endurance?.status, "detraining", "Wednesday's window has emptied");

  for (let i = 1; i < mornings.length; i += 1) {
    assert.equal(
      totalRunKm(mornings[i]),
      totalRunKm(mornings[0]),
      `day ${i + 1}: a sliding window must not ease the week (Mon ${totalRunKm(mornings[0])} → ${totalRunKm(mornings[i])})`
    );
  }
  for (const plan of mornings) {
    assert.ok(!/rebuilding the base/i.test(said(plan)), `no rebuild sentence on a 30 km closed week: ${said(plan)}`);
  }
});

test("a genuine drop-off still eases the week, and says so from every morning", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  // A real chronic base behind them, and then a closed week that all but stopped: 5 km
  // is below the floor where a load ratio means anything, so this drop-off is evidence
  // rather than an artefact of where in the week you happen to be standing.
  for (let wk = 1; wk < 10; wk += 1) {
    for (const off of [1, 3, 5]) {
      repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(wk * 7 + off) });
    }
  }
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: back(4) });
  const mornings = Array.from({ length: 7 }, (_, day) => repo.weeklyRunPlan(fwd(day), { block: { week_index: 1 } }));

  for (const plan of mornings) {
    assert.match(said(plan), /rebuilding the base/i, "the ease is real and it is said");
  }
  for (let i = 1; i < mornings.length; i += 1) {
    assert.equal(
      totalRunKm(mornings[i]),
      totalRunKm(mornings[0]),
      `day ${i + 1}: read off a closed week, it reads the same every morning`
    );
  }
});

// ── the mileage-spike brake is DELIBERATELY live ────────────────────────────
// It is the one input allowed to move a week from inside it, because it is not a
// volume ledger — it is a safety read of the load as it is right now, and it only
// ever pulls down. Pinned in both directions so a later round tidying "everything
// reads the closed week" cannot quietly fold it into the anchor.

test("the spike brake may lower a week from inside it, and nothing mid-week may raise one", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 10 }); // 30 km last week, no spike in sight
  const opts = { block: { week_index: 1 } };
  const monday = repo.weeklyRunPlan(REF, opts);
  assert.match(said(monday), /building conservatively/i, "Monday opens on an ordinary build");

  // 40 km inside three days, against a ~30 km chronic base: the acute window tips past
  // the ratio and the brake engages from Wednesday.
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: REF });
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: fwd(1) });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: fwd(2) });
  const wednesday = repo.weeklyRunPlan(fwd(2), opts);

  assert.equal(wednesday.week_start, monday.week_start, "still the same week");
  assert.match(said(wednesday), /mileage jumped recently/i, "the brake is live and it fired");
  assert.ok(
    totalRunKm(wednesday) < totalRunKm(monday),
    `the brake really does lower the week (Mon ${totalRunKm(monday)} → Wed ${totalRunKm(wednesday)})`
  );
  assert.ok(
    longKm(wednesday) <= longKm(monday),
    `and it lowers the long run with it (Mon ${longKm(monday)} → Wed ${longKm(wednesday)})`
  );
});

test("a programState injected to save a compute does not hand the coach a different week", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 10, perWeek: 3, km: 9 }); // 9 km is the habitual longest
  const opts = { block: { week_index: 1 } };
  const monday = repo.weeklyRunPlan(REF, opts);
  assert.ok(monday.available);

  // 20 km on the Monday of the week under test — more than twice anything demonstrated.
  repo.addActivity({ type: "run", duration_min: 150, distance_km: 20, date: REF });

  // What getCoachContext() does: hand in the programState it already built for today,
  // purely so the run-plan view and the adjustments digest don't compute it twice. That
  // is economy, not a claim about which week the plan describes — so it must not buy a
  // different long run from the same engine on the same morning. It did: the default
  // path held the anchored 10.4 km while every coaching surface read 16.3 km.
  const wednesday = repo.weeklyRunPlan(fwd(2), opts);
  const wednesdayInjected = repo.weeklyRunPlan(fwd(2), { ...opts, programState: repo.getProgramState(fwd(2)) });

  assert.equal(
    longKm(wednesdayInjected),
    longKm(wednesday),
    `both surfaces describe the same week (default ${longKm(wednesday)} vs injected ${longKm(wednesdayInjected)})`
  );
  assert.ok(
    longKm(wednesdayInjected) <= longKm(monday),
    `and neither grows it from its own Monday (Mon ${longKm(monday)} → ${longKm(wednesdayInjected)})`
  );
});

test("the supporting-arm easy cap reads the closed week too — a big Monday never lifts it", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  // Many SHORT runs: a real weekly volume with nothing long ever demonstrated, which is
  // what puts this athlete on the supporting-constrained arm where recentRunDose bites.
  for (let wk = 0; wk < 6; wk += 1) {
    for (const off of [1, 2, 3, 4, 5]) {
      repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: back(wk * 7 + off) });
    }
  }
  const opts = {
    block: { week_index: 1 },
    trainingIntent: { priorities: ["strength"], endurance_role: "supporting", endurance_capacity: null, source: "explicit" },
    recovery: { readiness: { band: "low", fresh: "fresh" }, delta: { hrv: -20, rhr: 4, sleep: -60 }, recovery: {} },
  };
  const monday = repo.weeklyRunPlan(REF, opts);
  assert.ok(monday.available);

  repo.addActivity({ type: "run", duration_min: 90, distance_km: 15, date: REF });
  const wednesday = repo.weeklyRunPlan(fwd(2), opts);

  // The dose read caps the EASY runs (average_km × 1.1), so read at the plan date one
  // big Monday lifted Wednesday's easy run and the week's total with it — the same
  // self-anchoring as the volume halves, arriving through the easy end of the mix.
  const easyKm = (plan) => plan.runs.find((r) => r.kind_label === "easy")?.target_distance_km ?? null;
  assert.equal(easyKm(wednesday), easyKm(monday), `the easy cap holds (Mon ${easyKm(monday)} → ${easyKm(wednesday)})`);
  assert.ok(
    totalRunKm(wednesday) <= totalRunKm(monday),
    `and the week with it (Mon ${totalRunKm(monday)} → ${totalRunKm(wednesday)})`
  );
});

test("an injected compliance is the anchor exactly as given — the caller owns which week it means", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 10 }); // 30 km/wk of history
  const opts = { block: { week_index: 1 }, volumeAnchorDate: back(90) }; // trailing window: empty
  const lean = repo.weeklyRunPlan(REF, { ...opts, compliance: { actual_km: 0 } });
  const rich = repo.weeklyRunPlan(REF, { ...opts, compliance: { actual_km: 50 } });
  assert.ok(
    totalRunKm(rich) > totalRunKm(lean),
    `an injected actual_km still anchors the week (${totalRunKm(lean)} → ${totalRunKm(rich)})`
  );
});

test("but volume run LAST week is exactly what the anchor is supposed to move", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 10 });
  const opts = { block: { week_index: 1 } };
  const lean = repo.weeklyRunPlan(REF, opts);

  // Two more runs in the week that has already closed (REF is a Monday, so back(2)
  // and back(4) are last Saturday and last Thursday).
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(2) });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: back(4) });

  const fuller = repo.weeklyRunPlan(REF, opts);
  assert.ok(
    totalRunKm(fuller) > totalRunKm(lean),
    `last week's mileage still raises the ask (${totalRunKm(lean)} → ${totalRunKm(fuller)})`
  );
});

test("an explicit volumeAnchorDate still overrides the week-boundary default", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner({ weeks: 8, perWeek: 3, km: 10 });
  const opts = { block: { week_index: 1 } };
  const defaulted = repo.weeklyRunPlan(REF, opts);
  // Anchor a fortnight back, where seedRunner's history is identical — same answer —
  // and then somewhere the history is thinner, where it must differ.
  assert.equal(totalRunKm(repo.weeklyRunPlan(REF, { ...opts, volumeAnchorDate: back(8) })), totalRunKm(defaulted));
  const thin = repo.weeklyRunPlan(REF, { ...opts, volumeAnchorDate: back(90) });
  assert.notEqual(totalRunKm(thin), totalRunKm(defaulted), "an anchor before the history reads a different base");
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
