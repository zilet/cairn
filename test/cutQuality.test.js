// The CUT-QUALITY read (repo/cut-quality.ts): during an active weight-loss phase, is
// strength holding as the weight drops? Injection-first (mirrors underfueling.test.js):
// synthetic goal / expenditure / program-state make the verdict matrix deterministic
// without heavy DB fixtures; a few DB-path tests pin the wiring end-to-end.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { cutQualityRead, cutQualityWeekLine } from "../dist/repo/cut-quality.js";
import { teamWeekRead } from "../dist/repo/team-week.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { buildNutritionCheckinPrompt } from "../dist/prompt.js";

const TODAY = "2026-07-15";
const day = (delta) => addDaysISO(TODAY, delta);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "exercises",
    "profile",
    "food_notes",
    "bodyweight_log",
    "daily_metrics",
    "activities",
    "garmin_activities",
    "nutrition_targets"
  );
});

// ---- injection fixtures ----
const goalLose = {
  ok: true,
  goal_mode: "lose",
  trend_lb_wk: -1.4,
  leanness_rate: { safe_max_rate_lb: 1.7, lean_ideal_rate_lb: 1.3 },
};
const expDownHigh = { trend_lb_wk: -1.4, window_days: 21, confidence: "high" };

// A graded lift — cut-quality only reads exercise/status/last_trained/sessions.
function lift(exercise, status, { last = day(-2), sessions = 6 } = {}) {
  return { exercise, status, last_trained: last, sessions };
}
function program(lifts, endurance = null) {
  return { lifts, endurance };
}

function read(opts) {
  return cutQualityRead(TODAY, { goal: goalLose, expenditure: expDownHigh, ...opts });
}

// ---- verdict matrix ----
test("three established lifts, none regressing → preserving", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "progressing"),
      lift("Barbell Bench Press", "maintaining"),
      lift("Barbell Row", "plateaued"),
    ]),
  });
  assert.equal(r.active, true);
  assert.equal(r.verdict, "preserving");
  assert.equal(r.strength.considered, 3);
  assert.equal(r.strength.regressing, 0);
  assert.equal(r.strength.holding, 3);
  assert.match(r.words, /preserving muscle/i);
});

test("two or more anchor lifts regressing → sliding", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "regressing"),
      lift("Barbell Bench Press", "regressing"),
      lift("Barbell Row", "progressing"),
    ]),
  });
  assert.equal(r.verdict, "sliding");
  assert.equal(r.strength.regressing, 2);
  assert.match(r.words, /sliding/i);
});

test("more regressing than holding → sliding even with a single regressor", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "regressing"),
      // only two established, but this hits the considered<3 gate first → insufficient,
      // so add a third holding to isolate the regressing>holding rule:
      lift("Barbell Bench Press", "maintaining"),
      lift("Barbell Row", "regressing"),
    ]),
  });
  // regressing=2, holding=1 → regressing > holding → sliding
  assert.equal(r.strength.regressing, 2);
  assert.equal(r.strength.holding, 1);
  assert.equal(r.verdict, "sliding");
});

test("one lift slipping while the rest hold → mixed", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "progressing"),
      lift("Barbell Bench Press", "maintaining"),
      lift("Barbell Row", "regressing"),
    ]),
  });
  assert.equal(r.verdict, "mixed");
  assert.equal(r.strength.regressing, 1);
  assert.equal(r.strength.holding, 2);
});

test("fewer than three established lifts → insufficient (neutral, never blames)", () => {
  const r = read({
    programState: program([lift("Barbell Back Squat", "progressing"), lift("Barbell Bench Press", "maintaining")]),
  });
  assert.equal(r.active, true);
  assert.equal(r.verdict, "insufficient");
  assert.equal(r.strength.considered, 2);
  assert.doesNotMatch(r.words, /sliding|preserving/i);
});

test("a loose (low-confidence) weight trend → insufficient even with solid lifts", () => {
  const r = read({
    expenditure: { trend_lb_wk: -1.4, window_days: 21, confidence: "low" },
    programState: program([
      lift("Barbell Back Squat", "progressing"),
      lift("Barbell Bench Press", "maintaining"),
      lift("Barbell Row", "plateaued"),
    ]),
  });
  assert.equal(r.verdict, "insufficient");
});

// ---- gate: only an active, genuine cut ----
test("not actually losing (trend above the floor) → inactive", () => {
  const r = read({
    expenditure: { trend_lb_wk: -0.1, window_days: 21, confidence: "high" },
    programState: program([lift("Barbell Back Squat", "progressing")]),
  });
  assert.equal(r.active, false);
});

test("a maintain/gain goal → inactive regardless of the scale", () => {
  const maintain = cutQualityRead(TODAY, {
    goal: { ok: true, goal_mode: "maintain", trend_lb_wk: -1.4 },
    expenditure: expDownHigh,
    programState: program([lift("Barbell Back Squat", "progressing")]),
  });
  assert.equal(maintain.active, false);
});

// ---- anchor selection ----
test("anchor selection ignores status:'new' lifts", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "progressing"),
      lift("Barbell Bench Press", "maintaining"),
      lift("Barbell Row", "plateaued"),
      lift("Overhead Press", "new"), // just started — no trend to read
    ]),
  });
  assert.equal(r.strength.considered, 3, "the 'new' lift is not counted");
  assert.ok(
    !r.strength.anchors.some((a) => a.name === "Overhead Press"),
    "and never surfaces as an anchor"
  );
});

test("a stale established lift (outside the recency window) is not considered", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "progressing"),
      lift("Barbell Bench Press", "maintaining"),
      lift("Barbell Row", "plateaued"),
      lift("Incline Press", "regressing", { last: day(-40) }), // last trained 40d ago
    ]),
  });
  assert.equal(r.strength.considered, 3, "the stale lift falls outside the cut window");
  assert.equal(r.strength.regressing, 0);
  assert.equal(r.verdict, "preserving");
});

test("anchors prefer compound movements over higher-volume isolation", () => {
  const r = read({
    programState: program([
      lift("Lateral Raise", "maintaining", { sessions: 30 }), // isolation, most sets
      lift("Bicep Curl", "maintaining", { sessions: 25 }),
      lift("Barbell Back Squat", "progressing", { sessions: 8 }), // compound, fewer sets
    ]),
  });
  assert.equal(r.strength.anchors[0].name, "Barbell Back Squat", "a compound leads the anchors, not the top-by-set-count isolation");
});

test("regressing anchors surface first so the read can name what slipped", () => {
  const r = read({
    programState: program([
      lift("Lateral Raise", "maintaining", { sessions: 30 }),
      lift("Barbell Bench Press", "regressing", { sessions: 8 }),
      lift("Barbell Back Squat", "progressing", { sessions: 8 }),
    ]),
  });
  assert.equal(r.strength.anchors[0].name, "Barbell Bench Press");
  assert.equal(r.strength.anchors[0].status, "regressing");
});

// ---- rate vs the lean-safe ceiling ----
test("losing within the lean-safe ceiling reads 'within'", () => {
  const r = read({
    programState: program([
      lift("Barbell Back Squat", "regressing"),
      lift("Barbell Bench Press", "regressing"),
      lift("Barbell Row", "progressing"),
    ]),
  });
  assert.equal(r.rate.vs_lean_safe, "within"); // |-1.4| < 1.7
});

test("losing faster than the lean-safe ceiling reads 'above' and sharpens a sliding read", () => {
  const r = cutQualityRead(TODAY, {
    goal: { ok: true, goal_mode: "lose", trend_lb_wk: -1.4, leanness_rate: { safe_max_rate_lb: 0.85, lean_ideal_rate_lb: 0.6 } },
    expenditure: expDownHigh,
    programState: program([
      lift("Barbell Back Squat", "regressing"),
      lift("Barbell Bench Press", "regressing"),
      lift("Barbell Row", "progressing"),
    ]),
  });
  assert.equal(r.rate.vs_lean_safe, "above"); // |-1.4| > 0.85
  assert.match(r.words, /faster than the lean-safe pace/i);
});

// ---- endurance note ----
test("a clearly-declining easy pace during the cut adds an endurance note", () => {
  const r = read({
    programState: program(
      [
        lift("Barbell Back Squat", "progressing"),
        lift("Barbell Bench Press", "maintaining"),
        lift("Barbell Row", "plateaued"),
      ],
      { pace_trend: "declining" }
    ),
  });
  assert.ok(r.endurance);
  assert.match(r.endurance.note, /easy-pace endurance/i);
});

test("a stable/improving endurance pace adds no note", () => {
  const r = read({
    programState: program(
      [lift("Barbell Back Squat", "progressing"), lift("Barbell Bench Press", "maintaining"), lift("Barbell Row", "plateaued")],
      { pace_trend: "improving" }
    ),
  });
  assert.equal(r.endurance, null);
});

// ---- team-week gate ----
test("the team-week line surfaces only for a confident, active cut", () => {
  assert.equal(cutQualityWeekLine({ active: false }), null);
  assert.equal(cutQualityWeekLine({ active: true, verdict: "insufficient", words: "thin" }), null);
  assert.deepEqual(cutQualityWeekLine({ active: true, verdict: "preserving", words: "held" }), { text: "held" });
  assert.deepEqual(cutQualityWeekLine({ active: true, verdict: "sliding", words: "slid" }), { text: "slid" });
});

test("teamWeekRead exposes a null cut line on an empty DB (degrades cleanly)", () => {
  const tw = teamWeekRead({ asOf: TODAY });
  assert.equal(tw.cut, null);
});

// ---- check-in prompt fold ----
function checkinPromptWith(cutQuality) {
  const ctx = repo.getCoachContext();
  ctx.cut_quality = cutQuality;
  return buildNutritionCheckinPrompt(ctx);
}

test("a 'sliding' read folds a protective-raise instruction into the check-in prompt", () => {
  const prompt = checkinPromptWith({ active: true, verdict: "sliding", rate: { vs_lean_safe: "above" } });
  assert.match(prompt, /CUT QUALITY \(deterministic\)/);
  assert.match(prompt, /SLIDING/);
  assert.match(prompt, /PROTECTIVE calorie RAISE/i);
  assert.match(prompt, /above the lean-safe pace/i);
});

test("a 'preserving' read reinforces change:false in the check-in prompt", () => {
  const prompt = checkinPromptWith({ active: true, verdict: "preserving", rate: { vs_lean_safe: "within" } });
  assert.match(prompt, /CUT QUALITY \(deterministic\)/);
  assert.match(prompt, /HOLDING/);
  assert.match(prompt, /change:false/);
});

test("no cut (inactive) folds nothing into the check-in prompt", () => {
  const prompt = checkinPromptWith({ active: false });
  assert.doesNotMatch(prompt, /CUT QUALITY \(deterministic\)/);
});

// ---- route wiring ----
test("GET /nutrition/expenditure includes the cut_quality field", () => {
  const layer = nutritionRouter.stack.find(
    (entry) => entry.route?.path === "/nutrition/expenditure" && entry.route?.methods?.get
  );
  assert.ok(layer, "the expenditure route is mounted");
  let payload;
  const res = {
    status() {
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  layer.route.stack.at(-1).handle({ query: {} }, res);
  assert.ok(payload && "cut_quality" in payload, "the response carries cut_quality");
  assert.equal(typeof payload.cut_quality.active, "boolean");
  assert.equal(payload.cut_quality.active, false, "inactive on an empty DB (no cut)");
});
