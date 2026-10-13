// The first-week reveal at the end of Meet shows the WHOLE week — runs included — from
// the run engine's actual placements (planWeek, the same source Today's strip reads), not
// the lifting days alone. A week with no weekdays to stand on keeps the lift-only rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { applyOnboardParsed, emptyOnboardApplied, welcomeCalendarWeek } from "../dist/coachOps.js";
import { setProfile } from "../dist/repo/profile.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { loadClientModule } from "./_dom.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

function hybridWeek() {
  const today = localDateISO();
  setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Half marathon", date: addDaysISO(today, 42), distance_km: 21.1 },
  });
  applyOnboardParsed(
    {
      lift_days: [1, 2, 4, 5],
      endurance_schedule: {
        days: [
          { dow: 3, kind: "quality" },
          { dow: 6, kind: "long" },
          { dow: 0, kind: "easy" },
        ],
      },
    },
    emptyOnboardApplied()
  );
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  repo.savePlanDay(2, "Lower", "lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  return today;
}

test("the reveal's week is the calendar's: every lift and every run on the weekday it lands", () => {
  const today = hybridWeek();
  const rows = welcomeCalendarWeek(today);
  assert.ok(rows?.length, "a week to show");
  const cal = planWeek(today);
  for (const cell of cal.days) {
    const row = rows.find((r) => r.dow === cell.dow);
    const lift = cell.plan_day && cell.plan_day.day_type !== "rest";
    const run = cell.run && !cell.run.rested;
    if (!lift && !run) {
      assert.equal(row, undefined, `${cell.weekday} is rest on the calendar, so not in the reveal`);
      continue;
    }
    assert.ok(row, `${cell.weekday} is on the calendar, so in the reveal`);
    if (lift) assert.equal(row.day_number, cell.plan_day.day_number);
    if (run) assert.equal(row.run, cell.run.label);
    else assert.equal(row.run, undefined);
  }
  assert.ok(
    rows.some((r) => r.run),
    "runs are in the reveal"
  );
  assert.ok(
    rows.filter((r) => r.day_number == null).every((r) => [0, 3, 6].includes(r.dow)),
    "a run-only day is a stated run day"
  );
});

test("no weekdays known: no calendar week (the lift-only rows stand)", () => {
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  assert.equal(welcomeCalendarWeek(localDateISO()), null);
});

// ---------- client: the reveal paints the runs ----------

function client() {
  return loadClientModule(["html-utils", "ui-stone-model", "ui-stone", "welcome-model", "welcome-client"]);
}

test("weekRows keeps the run, and a run-only day reads as a run", () => {
  const { CairnWelcomeModel: m } = client();
  const rows = m.weekRows([
    { dow: 3, day_number: null, name: "Quality run", run: "Quality run" },
    { dow: 1, day_number: 1, name: "Upper" },
    { dow: 2, day_number: 2, name: "Lower", run: "Easy run" },
  ]);
  assert.deepEqual(plain(rows.map((r) => [r.day, r.name, r.lift, r.run])), [
    ["Mon", "Upper", true, null],
    ["Tue", "Lower", true, "Easy run"],
    ["Wed", "Quality run", false, "Quality run"],
  ]);
});

test("the reveal strip lays an endurance stone on a run-only day, and the run label is escaped", () => {
  const win = client();
  const m = win.CairnWelcomeModel;
  const html = win.CairnWelcomeClient.revealHtml({
    reply: "",
    week: m.weekRows([
      { dow: 1, day_number: 1, name: "Upper" },
      { dow: 2, day_number: 2, name: "Lower", run: "<b>Easy</b> run" },
      { dow: 3, day_number: null, name: "Quality run", run: "Quality run" },
    ]),
    weekNote: null,
    fuel: null,
  });
  assert.match(html, /wel-strip-d is-run/);
  assert.equal((html.match(/wel-strip-d is-lift/g) || []).length, 2);
  assert.match(html, /class="wel-wk is-run reveal"/);
  assert.match(html, /Lower<span class="wel-wk-r"> · &lt;b&gt;Easy&lt;\/b&gt; run<\/span>/);
  assert.doesNotMatch(html, /<b>Easy/);
});
