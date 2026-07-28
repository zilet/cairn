import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadRunPlan() {
  const context = {
    Object,
    String,
    absDate: (date) => `ABS:${date}`,
    humanDate: (date) => `HUMAN:${date}`,
    cardioPrescription: (item) =>
      [item.target_distance_km ? `${item.target_distance_km} km` : null, item.target_zone, item.note].filter(Boolean).join(" · "),
    fmtKm: (km) => Number(km).toFixed(1),
    stagger: (idx) => `--i:${idx}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-run-plan-client.js"), "utf8"), context);
  return context.CairnProgressRunPlan;
}

test("progress run plan renders weekly runs safely", () => {
  const runPlan = loadRunPlan();
  const html = runPlan.weeklyRunPlanCard({
    available: true,
    mix_summary: "2 easy + 1 quality",
    quality_focus: "Tempo <work>",
    why: "Build without rushing",
    rationale: ["Keep easy easy <now>"],
    runs: [
      { kind_label: "quality", label: "Tempo", target_distance_km: 8, target_zone: "Z3", note: "controlled <pace>" },
      { kind_label: "long", target_distance_km: 12, target_zone: "Z2" },
    ],
  });

  assert.match(html, /wrun-quality/);
  assert.match(html, /wrun-long/);
  assert.match(html, /Tempo &lt;work&gt;/);
  assert.match(html, /controlled &lt;pace&gt;/);
  assert.match(html, /Keep easy easy &lt;now&gt;/);
  assert.doesNotMatch(html, /<work>|<pace>|<now>/);
  assert.equal(runPlan.weeklyRunPlanCard({ available: false, runs: [] }), "");
});

test("progress run plan renders goal, compliance, and coach lead", () => {
  const runPlan = loadRunPlan();

  const goal = runPlan.enduranceGoalCard({
    mode: "race",
    phase: "sharpen",
    event: "City 10k <A>",
    distance_km: 10,
    target: "sub-50",
    date: "2026-08-01",
    days_to_race: 10,
  });
  assert.match(goal, /Sharpening/);
  assert.match(goal, /City 10k &lt;A&gt;/);
  assert.match(goal, /10 days to go/);
  assert.match(goal, /ABS:2026-08-01/);

  const standing = runPlan.enduranceGoalCard({ mode: "standing", label: "trail-ready", distance_km: 21, weekly_km: 40 });
  assert.match(standing, /Staying trail-ready/);
  assert.match(standing, /21 km · ~40 km\/wk/);

  assert.match(runPlan.runComplianceLine({ in_words: "32 of 40 km", prescribed_sessions: 4, actual_sessions: 3 }), /32 of 40 km/);
  assert.equal(runPlan.runComplianceLine({ in_words: "nothing", prescribed_sessions: 0, actual_sessions: 0 }), "");

  const coach = runPlan.enduranceCoachLine({ runs: [{ kind_label: "long", target_distance_km: 14 }] });
  assert.match(coach, /14\.0 km long run is the one that matters/);
  assert.equal(runPlan.runKindLabel("quality"), "Quality");
  assert.equal(runPlan.runKindClass("other"), "wrun-easy");
});

test("rolling training agenda renders movable openings and actual completion evidence safely", () => {
  const runPlan = loadRunPlan();
  const html = runPlan.trainingAgendaCard({
    available: true,
    why: "Actual work <moves> the week.",
    next: {
      intent_id: "week:quality:1",
      kind: "quality",
      suggested_date: "2026-07-30",
      guidance: "movable",
    },
    intents: [
      {
        id: "week:easy:1",
        kind: "easy",
        label: "Easy <reset>",
        status: "completed",
        provisional_day_number: 2,
        provisional_date: "2026-07-28",
        window_start: "2026-07-28",
        window_end: "2026-08-02",
        suggested_date: null,
        target_distance_km: 6,
        target_duration_min: null,
        target_zone: "Z2",
        completion: {
          activity_id: 9,
          date: "2026-07-29",
          duration_min: 36,
          distance_km: 6.2,
          intensity: "easy",
          signals: ["watch <easy> evidence"],
        },
        rationale: "done",
      },
      {
        id: "week:quality:1",
        kind: "quality",
        label: "Tempo",
        status: "open",
        provisional_day_number: 4,
        provisional_date: "2026-07-30",
        window_start: "2026-07-28",
        window_end: "2026-08-02",
        suggested_date: "2026-07-30",
        target_distance_km: 8,
        target_duration_min: null,
        target_zone: "Z3",
        completion: null,
        rationale: "open",
      },
    ],
  });

  assert.match(html, /Movable running week/);
  assert.match(html, /Done · Easy/);
  assert.match(html, /Completed HUMAN:2026-07-29/);
  assert.match(html, /6\.2 km · 36 min · easy effort matched/);
  assert.match(html, /Open · Quality/);
  assert.match(html, /Suggested opening HUMAN:2026-07-30/);
  assert.match(html, /Flexible window HUMAN:2026-07-28–HUMAN:2026-08-02/);
  assert.match(html, /Nothing unfinished is owed as catch-up/);
  assert.match(html, /Easy &lt;reset&gt;|Easy &amp;lt;reset&amp;gt;/);
  assert.doesNotMatch(html, /<moves>|<reset>|<easy>/);
  assert.equal(runPlan.trainingAgendaCard({ available: false, intents: [] }), "");

  const noOpening = runPlan.trainingAgendaCard({
    available: true,
    why: "No piling.",
    next: null,
    intents: [
      {
        id: "week:long:1",
        kind: "long",
        label: "Long run",
        status: "open",
        provisional_day_number: 6,
        provisional_date: "2026-08-01",
        window_start: "2026-08-01",
        window_end: "2026-08-02",
        suggested_date: null,
        target_distance_km: 12,
        target_duration_min: null,
        target_zone: "Z2",
        completion: null,
        rationale: "No clean opening.",
      },
    ],
  });
  assert.match(noOpening, /No clean opening remains this week/);
  assert.doesNotMatch(noOpening, /intentions are covered/);
});
