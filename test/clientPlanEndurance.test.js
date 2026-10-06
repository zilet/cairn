import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { createDocument, createHost, loadClientModule } from "./_dom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPlanEnduranceClient() {
  const context = {
    Array,
    Object,
    String,
    Number,
    Date,
    Math,
    runTargetText: (run) => `${run.target_distance_km || 0} km @ ${run.target_zone || "easy"}`,
    stagger: (index) => `--i:${index}`,
    isCardioItem: () => false,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/format-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-briefing-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-client.js"), "utf8"), context);
  return { ...context.CairnPlanEndurance, ...context.CairnPlanEnduranceBriefing };
}

// Loads the real module (model + briefing + screen) on the shared DOM harness, with
// every other global paintPlanEndurance touches, so the painted #endPlanBody can be
// queried the way the renderer actually emitted it. The race view controller is a
// recording stub: the screen only decides whether to mount it and with what.
function loadPlanEnduranceForPaint({ raceController = true } = {}) {
  const document = createDocument();
  const view = createHost(document, { html: `<div id="endPlanBody"></div>` });
  const mounts = [];
  const win = loadClientModule(
    ["html-utils", "plan-endurance-model", "plan-endurance-briefing-client", "plan-endurance-client"],
    {
      document,
      globals: {
        view,
        stagger: (index) => `--i:${index}`,
        humanDate: (iso) => String(iso || ""),
        fmtKm: (km) => String(km),
        fmtDist: (km, units) => (units === "mi" ? `${Number(km) / 1.609344} mi` : `${km} km`),
        enduranceGoalCard: (goal) => `<div class="end-goal">${String(goal?.event || "")}</div>`,
        runComplianceLine: () => "",
        api: async () => null,
        ...(raceController
          ? {
              CairnRaceViewController: {
                mount: (host, deps) => {
                  mounts.push({ host, deps });
                  return () => {};
                },
              },
            }
          : {}),
      },
    }
  );
  return { win, body: view.querySelector("#endPlanBody"), mounts };
}

const RACE_GOAL = { mode: "race", phase: "build", event: "Fall Half", weeks_to_race: 4 };
const BUILD = { available: true, race: { weeks_to_race: 4, phase: "build", date: "2026-11-01" }, weeks: [] };

test("plan endurance mounts the race view as the race surface, in place of the goal card, ramp and compact card", () => {
  const { win, body, mounts } = loadPlanEnduranceForPaint();

  win.paintPlanEndurance(RACE_GOAL, null, null, {}, BUILD);

  const slot = body.querySelector("#endRaceSlot");
  assert.ok(slot, "the race view has its slot");
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].host, slot);
  assert.equal(mounts[0].deps.initial, BUILD, "the build already read is painted at once, not fetched twice");
  assert.equal(mounts[0].deps.units, "km");
  assert.equal(typeof mounts[0].deps.load, "function");
  // One race surface: no generic ramp, no goal card repeating the countdown, no
  // compact race-build card with its "rest of the program" fold.
  assert.equal(body.querySelector(".end-ramp"), null);
  assert.equal(body.querySelector(".end-goal"), null);
  assert.equal(body.querySelector(".rbuild-more"), null);
  assert.equal(body.querySelector("[data-race-build]"), null);
});

test("plan endurance keeps the goal card and ramp when the build is unavailable", () => {
  const { win, body, mounts } = loadPlanEnduranceForPaint();

  win.paintPlanEndurance(RACE_GOAL, null, null, {}, { available: false, reason: "The race has no distance yet." });

  assert.equal(body.querySelector("#endRaceSlot"), null);
  assert.equal(mounts.length, 0);
  assert.ok(body.querySelector(".end-ramp"));
  assert.equal(body.querySelector(".end-goal").textContent, "Fall Half");
});

test("a failed race-build read still mounts the race view for a race goal, so it can offer to try again", () => {
  const { win, body, mounts } = loadPlanEnduranceForPaint();

  win.paintPlanEndurance(RACE_GOAL, null, null, {}, null);

  assert.ok(body.querySelector("#endRaceSlot"));
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].deps.initial, null, "nothing in hand: the view loads (and says so if it fails)");
  assert.equal(body.querySelector(".end-ramp"), null);
});

test("a standing goal never mounts the race view", () => {
  const { win, body, mounts } = loadPlanEnduranceForPaint();

  win.paintPlanEndurance({ mode: "standing", label: "10K-ready", weekly_km: 25 }, null, null, {}, null);

  assert.equal(body.querySelector("#endRaceSlot"), null);
  assert.equal(mounts.length, 0);
  assert.ok(body.querySelector(".end-ramp-note"));
});

test("plan endurance never crashes when the race view controller is not loaded", () => {
  const { win, body } = loadPlanEnduranceForPaint({ raceController: false });

  win.paintPlanEndurance(RACE_GOAL, null, null, {}, BUILD);

  assert.ok(body.querySelector("#endRaceSlot"));
  assert.equal(body.querySelector("#endRaceSlot").innerHTML, "");
});

test("plan endurance helper renders the current race phase ramp", () => {
  const endurance = loadPlanEnduranceClient();

  assert.equal(endurance.rampHtml({ mode: "standing", phase: "build" }), "");
  const html = endurance.rampHtml({ mode: "race", phase: "build" });
  assert.match(html, /The ramp to race day/);
  assert.match(html, /class="ramp-step is-done"/);
  assert.match(html, /class="ramp-step is-current"/);
  assert.match(html, /You're here/);
  assert.match(html, /--i:1/);
});

test("plan endurance helper chooses race and standing presets", () => {
  const endurance = loadPlanEnduranceClient();
  const race = endurance.presets({ mode: "race" }).map((item) => item.t);
  const standing = endurance.presets({ mode: "standing" }).map((item) => item.t);

  assert.equal(JSON.stringify(race), '["Plan this week\'s runs","Progress my long run","Ease back — feeling flat"]');
  assert.equal(JSON.stringify(standing), '["Plan this week\'s runs","Keep me race-ready","Ease back this week"]');
});

test("plan endurance draft card escapes runs and preserves apply controls", () => {
  const endurance = loadPlanEnduranceClient();
  const html = endurance.draftCardHtml({
    id: '12" onclick="bad',
    agent: "auto <coach>",
    parsed: {
      summary: "Build week <steady>",
      cardio: [
        {
          day_number: "3",
          label: "Tempo <run>",
          target_distance_km: 8,
          target_zone: "Z3 <controlled>",
          reason: "race prep <now>",
        },
      ],
    },
  });

  assert.match(html, /auto &lt;coach&gt; · #12" onclick="bad/);
  assert.match(html, /Build week &lt;steady&gt;/);
  assert.match(html, /Tempo &lt;run&gt;/);
  assert.match(html, /8 km @ Z3 &lt;controlled&gt;/);
  assert.match(html, /race prep &lt;now&gt;/);
  assert.match(html, /data-egapply="12&quot; onclick=&quot;bad"/);
  assert.match(html, /data-egdiscard="12&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(html, /<coach>|<steady>|<run>|data-egapply="12" onclick|data-egdiscard="12" onclick/);
});

test("plan endurance orchestration fetches the live run plan and faces next week when this one is banked", () => {
  const source = readFileSync(join(root, "src/client/plan-endurance-client.ts"), "utf8");
  // This week's reads are network-first with a last-known fallback (CairnOffline).
  assert.match(source, /lastKnown<EnduranceAgenda>\(`\/training-agenda\?date=/);
  assert.match(source, /lastKnown<EnduranceRunPlan>\("\/run-plan"/);
  assert.match(source, /enduranceModel\(\)\.nextMonday\(today\)/);
  assert.match(source, /enduranceModel\(\)\.buildBriefing/);
  assert.match(source, /end-shape-fold/);
  // This week's runs ride in the THIS WEEK card; the connected week strip is Horizon's
  // Week view now, never a second map on the race page.
  assert.match(source, /CairnPlanEnduranceBriefing\.sessionsHtml\(briefing, \{ runs, today \}\)/);
  assert.match(source, /CairnPlanEnduranceBriefing\.nextWeekHtml\(briefing,/);
  assert.doesNotMatch(source, /end-week-fold|loadPlanWeekStrip/);
  assert.match(source, /laterMonday/);
  assert.match(source, /run_units/);
  assert.doesNotMatch(source, /trainingAgendaCard\(agenda\)/);
  assert.doesNotMatch(source, /Your running plan — the build/);
  assert.doesNotMatch(source, /each run lands on its day|>Day \$\{|tempo on Thursday/);
});

test("plan endurance fetches the race build alongside the rest of the segment's reads", () => {
  const source = readFileSync(join(root, "src/client/plan-endurance-client.ts"), "utf8");
  assert.match(source, /lastKnown<EnduranceRaceBuild>\("\/race-build", "horizon:race-build"\)/);
  assert.match(source, /CairnRaceViewController\.mount\(raceSlot/);
  assert.doesNotMatch(source, /raceBuildCard|compact: true/);
  // The one home for runs reads them only from the run endpoints: the lift plan
  // is never fetched or scanned, and there is no "edit runs in Training" door.
  assert.doesNotMatch(source, /api\("\/plan"\)/);
  assert.doesNotMatch(source, /endEditRuns|Edit in Training|edit runs in Training/);
});

test("plan endurance briefing faces the next open run and next week once this week is banked", () => {
  const endurance = loadPlanEnduranceClient();
  const today = "2026-09-16";
  const open = endurance.buildBriefing({
    today,
    agenda: {
      available: true,
      intents: [
        {
          kind: "easy",
          label: "Easy run",
          status: "open",
          provisional_day_number: 2,
          suggested_date: "2026-09-15",
          target_distance_km: 5,
          target_zone: "Z2 (135–145 bpm)",
          completion: null,
        },
        {
          kind: "quality",
          label: "Threshold intervals",
          status: "open",
          provisional_day_number: 5,
          suggested_date: "2026-09-18",
          target_distance_km: 8,
          target_zone: "Z4",
          completion: null,
        },
      ],
    },
    runPlan: {
      available: true,
      week_start: "2026-09-14",
      why: "Build week — the threshold session is the one that matters.",
      runs: [
        {
          day_number: 2,
          kind_label: "easy",
          label: "Easy run",
          target_distance_km: 5,
          target_zone: "Z2 (135–145 bpm)",
          note: "Easy aerobic at Z2 — relaxed and conversational.",
          interval: null,
        },
        {
          day_number: 5,
          kind_label: "quality",
          label: "Threshold intervals",
          target_distance_km: 8,
          target_zone: "Z4",
          note: "5 × 1km at Z4, 60s easy jog between, with warm-up + cool-down.",
          interval: [{ reps: 5, on: "1km", off: "60s jog", zone: "Z4" }],
        },
      ],
    },
    raceBuild: {
      available: true,
      paces: {
        bands: [
          { key: "easy", label: "Easy", text: "6:13–6:43 /km", fast_sec_per_km: 373, slow_sec_per_km: 403 },
          { key: "threshold", label: "Threshold", text: "5:01–5:08 /km", fast_sec_per_km: 301, slow_sec_per_km: 308 },
        ],
      },
      leg_map: [
        {
          day_number: 1,
          weekday: "Monday",
          run: null,
          strength: { name: "Lower A", heavy_lower: true },
          ride: false,
          hard: true,
        },
        {
          day_number: 2,
          weekday: "Tuesday",
          run: { kind: "easy" },
          strength: { name: "Push", heavy_lower: false },
          ride: false,
          hard: false,
        },
        {
          day_number: 5,
          weekday: "Friday",
          run: { kind: "quality" },
          strength: { name: "Chest, back", heavy_lower: false },
          ride: false,
          hard: true,
        },
      ],
    },
  });

  assert.equal(open.horizon, "this_week");
  assert.equal(open.next?.label, "Easy run");
  assert.match(open.next?.when || "", /Tuesday/);
  assert.match(open.next?.prescription || "", /6:13–6:43 \/km/);
  assert.match(open.next?.sitsBy || "", /Push/);
  assert.equal(open.remaining.length, 1);
  assert.equal(open.remaining[0].label, "Threshold intervals");
  assert.match(open.remaining[0].setup, /5 × 1km/);

  const html = endurance.sessionsHtml(open);
  assert.match(html, /class="race-run [^"]*is-next"/);
  assert.match(html, /Easy run/);
  assert.match(html, /Setup/);
  assert.match(html, /Sits by/);
  assert.match(html, /Threshold intervals/);
  // The km / mi switch lives in the page's head, not in the runs.
  assert.doesNotMatch(html, /data-run-units/);
  assert.doesNotMatch(html, /<script>/);

  const miles = endurance.buildBriefing({
    today: "2026-09-14",
    units: "mi",
    runPlan: {
      available: true,
      week_start: "2026-09-14",
      runs: [
        { day_number: 2, kind_label: "easy", label: "Easy run", target_distance_km: 9.4 },
        { day_number: 7, kind_label: "long", label: "Long run", target_distance_km: 9.4 },
      ],
    },
    raceBuild: {
      available: true,
      paces: { bands: [{ key: "easy", label: "Easy", fast_sec_per_km: 373, slow_sec_per_km: 403 }] },
    },
  });
  assert.match(miles.next?.prescription || "", /mi/);
  assert.match(miles.next?.prescription || "", /\/mi/);
  assert.match(endurance.sessionsHtml(miles), /\d mi\b/);

  const banked = endurance.buildBriefing({
    today: "2026-09-20",
    agenda: {
      available: true,
      intents: [
        { kind: "easy", status: "completed", provisional_day_number: 2, completion: { date: "2026-09-15" } },
        { kind: "long", status: "completed", provisional_day_number: 7, completion: { date: "2026-09-20" } },
      ],
    },
    runPlan: {
      available: true,
      week_start: "2026-09-14",
      why: "This week is done.",
      runs: [{ kind_label: "long", day_number: 7 }],
    },
    nextRunPlan: {
      available: true,
      week_start: "2026-09-21",
      why: "Next week steps the long run.",
      runs: [
        {
          day_number: 2,
          kind_label: "easy",
          label: "Easy run",
          target_distance_km: 5,
          note: "Easy aerobic — relaxed and conversational.",
        },
        {
          day_number: 7,
          kind_label: "long",
          label: "Long run",
          target_distance_km: 10,
        },
      ],
    },
    laterRunPlan: {
      available: true,
      week_start: "2026-09-28",
      why: "The week after keeps the same shape.",
      runs: [
        { day_number: 2, kind_label: "easy", label: "Easy run", target_distance_km: 5 },
        { day_number: 7, kind_label: "long", label: "Long run", target_distance_km: 11 },
      ],
    },
  });
  assert.equal(banked.horizon, "next_week");
  assert.equal(banked.kicker, "Next week");
  assert.equal(banked.headline, "Next week steps the long run.");
  assert.equal(banked.next?.label, "Easy run");
  assert.match(banked.next?.when || "", /Next Tuesday/);
  assert.equal(banked.remaining.length, 2, "the review always shows the next two after the featured run");
  assert.equal(banked.remaining[0].label, "Long run");
  assert.equal(banked.later.length, 1);
  assert.match(banked.later[0].when || "", /Oct 4|Sunday/);
  // The runs already in stay in THIS WEEK, never as a bare tick; next week is its own section.
  assert.equal(banked.done.length, 2);
  const bankedHtml = endurance.sessionsHtml(banked, { today: "2026-09-20" });
  assert.equal((bankedHtml.match(/class="race-run [^"]*is-done/g) || []).length, 2);
  assert.doesNotMatch(bankedHtml, /✓|race-run-tick|Next week|is-next/);
  const nextHtml = endurance.nextWeekHtml(banked, { today: "2026-09-20", figure: "15 km planned" });
  assert.match(
    nextHtml,
    /<span class="lbl" id="raceNextTitle">Next week<\/span><span class="race-next-km">15 km planned</
  );
  // Dates a person says, short enough for the day column at 390px; never "NEXT TUES…".
  assert.deepEqual(
    [...nextHtml.matchAll(/race-run-when">([^<]+)</g)].map((m) => m[1]),
    ["Tue 22", "Sun 27"]
  );
  // The detail rides only on the first upcoming run.
  assert.equal((nextHtml.match(/race-run-detail/g) || []).length, 1);
  assert.ok(nextHtml.indexOf("race-run-detail") < nextHtml.indexOf("Sun 27"));
  // Only next week: the week after is the ladder's to show.
  assert.doesNotMatch(nextHtml, /Oct 4|Sun 4/);
});

test("a run the morning turned into rest keeps its words, never a distance, pace or its old day's neighbours", () => {
  const endurance = loadPlanEnduranceClient();
  const briefing = endurance.buildBriefing({
    today: "2026-09-29",
    agenda: {
      available: true,
      intents: [
        {
          kind: "easy",
          label: "Rest or an easy walk",
          status: "open",
          // Planned for Monday, moved to Tuesday, then rested by this morning's read.
          provisional_day_number: 1,
          provisional_date: "2026-09-28",
          suggested_date: "2026-09-29",
          target_distance_km: null,
          completion: null,
          adjustment: { dose: "rest", why: "That sore spot is still active, so the run can wait." },
        },
        {
          kind: "easy",
          label: "Easy run",
          status: "open",
          provisional_day_number: 4,
          provisional_date: "2026-10-01",
          suggested_date: "2026-10-01",
          target_distance_km: 5.8,
          completion: null,
        },
      ],
    },
    runPlan: {
      available: true,
      week_start: "2026-09-28",
      runs: [
        {
          day_number: 1,
          kind_label: "easy",
          label: "Easy run",
          target_distance_km: 5.8,
          note: "Easy aerobic.",
          interval: null,
        },
        {
          day_number: 4,
          kind_label: "easy",
          label: "Easy run",
          target_distance_km: 5.8,
          note: "Easy aerobic.",
          interval: null,
        },
      ],
    },
    raceBuild: {
      available: true,
      paces: {
        bands: [{ key: "easy", label: "Easy", text: "6:55–7:25 /km", fast_sec_per_km: 415, slow_sec_per_km: 445 }],
      },
      leg_map: [
        { day_number: 1, weekday: "Monday", run: { kind: "easy" }, strength: null, ride: false, hard: false },
        {
          day_number: 2,
          weekday: "Tuesday",
          run: null,
          strength: { name: "Pull", heavy_lower: false },
          ride: false,
          hard: false,
        },
        {
          day_number: 4,
          weekday: "Thursday",
          run: { kind: "easy" },
          strength: { name: "Lower B", heavy_lower: true },
          ride: false,
          hard: true,
        },
      ],
    },
  });
  const rested = briefing.next;
  assert.equal(rested?.label, "Rest or an easy walk");
  assert.match(rested?.morning || "", /run can wait/);
  assert.equal(rested?.prescription, "", "no distance or pace on a rested run");
  assert.equal(rested?.setup, "");
  assert.equal(rested?.expect, "");
  assert.equal(rested?.sitsBy, "");
  const html = endurance.sessionsHtml(briefing);
  assert.doesNotMatch(html.split("is-ahead")[0], /5\.8 km|6:55|Setup|Sits by/);
  // A run keeps the neighbours of the day it now sits on, not the day it was first planned for.
  const thursday = briefing.remaining.find((session) => session.date === "2026-10-01");
  assert.match(thursday?.sitsBy || "", /Lower B/);
});

test("the race page without a race: THIS WEEK still stands for a runner, never a ladder or an estimate", () => {
  const document = createDocument();
  const view = createHost(document, { html: `<div id="endPlanBody"></div>` });
  const win = loadClientModule(
    [
      "html-utils",
      "ui-chart",
      "format-utils",
      "ui-format",
      "race-week-model",
      "race-week-runs-model",
      "race-ladder-model",
      "race-view-model",
      "race-estimate-client",
      "race-ladder-client",
      "race-view-client",
      "plan-endurance-model",
      "plan-endurance-briefing-client",
      "plan-endurance-client",
    ],
    {
      document,
      globals: {
        view,
        stagger: (index) => `--i:${index}`,
        humanDate: (iso) => String(iso || ""),
        enduranceGoalCard: () => "",
        api: async () => null,
      },
    }
  );
  const build = {
    available: false,
    running: "runs",
    race: null,
    weeks: [],
    leg_map: [],
    this_week: { week_start: "2026-09-14", km: 20, long_km: 8, logged_km: 6, quality: null, why: "" },
    review: { weeks: [], longest_recent_km: null, volume_word: null },
    reason: "No dated race yet. Set one and the build lays out week by week.",
  };
  const runPlan = {
    available: true,
    week_start: "2026-09-14",
    why: "About 20 km this week: 2 easy + 1 long.",
    runs: [{ day_number: 7, kind_label: "long", label: "Long run", target_distance_km: 8 }],
  };
  win.paintPlanEndurance(null, null, null, {}, build, { runPlan, today: "2026-09-16", units: "mi" });
  const body = view.querySelector("#endPlanBody");
  const card = body.querySelector(".race-week");
  assert.ok(card, "the THIS WEEK card stands without a race");
  assert.equal(card.querySelector(".race-week-stage").textContent, "Your running week");
  assert.equal(card.querySelector(".race-week-num").textContent, "3.7 mi · plan 12.4");
  assert.match(card.querySelector(".race-runs").textContent, /Long run/);
  // The run engine's own sentence, in the athlete's units, is the focus.
  assert.equal(card.querySelector(".race-week-focus").textContent, "About 12.4 mi this week: 2 easy + 1 long.");
  assert.equal(card.querySelector("[data-run-units]"), null, "no per-surface unit switch: Settings owns units");
  assert.equal(body.querySelector(".race-ladder"), null);
  assert.equal(body.querySelector(".race-estimate"), null);
  assert.equal(body.querySelector("#endRaceSlot"), null);
  assert.equal(body.querySelector(".end-goal-name").textContent, "No race on the calendar");
});

test("a run in reads what was run first and the plan second; an extra is named, never dropped", () => {
  const endurance = loadPlanEnduranceClient();
  const briefing = endurance.buildBriefing({ today: "2026-10-04", agenda: { available: true, intents: [] } });
  const runs = [
    {
      date: "2026-09-29",
      when: "Tue",
      km: 9.68,
      km_text: "9.7 km",
      pace_text: "5:34/km",
      effort_word: "hard",
      actual_text: "9.7 km · 5:34/km · hard",
      title: "",
      tone: "quality",
      extra: false,
      planned_text: "planned: easy 4.8 km",
      adjust_text: "",
    },
    {
      date: "2026-10-02",
      when: "Fri",
      km: 5.97,
      km_text: "6 km",
      pace_text: "",
      effort_word: "",
      actual_text: "6 km",
      title: "<b>Hill sprints</b>",
      tone: "quality",
      extra: true,
      planned_text: "",
      adjust_text: "",
    },
    {
      date: "2026-10-04",
      when: "Sun",
      km: 13.54,
      km_text: "13.5 km",
      pace_text: "6:11/km",
      effort_word: "easy",
      actual_text: "13.5 km · 6:11/km · easy",
      title: "",
      tone: "long",
      extra: false,
      planned_text: "planned: long 10.7 km",
      adjust_text: "shortened to 8 km this morning",
    },
  ];
  const document = createDocument();
  const host = createHost(document, { html: endurance.sessionsHtml(briefing, { runs, today: "2026-10-04" }) });
  const rows = host.querySelectorAll(".race-run");
  assert.deepEqual(
    rows.map((row) => row.querySelector(".race-run-name").textContent),
    ["9.7 km · 5:34/km · hard", "6 km", "13.5 km · 6:11/km · easy"]
  );
  assert.equal(rows[1].querySelector("b"), null, "a run's title is text, never markup");
  assert.ok(rows[1].classList.contains("wrun-extra"));
  assert.equal(rows[1].querySelector(".race-run-plan").textContent, "Extra · <b>Hill sprints</b>");
  assert.equal(rows[0].querySelector(".race-run-plan").textContent, "planned: easy 4.8 km");
  assert.equal(
    rows[2].querySelector(".race-run-plan").textContent,
    "planned: long 10.7 km · shortened to 8 km this morning"
  );
  assert.ok(rows[2].classList.contains("wrun-long"));
  // No bare tick that would hide a run unlike its plan.
  assert.doesNotMatch(host.innerHTML, /✓|race-run-tick/);
});

test("plan endurance helper knows Monday arithmetic for the next-week fetch", () => {
  const endurance = loadPlanEnduranceClient();
  assert.equal(endurance.mondayOf("2026-09-20"), "2026-09-14");
  assert.equal(endurance.nextMonday("2026-09-20"), "2026-09-21");
  assert.equal(endurance.weekBanked({ available: true, intents: [] }), false);
  assert.equal(
    endurance.weekBanked({
      available: true,
      intents: [{ status: "completed" }, { status: "completed" }],
    }),
    true
  );
});
