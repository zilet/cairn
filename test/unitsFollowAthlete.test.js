// Units and dates follow the athlete (docs/IA.md principle 5): every sentence the server
// writes is already in the athlete's units — distance km|mi, weight lb|kg — through the
// one formatter (src/repo/display-words.ts), and no athlete-facing string carries a
// machine date. One seeded picture (a plan, runs, a dated half, a cut, an anchor lift)
// is read by every prose builder Horizon, Today and Train print — the day detail for
// each day of the fortnight, the race build, the conductor, Today's path, the plan strip
// and the week read — and every string field is deep-scanned for the other unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo, seedWeight } from "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { raceBuild } from "../dist/repo/race-build.js";
import { getCoachingFocus } from "../dist/repo/coach.js";
import { todayPath } from "../dist/repo/today-path.js";
import { addDaysISO, mondayOf } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { athleteUnits } from "../dist/repo/settings.js";
import {
  distanceWords,
  loadWords,
  paceWords,
  weightRateWords,
  weightWords,
  unitsRegistryRead,
} from "../dist/repo/display-words.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Tuesday 2026-09-22: a race four weeks out, a week of logs behind.
const NOW = new Date("2026-09-22T12:00:00");

// Machine fields: dates, keys, links, the engine's raw rep words. Everything else a
// renderer may print.
const MACHINE_KEY =
  /(^|_)(date|dates|key|id|ids|href|as_of|today|week_start|week_end|since|until|through|trail_start|units|run_units|weight_units|on|off|kind|status|source|code|stage|mode)$/;
// Stored text the athlete (or an agent on their behalf) wrote, carried verbatim: a plan
// item's own note is data, not a sentence the server composes.
const STORED_TEXT = /\.exercises\[\d+\]\.note$/;

function scan(value, path, out, bad) {
  if (STORED_TEXT.test(path)) return;
  if (typeof value === "string") {
    for (const re of bad) if (re.test(value)) out.push(`${path}: ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, out, bad));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (MACHINE_KEY.test(k)) continue;
      scan(v, `${path}.${k}`, out, bad);
    }
  }
}

const KM_TEXT = /\d\s?km\b|\/km\b/;
const MI_TEXT = /\d\s?mi\b|\/mi\b/;
const LB_TEXT = /\d\s?lb\b|lb\/wk/;
const KG_TEXT = /\d\s?kg\b|kg\/wk/;
const ISO_TEXT = /\b\d{4}-\d{2}-\d{2}\b/;
const DOUBLE_UNIT = /\b(lb|kg|km|mi)\s*\1\b/i;
const GLUED_DOUBLE = /\d(lb|kg|km|mi) \1\b/i;

function seedPicture() {
  seedDemo();
  const today = localDateISO();
  const shift = (n) => addDaysISO(today, n);
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date: "2026-10-18", distance_km: 21.1, target: "sub-1:45" },
    goal_mode: "lose",
    goal_weight_lb: 154,
    goal_date: shift(70),
    start_weight_lb: 184.3,
    start_date: shift(-120),
  });
  for (let d = 21; d >= 0; d -= 2) seedWeight(shift(-d), Math.round((165 + d * 0.13) * 10) / 10);
  repo.upsertGarminDailyMetric({ date: shift(-30), race_predict_half_sec: 6700 });
  repo.upsertGarminDailyMetric({ date: shift(-2), race_predict_half_sec: 6300 });
  repo.setStrengthObjective({ exercise: "Deadlift", target_kind: "explicit_est_1rm", target_est_1rm: 340 });
}

/** Every prose builder's read for the seeded picture. */
function reads() {
  const today = localDateISO();
  const out = {
    raceBuild: raceBuild(today, { describeRunning: true }),
    coachingFocus: getCoachingFocus(),
    todayPath: todayPath(today),
    planWeek: planWeek(today),
    weekRead: weekRead(today),
    nextWeekRead: weekRead(addDaysISO(mondayOf(today), 7)),
  };
  for (let d = mondayOf(today); d <= addDaysISO(mondayOf(today), 13); d = addDaysISO(d, 1)) {
    out[`dayDetail ${d}`] = dayDetail(d);
  }
  return out;
}

function offenders(all, bad) {
  const found = [];
  for (const [name, read] of Object.entries(all)) scan(read, name, found, bad);
  return found;
}

test("a miles-and-kilograms athlete reads no km and no lb anywhere the server writes", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedPicture();
  repo.setSettings({ run_units: "mi", weight_units: "kg" });
  assert.deepEqual(athleteUnits(), { distance: "mi", weight: "kg" });
  const all = reads();
  const km = offenders(all, [KM_TEXT]);
  assert.deepEqual(km, [], `km in a miles athlete's prose:\n${km.join("\n")}`);
  const lb = offenders(all, [LB_TEXT]);
  assert.deepEqual(lb, [], `lb in a kilograms athlete's prose:\n${lb.join("\n")}`);
  // The picture is not empty: miles and kilograms are actually said.
  const said = JSON.stringify(all);
  assert.match(said, /\d mi\b/);
  assert.match(said, /\d kg\b/);
});

test("a km-and-pounds athlete reads no miles and no kilograms", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedPicture();
  repo.setSettings({ run_units: "km", weight_units: "lb" });
  const all = reads();
  const mi = offenders(all, [MI_TEXT]);
  assert.deepEqual(mi, [], `miles in a km athlete's prose:\n${mi.join("\n")}`);
  const kg = offenders(all, [KG_TEXT]);
  assert.deepEqual(kg, [], `kg in a pounds athlete's prose:\n${kg.join("\n")}`);
});

test("no machine date and no doubled unit in any athlete-facing string", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedPicture();
  for (const units of [
    { run_units: "km", weight_units: "lb" },
    { run_units: "mi", weight_units: "kg" },
  ]) {
    repo.setSettings(units);
    const all = reads();
    const doubled = offenders(all, [DOUBLE_UNIT, GLUED_DOUBLE]);
    assert.deepEqual(doubled, [], `a unit said twice:\n${doubled.join("\n")}`);
    const iso = offenders(all, [ISO_TEXT]);
    assert.deepEqual(iso, [], `a machine date in prose:\n${iso.join("\n")}`);
  }
});

test("the one formatter: units, never a unit twice", () => {
  assert.equal(distanceWords(5, "km"), "5 km");
  assert.equal(distanceWords(5, "mi"), "3.1 mi");
  assert.equal(distanceWords(31.4, "km", { approx: true, whole: true }), "~31 km");
  assert.equal(paceWords(371, "km"), "6:11/km");
  assert.equal(paceWords(371, "mi"), "9:57/mi");
  assert.equal(paceWords(371, "km", { spaced: true }), "6:11 /km");
  assert.equal(weightWords(159.6, "lb"), "159.6 lb");
  assert.equal(weightWords(159.6, "kg"), "72.4 kg");
  assert.equal(weightRateWords(-0.93, "lb"), "−0.9 lb/wk");
  assert.equal(weightRateWords(-0.93, "kg"), "−0.4 kg/wk");
  assert.equal(loadWords(185, "lb"), "185 lb");
  assert.equal(loadWords(185, "kg"), "84 kg");
  assert.equal(loadWords(-30, "lb"), "30 lb assist");
  assert.equal(loadWords(null, "kg"), "bodyweight");
  for (const s of [weightWords(159.6, "lb"), distanceWords(5, "mi"), loadWords(185, "kg")]) {
    assert.doesNotMatch(s, DOUBLE_UNIT);
    assert.doesNotMatch(s, GLUED_DOUBLE);
  }
});

test("the units registry: one entry per kind, Settings the only writer", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  assert.deepEqual(athleteUnits(), { distance: "km", weight: "lb" }, "defaults: km and lb");
  repo.setSettings({ weight_units: "kg" });
  assert.equal(athleteUnits().weight, "kg");
  repo.setSettings({ weight_units: "stone" });
  assert.equal(athleteUnits().weight, "kg", "an unknown unit keeps what is stored");
  const registry = unitsRegistryRead(athleteUnits());
  assert.deepEqual(
    registry.map((r) => [r.kind, r.setting, r.options.map((o) => o.value), r.default, r.value]),
    [
      ["distance", "run_units", ["km", "mi"], "km", "km"],
      ["weight", "weight_units", ["lb", "kg"], "lb", "kg"],
    ]
  );
});

function serverFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "client") continue;
      out.push(...serverFiles(p));
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("the conversion constants are defined once on the server", () => {
  const files = serverFiles(join(root, "src"));
  const hits = (re) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));
  assert.deepEqual(hits(/1\.6093/), ["src/repo/display-words.ts"], "km per mile");
  assert.deepEqual(hits(/2\.2046|0\.4535/), ["src/repo/display-words.ts"], "lb per kg");
});
