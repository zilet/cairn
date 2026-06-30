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
