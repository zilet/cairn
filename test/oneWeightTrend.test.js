// ONE weight trend (docs/IA.md contract test 5): Today's path, the Body page (goal pace),
// the Season, the conductor's evidence and What moved used to print four figures for
// one scale (−0.93, −0.9, −0.87, "1.0 lb lower"). Every surface now reads
// weightTrendRead() (src/repo/weight-trend.ts): one rate rounded once, one ask, one
// on-pace verdict, said through the one formatter in the athlete's weight unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedWeight } from "./_seed.js";
import { weightTrendRead, paceVerdict } from "../dist/repo/weight-trend.js";
import { todayPath } from "../dist/repo/today-path.js";
import { getCoachingFocus } from "../dist/repo/coach.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { goalPaceResponse } from "../dist/routes/nutrition.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";

const NOW = new Date("2026-09-22T12:00:00");

function seedCut() {
  const today = localDateISO();
  repo.setProfile({
    age: 40,
    sex: "male",
    goal_mode: "lose",
    goal_weight_lb: 154,
    goal_date: addDaysISO(today, 84),
    start_weight_lb: 172,
    start_date: addDaysISO(today, -90),
  });
  // About −0.9 lb a week over three weeks, a weigh-in every other day.
  for (let d = 24; d >= 0; d -= 2) seedWeight(addDaysISO(today, -d), Math.round((165.4 + d * 0.13) * 10) / 10);
}

const RATE = /[+−-]?\d+(?:\.\d+)? (?:lb|kg)\/wk/g;

test("the verdict: one tolerance, from the rounded rates", () => {
  assert.equal(paceVerdict(-0.9, -1.0), "on_pace");
  assert.equal(paceVerdict(-0.5, -1.0), "behind");
  assert.equal(paceVerdict(-1.6, -1.0), "ahead");
  assert.equal(paceVerdict(0.05, null), "steady");
  assert.equal(paceVerdict(null, -1), null);
  assert.equal(paceVerdict(0.6, 0.5), "on_pace", "a gain reads the same way up");
});

test("every surface prints the one rate and the one verdict", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedCut();
  const today = localDateISO();
  const one = weightTrendRead(today);
  assert.ok(one.rate_lb_wk != null && one.rate_lb_wk < 0, `a falling trend (${one.rate_lb_wk})`);
  assert.equal(one.rate_lb_wk, Math.round(one.rate_lb_wk * 10) / 10, "rounded once to a tenth");
  assert.ok(one.line?.startsWith(`Trending ${one.rate_words}`), one.line);
  assert.ok(one.verdict);

  // Today's path.
  const path = todayPath(today);
  assert.equal(path.weight.trend_lb_wk, one.rate_lb_wk);
  assert.equal(path.weight.needed_lb_wk, one.needed_lb_wk);
  assert.equal(path.weight.trend_words, one.rate_words);
  assert.equal(path.weight.verdict, one.verdict);
  assert.equal(path.weight.line, one.line);

  // The goal-pace read (Body page and Season charts) at every window the clients ask for.
  for (const days of [21, 30, 90, 180]) {
    const gp = goalPaceResponse(days);
    assert.equal(gp.read.rate_lb_wk, one.rate_lb_wk, `goal-pace ?days=${days}`);
    assert.equal(gp.read.verdict, one.verdict);
    assert.equal(gp.read.line, one.line);
  }

  // The week page's weight goal.
  const week = weekRead(today);
  assert.equal(week.weight_trend.rate_lb_wk, one.rate_lb_wk);
  const goal = week.goals.find((g) => g.key === "weight");
  if (goal) assert.equal(goal.line, one.line);

  // Every rate printed anywhere in those reads and the conductor is the one rate or the ask.
  const focus = getCoachingFocus();
  const printed = JSON.stringify([path, week.goals, focus]).match(RATE) ?? [];
  assert.ok(printed.length > 0, "the rate is printed somewhere");
  const allowed = new Set([one.rate_words, one.needed_words].filter(Boolean));
  // (No lift is logged in this picture, so every lb/wk printed is a bodyweight rate.)
  for (const rate of printed) {
    assert.ok(allowed.has(rate), `printed ${rate}; the one read says ${[...allowed].join(" / ")}`);
  }
});

test("a kilograms athlete reads the same trend in kg", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedCut();
  repo.setSettings({ weight_units: "kg" });
  const today = localDateISO();
  const one = weightTrendRead(today);
  assert.equal(one.units, "kg");
  assert.match(one.rate_words, /kg\/wk$/);
  assert.match(one.current.words, / kg$/);
  const path = todayPath(today);
  assert.equal(path.weight.trend_words, one.rate_words);
  assert.match(path.weight.current_text, / kg$/);
  assert.doesNotMatch(JSON.stringify(path.weight.line), /lb/);
});
