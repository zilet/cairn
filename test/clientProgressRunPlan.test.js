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
  // The lead sentence and the calibration line rotate through the shared
  // pickDayVariant, so the real rotation has to be in scope. date-utils also
  // defines absDate/humanDate, which the assertions below want stubbed — restore
  // the stubs after loading it (the render functions resolve them at call time).
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  Object.assign(context, {
    absDate: (date) => `ABS:${date}`,
    humanDate: (date) => `HUMAN:${date}`,
  });
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-run-plan-client.js"), "utf8"), context);
  return context.CairnProgressRunPlan;
}

// A minimal agenda whose one intent is whatever a case needs.
function agendaWith(intents, extra = {}) {
  return { available: true, week_start: "2026-08-03", week_end: "2026-08-09", as_of: "2026-08-05", intents, why: "", next: null, today_guidance: "open", ...extra };
}

function runIntent(kind, status, completion = null, target_distance_km = null) {
  return {
    id: `week:${kind}:1`,
    kind,
    label: `${kind} run`,
    status,
    provisional_day_number: 3,
    provisional_date: "2026-08-05",
    window_start: "2026-08-03",
    window_end: "2026-08-09",
    suggested_date: status === "open" ? "2026-08-06" : null,
    target_distance_km,
    target_duration_min: null,
    target_zone: "Z2",
    completion,
    rationale: "",
  };
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

// The bug this replaced: the lead sentence read ONLY the live prescription, so it
// went on naming the long run the athlete had already finished. Completion lives
// in the agenda, which the same controller already fetches.
test("the endurance lead speaks to a banked long run, not the prescription it already satisfied", () => {
  const runPlan = loadRunPlan();
  const plan = { available: true, runs: [{ kind_label: "long", target_distance_km: 4.9 }] };

  const banked = runPlan.enduranceCoachLine(
    plan,
    agendaWith([runIntent("long", "completed", { activity_id: 4, date: "2026-08-04", duration_min: 52, distance_km: 9.1, intensity: "easy", signals: [] })])
  );
  assert.match(banked, /9\.1/, "the banked sentence carries the ACTUAL completed distance");
  assert.doesNotMatch(banked, /4\.9/, "the satisfied prescription is never quoted back");
  assert.doesNotMatch(banked, /is the one that matters/);
  assert.match(banked, /prog-headline/);

  // A completion with no distance still reads as banked rather than falling back.
  const bankedByTime = runPlan.enduranceCoachLine(
    plan,
    agendaWith([runIntent("long", "completed", { activity_id: 5, date: "2026-08-04", duration_min: 52, distance_km: null, intensity: "easy", signals: [] })])
  );
  assert.doesNotMatch(bankedByTime, /is the one that matters/);
  assert.match(bankedByTime, /long/i);

  // An OPEN long intent leaves the prescription sentence exactly as it was.
  const open = runPlan.enduranceCoachLine(plan, agendaWith([runIntent("long", "open", null, 4.9)]));
  assert.match(open, /4\.9 km long run is the one that matters/);

  // Quality speaks only when there is no long run to lead with.
  const qualityOnly = runPlan.enduranceCoachLine(
    { available: true, runs: [{ kind_label: "quality", target_distance_km: 8 }] },
    agendaWith([runIntent("quality", "completed", { activity_id: 6, date: "2026-08-04", duration_min: 40, distance_km: 8.2, intensity: "quality", signals: [] })])
  );
  assert.match(qualityOnly, /quality/i);
  assert.doesNotMatch(qualityOnly, /is the one that matters/);

  // A completed quality alongside a still-open long keeps the long as the headline.
  const qualityUnderOpenLong = runPlan.enduranceCoachLine(plan, agendaWith([
    runIntent("long", "open", null, 4.9),
    runIntent("quality", "completed", { activity_id: 7, date: "2026-08-04", duration_min: 40, distance_km: 8.2, intensity: "quality", signals: [] }),
  ]));
  assert.match(qualityUnderOpenLong, /4\.9 km long run is the one that matters/);

  // No agenda at all → byte-for-byte the old behavior.
  assert.equal(runPlan.enduranceCoachLine(plan), runPlan.enduranceCoachLine(plan, null));
  assert.equal(runPlan.enduranceCoachLine(plan, agendaWith([])), runPlan.enduranceCoachLine(plan));
  assert.equal(runPlan.enduranceCoachLine(plan, { available: false, intents: [] }), runPlan.enduranceCoachLine(plan));
  assert.equal(runPlan.enduranceCoachLine(null, agendaWith([])), "");
});

test("the banked sentence rotates by date and escapes everything it renders", () => {
  const runPlan = loadRunPlan();
  const completion = { activity_id: 4, date: "2026-08-04", duration_min: 52, distance_km: 9.1, intensity: "easy", signals: [] };
  const seen = new Set();
  for (const asOf of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]) {
    const html = runPlan.enduranceCoachLine(null, agendaWith([runIntent("long", "completed", completion)], { as_of: asOf }));
    assert.match(html, /9\.1/);
    assert.doesNotMatch(html, /\{dose\}/, "the placeholder is always filled");
    seen.add(html);
  }
  assert.ok(seen.size > 1, "a stable input must not print one literal every morning");
  // Same day + same input ⇒ the same sentence.
  const twice = ["a", "b"].map(() =>
    runPlan.enduranceCoachLine(null, agendaWith([runIntent("long", "completed", completion)], { as_of: "2026-08-05" }))
  );
  assert.equal(twice[0], twice[1]);
});

test("the calibration line stays quiet without endurance items and speaks in freshness words", () => {
  const runPlan = loadRunPlan();
  assert.equal(runPlan.enduranceCalibrationLine(null), "");
  assert.equal(runPlan.enduranceCalibrationLine({ as_of: "2026-08-05", items: [] }), "", "the empty skeleton renders nothing");
  assert.equal(
    runPlan.enduranceCalibrationLine({
      as_of: "2026-08-05",
      items: [{ key: "bench", domain: "strength", label: "Your bench 1RM", last_anchored: null, freshness: "stale", due: true }],
    }),
    "",
    "a strength-only status never renders on the Endurance page"
  );

  const stale = runPlan.enduranceCalibrationLine({
    as_of: "2026-08-05",
    items: [
      { key: "easy_pace", domain: "endurance", label: "Your easy pace", last_anchored: "2026-08-01", freshness: "anchored", due: false },
      { key: "lthr", domain: "endurance", label: "Your threshold <HR>", last_anchored: "2026-02-01", freshness: "stale", due: true },
    ],
  });
  assert.match(stale, /Anchors/);
  assert.match(stale, /Your threshold &lt;HR&gt;/, "the label is escaped");
  assert.doesNotMatch(stale, /<HR>/);
  assert.doesNotMatch(stale, /\d+ day|score|\bmust\b/i, "no counts, no scores, no gate language");

  const anchored = runPlan.enduranceCalibrationLine({
    as_of: "2026-08-05",
    items: [{ key: "lthr", domain: "endurance", label: "Your threshold HR", last_anchored: "2026-08-01", freshness: "anchored", due: false }],
  });
  assert.match(anchored, /Your threshold HR/);
  assert.notEqual(anchored, stale, "the worst-anchored item leads");
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
