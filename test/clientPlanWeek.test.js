// clientPlanWeek.test.js — Plan week strip HTML helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escAttr(value) {
  return escHtml(value).replaceAll('"', "&quot;");
}

function stagger() {
  return "";
}

function loadPlanWeek() {
  const context = { Object, Array, String, Map, Number, escHtml, escAttr, stagger };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-week-client.js"), "utf8"), context);
  return context.CairnPlanWeek;
}

test("Plan week strip renders calendar cells with escaped labels", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    as_of: "2026-04-20",
    week_start: "2026-04-20",
    days: [
      {
        date: "2026-04-20",
        weekday: "Mon",
        dow: 1,
        status: "today",
        plan_day: {
          day_number: 1,
          name: "Push <A>",
          focus: "Upper",
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
        },
        session: null,
        run: null,
        hard: false,
      },
      {
        date: "2026-04-21",
        weekday: "Tue",
        dow: 2,
        status: "upcoming",
        plan_day: null,
        session: null,
        run: {
          kind: "easy",
          label: "Z2 <run>",
          status: "open",
          suggested_date: "2026-04-21",
          completion_date: null,
          km: 6,
        },
        hard: false,
      },
    ],
    summary: "Keep it <steady>",
    progress: {
      lift_days_done: 1,
      lift_days_planned: 3,
      runs_done: 0,
      run_km: 0,
      longest_run_km: null,
      runs_open: [],
      prs: 0,
      line: "One of three lifting days in. <grounded>",
    },
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: ["Monday"], lift_days_source: "stated", run_days: [] },
  });

  assert.match(html, /This week/);
  assert.match(html, /pweek-lift/);
  assert.match(html, /pweek-run/);
  // The cell speaks the plan day's short NAME, not its focus sentence.
  assert.match(html, /Push &lt;A&gt;/);
  assert.doesNotMatch(html, /Upper/);
  assert.match(html, /Z2 &lt;run&gt; 6 km/);
  assert.match(html, /pweek-progress/);
  assert.match(html, /One of three lifting days in\. &lt;grounded&gt;/);
  assert.match(html, /Keep it &lt;steady&gt;/);
  assert.doesNotMatch(html, /Push <A>|Z2 <run>|Keep it <steady>/);
});

test("a done cell with a session speaks the session's title, with the run beside it", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    days: [
      {
        date: "2026-04-20",
        weekday: "Mon",
        dow: 1,
        status: "done",
        plan_day: {
          day_number: 2,
          name: "Push",
          focus: "Shoulders, chest, triceps",
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
        },
        session: { id: 7, title: "Lower A", date: "2026-04-20" },
        run: {
          kind: "long",
          label: "Long run",
          status: "completed",
          suggested_date: null,
          completion_date: "2026-04-20",
          km: 9.8,
        },
        hard: true,
      },
    ],
    summary: null,
    progress: {
      lift_days_done: 1,
      lift_days_planned: 5,
      runs_done: 1,
      run_km: 9.8,
      longest_run_km: 9.8,
      runs_open: [],
      prs: 0,
      line: null,
    },
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  });
  assert.match(html, /Lower A · Long run 9\.8 km/);
  assert.doesNotMatch(html, /Shoulders, chest/);
  assert.match(html, /Done · Mon/);
});

test("a covered template run day says where the run landed", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    days: [
      {
        date: "2026-04-25",
        weekday: "Sat",
        dow: 6,
        status: "open",
        plan_day: {
          day_number: 7,
          name: "Long Run",
          focus: "Aerobic endurance",
          purpose: null,
          day_type: "training",
          role: "endurance",
          out_of_order: false,
        },
        session: null,
        run: {
          kind: "long",
          label: "Long run",
          status: "completed",
          suggested_date: null,
          completion_date: "2026-04-23",
          km: 9.8,
        },
        hard: true,
      },
    ],
    summary: null,
    progress: {
      lift_days_done: 0,
      lift_days_planned: null,
      runs_done: 1,
      run_km: 9.8,
      longest_run_km: 9.8,
      runs_open: [],
      prs: 0,
      line: null,
    },
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  });
  assert.match(html, /Long run 9\.8 km · done Thu/);
  assert.match(html, /Sat · Covered/);
  assert.doesNotMatch(html, /Up next/);
});

test("Plan week strip omits empty weeks", () => {
  const week = loadPlanWeek();
  assert.equal(week.stripHtml(null), "");
  assert.equal(week.stripHtml({ days: [] }), "");
});

test("annotationsByDayNumber prefers today/done for a repeated day", () => {
  const week = loadPlanWeek();
  const map = week.annotationsByDayNumber({
    days: [
      { weekday: "Mon", status: "upcoming", plan_day: { day_number: 1 } },
      { weekday: "Thu", status: "today", plan_day: { day_number: 1 } },
    ],
  });
  assert.equal(map.get(1).status, "today");
  assert.equal(map.get(1).weekday, "Thu");
});

test("layout suggestion surfaces when unclean", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    days: [
      {
        date: "2026-04-20",
        weekday: "Mon",
        dow: 1,
        status: "open",
        plan_day: {
          day_number: 1,
          name: "Legs",
          focus: "Lower",
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
        },
        session: null,
        run: null,
        hard: true,
      },
    ],
    summary: null,
    layout: { clean: false, suggestion: "Move Legs off Saturday's long run." },
    schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  });
  assert.match(html, /Move Legs off Saturday/);
  assert.match(html, /is-hard/);
});
