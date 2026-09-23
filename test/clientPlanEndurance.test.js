import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

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
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-client.js"), "utf8"), context);
  return context.CairnPlanEndurance;
}

// A minimal fake element good enough to drive paintPlanEndurance(): innerHTML
// stores/returns the painted string, querySelector/querySelectorAll are inert
// (the module's post-paint wiring null-checks or forEach()s over them).
class FakePaintElement {
  constructor() {
    this._html = "";
  }

  set innerHTML(value) {
    this._html = value;
  }

  get innerHTML() {
    return this._html;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

// Loads the real module (model + client) plus every other global
// paintPlanEndurance touches, so `paintPlanEndurance` can be invoked directly
// against a fake #endPlanBody and its painted HTML inspected.
function loadPlanEnduranceForPaint({ raceBuildCard } = {}) {
  const body = new FakePaintElement();
  const view = { querySelector: (selector) => (selector === "#endPlanBody" ? body : null) };
  const context = {
    Array,
    Object,
    String,
    Number,
    Date,
    Math,
    view,
    stagger: (index) => `--i:${index}`,
    humanDate: (iso) => String(iso || ""),
    fmtKm: (km) => String(km),
    fmtDist: (km, units) => (units === "mi" ? `${Number(km) / 1.609344} mi` : `${km} km`),
    enduranceGoalCard: (goal) => `<div class="end-goal">${String(goal?.event || "")}</div>`,
    trainingAgendaCard: () => "",
    runComplianceLine: () => "",
    cardioSyncLine: undefined,
    wireCardioSync: undefined,
    loadPlanUpcomingNote: undefined,
    ...(raceBuildCard !== undefined ? { raceBuildCard } : {}),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-client.js"), "utf8"), context);
  return { context, body };
}

const RACE_GOAL = { mode: "race", phase: "build", event: "Fall 10K", weeks_to_race: 4 };

test("plan endurance paints the race build card and drops the generic ramp when a build is available", () => {
  const calls = [];
  const { context, body } = loadPlanEnduranceForPaint({
    raceBuildCard: (build, opts) => {
      calls.push(opts);
      return build?.available !== false && build?.race ? '<div data-race-build class="wrun-card rbuild"></div>' : "";
    },
  });

  context.paintPlanEndurance(RACE_GOAL, null, null, {}, { available: true, race: { weeks_to_race: 4, phase: "build" } });

  assert.match(body.innerHTML, /data-race-build/);
  assert.doesNotMatch(body.innerHTML, /class="end-ramp reveal"/);
  // The goal card directly above this one already states the countdown +
  // phase — Plan must ask for the card's short head, not the full one.
  // The stub records opts born in the module's own realm, so compare by value.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.underGoal, true);
  assert.equal(calls[0]?.compact, true);
});

test("plan endurance keeps today's ramp when the race build is unavailable or the fetch failed", () => {
  const { context, body } = loadPlanEnduranceForPaint({
    raceBuildCard: (build) => (build?.available !== false && build?.race ? '<div data-race-build></div>' : ""),
  });

  context.paintPlanEndurance(RACE_GOAL, null, null, {}, { available: false });

  assert.doesNotMatch(body.innerHTML, /data-race-build/);
  assert.match(body.innerHTML, /class="end-ramp reveal"/);
});

test("plan endurance keeps today's ramp when the race-build fetch rejected (raceBuild is null)", () => {
  const { context, body } = loadPlanEnduranceForPaint({
    raceBuildCard: (build) => (build?.available !== false && build?.race ? '<div data-race-build></div>' : ""),
  });

  context.paintPlanEndurance(RACE_GOAL, null, null, {}, null);

  assert.doesNotMatch(body.innerHTML, /data-race-build/);
  assert.match(body.innerHTML, /class="end-ramp reveal"/);
});

test("plan endurance never crashes when raceBuildCard is not yet loaded (a different bundle)", () => {
  // raceBuildCard is defined in progress-run-plan-client.ts, a different
  // bundle — plan-endurance-client.ts must guard with typeof, never assume
  // the global exists.
  const { context, body } = loadPlanEnduranceForPaint();

  context.paintPlanEndurance(RACE_GOAL, null, null, {}, { available: true, race: { weeks_to_race: 4, phase: "build" } });

  assert.doesNotMatch(body.innerHTML, /data-race-build/);
  assert.match(body.innerHTML, /class="end-ramp reveal"/);
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
  assert.match(source, /api\(`\/training-agenda\?date=/);
  assert.match(source, /api\("\/run-plan"\)/);
  assert.match(source, /enduranceModel\(\)\.nextMonday\(today\)/);
  assert.match(source, /enduranceModel\(\)\.buildBriefing/);
  assert.match(source, /compact: true/);
  assert.match(source, /end-shape-fold/);
  assert.match(source, /end-week-fold/);
  assert.match(source, /laterMonday/);
  assert.match(source, /run_units/);
  assert.doesNotMatch(source, /trainingAgendaCard\(agenda\)/);
  assert.doesNotMatch(source, /Your running plan — the build/);
  assert.doesNotMatch(source, /each run lands on its day|>Day \$\{|tempo on Thursday/);
});

test("plan endurance fetches the race build alongside the rest of the segment's reads", () => {
  const source = readFileSync(join(root, "src/client/plan-endurance-client.ts"), "utf8");
  assert.match(source, /api\("\/race-build"\)\.catch\(\(\) => null\)/);
  assert.match(source, /typeof raceBuildCard === "function"/);
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
      paces: { bands: [{ key: "easy", label: "Easy", text: "6:13–6:43 /km", fast_sec_per_km: 373, slow_sec_per_km: 403 }, { key: "threshold", label: "Threshold", text: "5:01–5:08 /km", fast_sec_per_km: 301, slow_sec_per_km: 308 }] },
      leg_map: [
        { day_number: 1, weekday: "Monday", run: null, strength: { name: "Lower A", heavy_lower: true }, ride: false, hard: true },
        { day_number: 2, weekday: "Tuesday", run: { kind: "easy" }, strength: { name: "Push", heavy_lower: false }, ride: false, hard: false },
        { day_number: 5, weekday: "Friday", run: { kind: "quality" }, strength: { name: "Chest, back", heavy_lower: false }, ride: false, hard: true },
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

  const html = endurance.briefingHtml(open);
  assert.match(html, /data-end-next/);
  assert.match(html, /Easy run/);
  assert.match(html, /Setup/);
  assert.match(html, /Sits by/);
  assert.match(html, /Threshold intervals/);
  assert.match(html, /data-run-units="km"/);
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
  assert.match(endurance.briefingHtml(miles), /data-run-units="mi"/);

  const banked = endurance.buildBriefing({
    today: "2026-09-20",
    agenda: {
      available: true,
      intents: [
        { kind: "easy", status: "completed", provisional_day_number: 2, completion: { date: "2026-09-15" } },
        { kind: "long", status: "completed", provisional_day_number: 7, completion: { date: "2026-09-20" } },
      ],
    },
    runPlan: { available: true, week_start: "2026-09-14", why: "This week is done.", runs: [{ kind_label: "long", day_number: 7 }] },
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
  const bankedHtml = endurance.briefingHtml(banked);
  assert.match(bankedHtml, /Later in the build/);
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
