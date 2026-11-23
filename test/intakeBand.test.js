// v2 wave 2, stream A — the protein anchor and the OBSERVED intake band.
//
// The band is read ONLY from days classifyIntakeDay calls complete, against the
// bodyweight response over the same weeks. A partial day is absent, never low: it may
// not widen, lower or otherwise move the band. Too few complete days → no band, said in
// words. Protein comes first and the band never trims it; it is an observation, never a
// target.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo, seedIntake, seedWeight } from "./_seed.js";
import {
  classifyWeekResponse,
  fitIntakeResponse,
  intakeBand,
  intakeResponseConfidence,
  proteinAnchor,
} from "../dist/repo/intake-band.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { registerNutritionTools } from "../dist/surfaces/mcp/nutrition.js";
import { projectCoachContext } from "../dist/prompt/context-projection.js";

beforeEach(() => {
  resetTables("food_notes", "bodyweight_log", "garmin_daily_metrics", "profile");
  repo.setProfile({
    age: 35,
    height_cm: 180,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_weight_lb: 170,
    goal_date: null,
  });
});

// A complete day: a breakfast and a dinner that reach across the day.
function completeDay(daysAgo, kcal) {
  seedIntake(daysAgo, Math.round(kcal * 0.4), {}, { eatenAt: "08:00" });
  seedIntake(daysAgo, kcal - Math.round(kcal * 0.4), {}, { eatenAt: "19:00" });
}

// Six weeks ending yesterday: the older three at 2,400 kcal/day with the weight
// climbing a pound a week, the recent three at 1,800 kcal/day with it falling a pound
// a week. Five complete days a week; the other two are left empty.
function seedSixWeeks() {
  let weight = 180;
  for (let daysAgo = 42; daysAgo >= 0; daysAgo--) {
    const olderHalf = daysAgo > 21;
    weight += olderHalf ? 1 / 7 : -1 / 7;
    seedWeight(localDaysAgo(daysAgo), Math.round(weight * 10) / 10);
    const dayInWeek = (daysAgo - 1) % 7;
    if (daysAgo >= 1 && dayInWeek < 5) completeDay(daysAgo, olderHalf ? 2400 : 1800);
  }
}

test("the band is read off complete days and the weight's response, as an observation", () => {
  seedSixWeeks();
  const band = intakeBand();
  assert.equal(band.status, "ok");
  assert.equal(band.kind, "observation");
  assert.equal(band.band.low_kcal, 1800, "the most eaten in a week the weight still went down");
  assert.equal(band.band.high_kcal, 2400, "the least eaten in a week the weight went up");
  assert.equal(band.band.high_is_gain_edge, true);
  assert.equal(band.band.mixed, false);
  assert.equal(band.energy_ceiling_kcal, 1800, "the ceiling is a no-gain intake, never a surplus");
  assert.ok(["low", "moderate", "high"].includes(band.confidence));
  assert.ok(band.confidence_words);
  assert.match(band.words, /not a target/);
  assert.doesNotMatch(band.words, /\d+\s*%|score|\/100/i, "words, never a score");
  assert.ok(band.protein_anchor.protein_g > 0, "protein comes first");
  assert.match(band.protein_anchor.words, /never trims it/);
});

test("partial days are absent: they neither lower nor widen the band", () => {
  seedSixWeeks();
  const before = intakeBand();
  // A breakfast-only day inside every week — read as 'low' it would drag each
  // week's average down and move both edges.
  for (let daysAgo = 1; daysAgo <= 42; daysAgo++) {
    if ((daysAgo - 1) % 7 === 5) seedIntake(daysAgo, 300, {}, { eatenAt: "08:00" });
  }
  const after = intakeBand();
  assert.ok(after.window.partial_days > before.window.partial_days, "the partial days were seen…");
  assert.deepEqual(after.band, before.band, "…and changed nothing");
  assert.equal(after.energy_ceiling_kcal, before.energy_ceiling_kcal);
  assert.deepEqual(
    after.weeks.map((w) => w.kcal_avg),
    before.weeks.map((w) => w.kcal_avg)
  );
});

test("too few complete days: no band, and the read says so in words", () => {
  for (let daysAgo = 1; daysAgo <= 5; daysAgo++) {
    completeDay(daysAgo, 2000);
    seedWeight(localDaysAgo(daysAgo), 180 - daysAgo * 0.1);
  }
  // Plenty of partial days — they never count toward the minimum.
  for (let daysAgo = 6; daysAgo <= 30; daysAgo++) seedIntake(daysAgo, 400, {}, { eatenAt: "12:00" });
  const band = intakeBand();
  assert.equal(band.status, "too_few_days");
  assert.equal(band.band, null);
  assert.equal(band.energy_ceiling_kcal, null);
  assert.equal(band.window.complete_days, 5);
  assert.match(band.words, /Only 5 complete days/);
  assert.match(band.words, /never counted as low/);
  assert.ok(band.protein_anchor, "the protein anchor still stands without a band");
});

test("complete days with no weigh-ins beside them are not a band either", () => {
  for (let daysAgo = 1; daysAgo <= 14; daysAgo++) completeDay(daysAgo, 2000);
  const band = intakeBand();
  assert.equal(band.status, "no_weight_response");
  assert.equal(band.band, null);
  assert.match(band.words, /weigh-ins/);
});

test("protein anchor is the day's protein target and is null without a profile", () => {
  assert.ok(proteinAnchor().protein_g > 0);
  resetTables("profile");
  assert.equal(proteinAnchor(), null);
});

test("REST and MCP serve the same read, and every fuel prompt site carries it", async () => {
  seedSixWeeks();
  let handler;
  for (const layer of nutritionRouter.stack) {
    if (layer.route?.path === "/nutrition/intake-band" && layer.route.methods.get)
      handler = layer.route.stack.at(-1).handle;
  }
  const rest = await new Promise((resolve) => handler({ query: {} }, { json: resolve }));
  const tools = new Map();
  registerNutritionTools({ tool: (n, _d, _s, h) => tools.set(n, h) });
  const mcp = JSON.parse((await tools.get("get_intake_band")({})).content[0].text);
  assert.deepEqual(mcp.band, rest.band);
  assert.equal(rest.status, "ok");

  const ctx = { intake_band: rest, day_intake: { entries: [] } };
  assert.deepEqual(projectCoachContext(ctx, "chat").intake_band, rest, "chat carries intake_band");
  // The meal plan carries the band's answer without the per-week rows it was pooled from.
  const { weeks: _weeks, ...answer } = rest;
  assert.deepEqual(projectCoachContext(ctx, "meal_plan").intake_band, answer, "meal_plan carries intake_band");
});

// Deterministic noise: a seeded PRNG and a Box-Muller normal, so a noisy scale is
// reproducible run to run.
function seededNormal(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

test("a steady cut on a noisy scale does not read false 'up' weeks", () => {
  // A true -0.5 lb/week trend under a pound of daily scale noise, over ten-day
  // response windows with a daily weigh-in — the shape of one band week.
  const normal = seededNormal(20260925);
  const xs = Array.from({ length: 10 }, (_, i) => i);
  let up = 0;
  let deadbandOnlyUp = 0;
  const trials = 4000;
  for (let t = 0; t < trials; t++) {
    const ys = xs.map((x) => 180 - (0.5 / 7) * x + normal());
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    xs.forEach((x, i) => {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (ys[i] - my);
    });
    const slope = sxy / sxx;
    if (slope * 7 >= 0.25) deadbandOnlyUp++;
    // sigma: the athlete's scatter, as the band pools it across the window.
    if (classifyWeekResponse(slope, sxx, 1).response === "up") up++;
  }
  assert.ok(deadbandOnlyUp / trials > 0.1, "the bare deadband would call a real cut 'up' often");
  assert.ok(up / trials < 0.01, `false 'up' weeks: ${((up / trials) * 100).toFixed(2)}%`);
});

test("the band on a noisy steady cut never says the weight trended up", () => {
  // Eight weeks at ~1,900 kcal/day, weight truly falling half a pound a week, a pound of
  // daily scale noise. Every week's complete days are there.
  const normal = seededNormal(7);
  for (let daysAgo = 56; daysAgo >= 0; daysAgo--) {
    const truth = 180 - (0.5 / 7) * (56 - daysAgo);
    seedWeight(localDaysAgo(daysAgo), Math.round((truth + normal()) * 10) / 10);
    if (daysAgo >= 1 && (daysAgo - 1) % 7 < 5) completeDay(daysAgo, 1900);
  }
  const band = intakeBand();
  assert.ok(!band.weeks.some((w) => w.response === "up"), JSON.stringify(band.weeks.map((w) => w.response)));
  assert.doesNotMatch(band.words, /trended up|rose/);
  if (band.status === "ok") assert.ok(band.energy_ceiling_kcal == null || band.energy_ceiling_kcal >= 1800);
});

test("a steady week needs a slope precise enough to rule out a real move", () => {
  // A flat slope read off a noisy week is not evidence of 'steady'.
  const sxx = 82.5; // ten daily weigh-ins
  assert.equal(classifyWeekResponse(0, sxx, 0.3).response, "steady");
  assert.equal(classifyWeekResponse(0, sxx, 1.2).response, "unknown");
  assert.equal(classifyWeekResponse(-1.2 / 7, sxx, 0.3).response, "down");
  assert.equal(classifyWeekResponse(0.4 / 7, sxx, 1.2).response, "unknown", "inside the noise, no direction");
});

// ---------- recovering the turn on a real, noisy scale ----------
//
// The athlete's lived experience: above a certain daily intake the weight goes up, below
// it the weight drifts down. With a pound of daily scale scatter no single week can show
// that (most weeks read "unknown" on their own), so the band is read from the weeks
// pooled: one continuous weight line, the weeks split at the intake that separates them.

// Below 2,100 kcal/day the weight truly drifts down half a pound a week; above it, it
// truly climbs 0.3 lb a week. Intake moves in phases of a few weeks (oldest first).
const TURN_KCAL = 2100;
const PHASES = [1850, 1950, 1800, 2300, 2400, 2250, 1900, 1800, 2000, 2350, 2250, 2450];
const trueLbPerWeek = (kcal) => (kcal < TURN_KCAL ? -0.5 : 0.3);

// An AR(1) scale: yesterday's water carries into today by `carry` (0 = independent days).
function scaleNoise(seed, carry = 0) {
  const normal = seededNormal(seed);
  let e = 0;
  return () => {
    e = carry * e + Math.sqrt(1 - carry * carry) * normal();
    return e;
  };
}

// The pure read over a synthetic 12-week window: daily weigh-ins on a day axis, weeks
// opening their response window a day after the week starts (as intakeBand does).
function pooledRead(seed, { kcal = PHASES, slope = trueLbPerWeek, carry = 0 } = {}) {
  const noise = scaleNoise(seed, carry);
  const points = [];
  let truth = 180;
  for (let x = 0; x <= kcal.length * 7; x++) {
    if (x > 0) truth += slope(kcal[Math.min(kcal.length - 1, Math.floor((x - 1) / 7))]) / 7;
    points.push({ x, y: truth + noise() });
  }
  const fit = fitIntakeResponse(
    kcal.map((k, w) => ({ start: 7 * w + 1, kcal: k })),
    points
  );
  const verdict =
    fit && fit.groups.some((g) => g.response !== "unknown") ? intakeResponseConfidence(fit, kcal.length, 60) : null;
  return { fit, verdict };
}

// The same shape through the whole read: five complete days a week, a daily weigh-in.
function seedNoisyTurn(seed, { flat = false, carry = 0, slope = trueLbPerWeek } = {}) {
  const noise = scaleNoise(seed, carry);
  let truth = 180;
  for (let daysAgo = PHASES.length * 7; daysAgo >= 0; daysAgo--) {
    // intakeBand's weeks end yesterday: daysAgo 1–7 is the newest week.
    const week = PHASES.length - 1 - Math.floor((Math.max(daysAgo, 1) - 1) / 7);
    const kcal = PHASES[week];
    if (!flat) truth += slope(kcal) / 7;
    seedWeight(localDaysAgo(daysAgo), Math.round((truth + noise()) * 10) / 10);
    if (daysAgo >= 1 && (daysAgo - 1) % 7 < 5) completeDay(daysAgo, kcal);
  }
}

test("a noisy scale: the turn is recovered from the pooled weeks, with an honest confidence word", () => {
  seedNoisyTurn(5);
  const band = intakeBand();
  const unread = band.weeks.filter((w) => w.response === "unknown").length;
  assert.ok(unread >= 6, `most single weeks cannot call it on their own (${unread}/12 unknown)`);
  assert.equal(band.status, "ok", band.reason);
  assert.equal(band.band.low_is_loss_edge, true);
  assert.equal(band.band.high_is_gain_edge, true);
  assert.equal(band.band.mixed, false);
  assert.ok(band.band.low_kcal <= TURN_KCAL && band.band.high_kcal >= TURN_KCAL, JSON.stringify(band.band));
  assert.ok(band.band.low_kcal >= TURN_KCAL - 300 && band.band.high_kcal <= TURN_KCAL + 300, "…and near it");
  assert.ok(band.energy_ceiling_kcal <= band.band.high_kcal, "the ceiling never reaches into the gain side");
  assert.ok(["moderate", "high"].includes(band.confidence), band.confidence_words);
  assert.match(band.confidence_words, /^(Observed|Strong): \d+ weeks and \d+ complete days/);
  assert.match(
    band.words,
    /^(Observed|Clear) over \d+ weeks: your weight drifted down .* and rose .*, so it turns somewhere between\./
  );
  assert.match(band.words, /not a target\.$/);
  assert.doesNotMatch(`${band.words} ${band.confidence_words}`, /\d+\s*%|score|\/100|±|standard error/i);
  assert.equal(band.pooled.groups.length, 2);
  assert.deepEqual(
    band.pooled.groups.map((g) => g.response),
    ["down", "up"]
  );
  assert.ok(band.protein_anchor.protein_g > 0, "protein still comes first");
});

test("through the whole read, a noisy scale's turn is found near the truth or said to be tentative", () => {
  let observed = 0;
  for (let seed = 1; seed <= 16; seed++) {
    resetTables("food_notes", "bodyweight_log");
    seedNoisyTurn(seed);
    const band = intakeBand();
    assert.equal(band.status, "ok", `seed ${seed}: ${band.reason}`);
    const { band: b } = band;
    const said = `seed ${seed}: ${band.words} (${JSON.stringify(b)})`;
    // Whatever it says, it never has the weight rising well below the turn or coming
    // down well above it, and never leaves the ceiling above a gain edge.
    if (b.high_is_gain_edge) assert.ok(b.high_kcal >= TURN_KCAL - 150, said);
    if (b.low_is_loss_edge) assert.ok(b.low_kcal <= TURN_KCAL + 150, said);
    if (b.high_is_gain_edge && band.energy_ceiling_kcal != null)
      assert.ok(band.energy_ceiling_kcal < b.high_kcal, said);
    if (band.confidence === "low") {
      assert.match(band.confidence_words, /^Tentative:/, said);
      assert.match(band.words, /^(A tentative read|The record is mixed)/, said);
    } else {
      observed++;
      assert.match(band.words, /^(Observed|Clear) over/, said);
    }
  }
  assert.ok(observed >= 4, `a phase pattern this clear is read as observed on a fair share of scales (${observed}/16)`);
});

test("across many noisy scales the turn lands near the truth, and a located turn never lands far off", () => {
  let confident = 0;
  let near = 0;
  let wrongSide = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const { fit, verdict } = pooledRead(seed);
    if (!verdict || !verdict.turn || verdict.confidence === "low") continue;
    confident++;
    const { low_kcal, high_kcal } = fit.boundary;
    if (low_kcal <= TURN_KCAL + 150 && high_kcal >= TURN_KCAL - 150) near++;
    if (low_kcal > TURN_KCAL + 250 || high_kcal < TURN_KCAL - 250) wrongSide++;
  }
  assert.ok(confident >= 30, `a clear phase pattern is read confidently often (${confident}/100)`);
  assert.ok(near / confident >= 0.9, `a confident turn sits near the truth (${near}/${confident})`);
  assert.equal(wrongSide, 0, "a confident turn is never far from the truth");
});

test("pure scale noise never buys an observed or strong band", () => {
  // No link between intake and weight at all — flat truth — on an independent scale and
  // on one where water carries over day to day, across intake patterns that alternate
  // week to week (the hardest to tell from noise) and that move in phases.
  const alternating = [1800, 2300, 1950, 2400, 1850, 2250, 2000, 2350, 1900, 2200, 2050, 2450];
  let confident = 0;
  let trials = 0;
  for (const kcal of [PHASES, alternating]) {
    for (const carry of [0, 0.5]) {
      for (let seed = 1; seed <= 100; seed++) {
        trials++;
        const { verdict } = pooledRead(seed, { kcal, slope: () => 0, carry });
        if (verdict && verdict.confidence !== "low") confident++;
      }
    }
  }
  assert.ok(confident / trials <= 0.01, `confident bands from pure noise: ${confident}/${trials}`);
});

test("pure noise through the whole read is at most tentative, and says so", () => {
  seedNoisyTurn(5, { flat: true });
  const band = intakeBand();
  assert.ok(band.confidence == null || band.confidence === "low", `${band.confidence}: ${band.confidence_words}`);
  if (band.status === "ok") {
    assert.match(band.confidence_words, /^Tentative:/);
    assert.match(band.words, /tentative|mixed/i);
  }
});

test("weight falling faster where more was eaten is a contradiction: mixed, tentative, no ceiling", () => {
  const backwards = (kcal) => (kcal < TURN_KCAL ? 0.6 : -0.6);
  const { verdict } = pooledRead(3, { slope: backwards });
  assert.equal(verdict.inverted, true);
  assert.equal(verdict.confidence, "low");

  seedNoisyTurn(3, { slope: backwards });
  const band = intakeBand();
  assert.equal(band.status, "ok", band.reason);
  assert.equal(band.band.mixed, true);
  assert.equal(band.energy_ceiling_kcal, null, "no intake is called no-gain off a record that runs backwards");
  assert.equal(band.confidence, "low");
  assert.match(band.words, /^The record is mixed: your weight came down in weeks at the higher intakes/);
  assert.match(band.confidence_words, /^Tentative: the weeks disagree/);
});
