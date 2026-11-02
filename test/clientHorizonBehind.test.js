// "Behind you" (horizon-behind-client.ts, src/contracts/goal-reviews.ts): every finished
// goal said back once. The Season's quiet section at its foot (newest first, one row
// each, absent with none) and the look back itself (/app/horizon/behind?id=): the hero,
// the facts, the build drawn to scale with the race stacked on race week, the story, what
// it taught, what carried forward with its one Undo. Server words are text, never markup,
// and nothing reads as a score or a grade. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule } from "./_dom.mjs";

const MODULES = [
  "html-utils",
  "ui-components",
  "ui-reads",
  "ui-actions-client",
  "ui-chart",
  "decision-undo-client",
  "format-utils",
  "ui-format",
  "journey-progress-client",
  "journey-timeline-client",
  "race-week-model",
  "race-week-runs-model",
  "race-ladder-model",
  "race-view-model",
  "race-estimate-client",
  "race-ladder-client",
  "race-view-client",
  "day-detail-model",
  "day-glance-model",
  "day-detail-client",
  "day-glance-view",
  "milestone-row-model",
  "milestone-row-client",
  "goal-row-model",
  "goal-row-client",
  "frame-line-client",
  "week-model",
  "week-strip-client",
  "horizon-model",
  "horizon-labs-model",
  "horizon-terrain-client",
  "horizon-chart-client",
  "horizon-week-client",
  "horizon-week-controller",
  "horizon-behind-client",
  "horizon-client",
  "horizon-controller",
];

const TODAY = "2026-11-08";
const SCORE = /score|\/\s*100|\d\s*%|percent|grade|rating/i;
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(globals = {}) {
  return loadClientModule(MODULES, { globals: { localISO: () => TODAY, ...globals } });
}

function rows() {
  return [
    {
      id: 2,
      kind: "strength_objective",
      title: "Back squat 315 lb",
      achieved_on: "2026-08-14",
      date_text: "Fri, Aug 14, 2026",
      status: "pending",
      result_line: "315 lb × 1",
      line: null,
    },
    {
      id: 1,
      kind: "race",
      title: "Cambridge Half Marathon",
      achieved_on: "2026-11-01",
      date_text: "Sun, Nov 1, 2026",
      status: "ready",
      result_line: "13.2 mi in 2:10:18 · 9:54 /mi",
      line: "Your first half, run steady from the gun.",
    },
    {
      id: 3,
      kind: "weight_goal",
      title: "Goal weight 175 lb",
      achieved_on: "2026-05-02",
      date_text: "Sat, May 2, 2026",
      status: "waiting",
      result_line: "175.0 lb",
      line: "Looked back on once the recovery days are done",
    },
  ];
}

function week(week_start, label, value, extra = {}) {
  return { week_start, label, value, race_value: 0, race_week: false, set_aside: false, words: `${value} mi`, ...extra };
}

function detail(overrides = {}) {
  return {
    id: 1,
    kind: "race",
    title: "Cambridge Half Marathon",
    achieved_on: "2026-11-01",
    date_text: "Sun, Nov 1, 2026",
    status: "ready",
    result_line: "13.2 mi in 2:10:18 · 9:54 /mi",
    line: "Your first half, run steady from the gun.",
    review: {
      headline: "Your first half, run steady from the gun.",
      story: "Eight weeks took you from 18 to 30 miles a week, and the long run reached 11.2 miles.",
      lessons: "Your legs answered volume better than speed work this build.",
      carry_forward: "The next build starts its long runs from 11 miles.",
    },
    build: {
      units: "mi",
      max_value: 30.1,
      weeks: [
        week("2026-09-07", "Sep 7", 18.2),
        week("2026-09-14", "Sep 14", 21),
        week("2026-09-21", "Sep 21", 24.5, { set_aside: true, words: "24.5 mi · set aside" }),
        week("2026-09-28", "Sep 28", 30.1),
        week("2026-10-26", "Oct 26", 9.3, { race_value: 13.2, race_week: true, words: "9.3 mi · race 13.2 mi" }),
      ],
    },
    fact_lines: ["Longest run before the race: 11.2 mi on Oct 18, taken well.", "Three easy days after."],
    carried: {
      text: "The next build starts its long runs from 11 miles.",
      levers: [
        { key: "long_run_ceiling_km", value: 18, because: "Your long runs topped out well at 11 miles.", status: "active" },
      ],
      decision_id: 42,
      undoable: true,
    },
    reviewed_at: "2026-11-06T04:10:00.000Z",
    ...overrides,
  };
}

// ---------- the Season's section ----------

test("Behind you: newest first, each row its date, title, measure and sentence; a pending row says nothing yet", () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.listHtml({ reviews: rows() }, {
    hrefFor: (t) => `/app/horizon/${t.section}?id=${t.id}`,
  });
  assert.equal(host.querySelector(".hbehind-kicker").textContent, "Behind you");
  const items = host.querySelectorAll(".hbehind-row");
  assert.deepEqual(
    plain(items.map((a) => a.querySelector(".hbehind-title").textContent)),
    ["Cambridge Half Marathon", "Back squat 315 lb", "Goal weight 175 lb"]
  );
  assert.equal(items[0].querySelector(".hbehind-date").textContent, "Sun, Nov 1, 2026");
  assert.equal(items[0].querySelector(".hbehind-result").textContent, "13.2 mi in 2:10:18 · 9:54 /mi");
  assert.equal(items[0].querySelector(".hbehind-line").textContent, "Your first half, run steady from the gun.");
  assert.equal(items[0].getAttribute("href"), "/app/horizon/behind?id=1");
  assert.equal(items[0].getAttribute("data-horizon-go"), "behind:1");
  // Pending: no sentence at all. Waiting: the server's own line, quieter.
  assert.equal(items[1].querySelector(".hbehind-line"), null);
  assert.equal(items[2].querySelector(".hbehind-line").textContent, "Looked back on once the recovery days are done");
  assert.ok(items[2].querySelector(".hbehind-line").classList.contains("is-waiting"));
  assert.doesNotMatch(host.textContent, SCORE);
});

test("Behind you is absent with nothing behind, or a read that is not a list", () => {
  const win = load();
  assert.equal(win.CairnHorizonBehind.listHtml({ reviews: [] }), "");
  assert.equal(win.CairnHorizonBehind.listHtml(null), "");
  assert.equal(win.CairnHorizonBehind.listHtml({ ok: false, error: "x" }), "");
  assert.equal(win.CairnHorizonBehind.listHtml([{ id: 4, title: "" }]), "");
});

test("server text in a row stays text", () => {
  const win = load();
  const evil = '<img src=x onerror="boom()">';
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.listHtml({
    reviews: [{ ...rows()[1], title: evil, line: evil, result_line: evil, date_text: evil, id: '1"><b>' }],
  });
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.querySelector("b"), null);
  assert.equal(host.querySelector(".hbehind-title").textContent, evil);
  assert.equal(host.querySelector(".hbehind-line").textContent, evil);
});

// ---------- the look back ----------

test("the look back: hero, facts, the build to scale with the race stacked, the story, what it taught", () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.detailHtml(detail());
  assert.equal(host.querySelector(".hb-date").textContent, "Sun, Nov 1, 2026");
  assert.equal(host.querySelector(".hb-title").textContent, "Cambridge Half Marathon");
  assert.equal(host.querySelector(".hb-result").textContent, "13.2 mi in 2:10:18 · 9:54 /mi");
  assert.equal(host.querySelector(".hb-headline").textContent, "Your first half, run steady from the gun.");
  assert.deepEqual(plain(host.querySelectorAll(".hb-facts li").map((li) => li.textContent)), detail().fact_lines);

  const weeks = host.querySelectorAll(".hbuild-week");
  assert.equal(weeks.length, 5);
  const frac = (el) => Number(/--frac:([\d.]+)/.exec(el.getAttribute("style"))[1]);
  // Drawn to the tallest stacked week (max_value), never re-scaled per bar.
  assert.equal(frac(weeks[3].querySelector(".hbuild-bar")), 1);
  assert.ok(Math.abs(frac(weeks[0].querySelector(".hbuild-bar")) - 18.2 / 30.1) < 0.001);
  // Race week: the training bar with the race stacked on top of it, in that order.
  const race = weeks[4];
  assert.ok(race.classList.contains("is-race"));
  const stack = race.querySelector(".hbuild-stack").children;
  assert.deepEqual(plain(stack.map((el) => el.getAttribute("class"))), ["hbuild-race", "hbuild-bar"]);
  assert.ok(Math.abs(frac(stack[0]) - 13.2 / 30.1) < 0.001);
  assert.ok(Math.abs(frac(stack[1]) - 9.3 / 30.1) < 0.001);
  assert.equal(weeks.filter((w) => w.querySelector(".hbuild-race")).length, 1, "only race week stacks");
  // The set-aside week is drawn quieter; each column's words are its accessible text.
  assert.ok(weeks[2].classList.contains("is-set-aside"));
  assert.equal(race.querySelector(".sr-only").textContent, "Oct 26: 9.3 mi · race 13.2 mi");
  assert.equal(race.querySelector(".hbuild-label").textContent, "Oct 26");
  assert.match(host.querySelector(".hbuild-keys").textContent, /The race/);

  assert.match(host.querySelector(".hb-story").textContent, /Eight weeks/);
  const sections = host.querySelectorAll(".hb-section-k").map((h) => h.textContent);
  assert.deepEqual(plain(sections), ["The build", "What it taught", "Carried forward"]);
  assert.doesNotMatch(host.textContent, SCORE);
});

test("carried forward: the words, each lever's reason, and one Undo only while undoable", () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.detailHtml(detail());
  const carried = host.querySelector(".hb-carried");
  assert.match(carried.querySelector(".hb-prose").textContent, /starts its long runs from 11 miles/);
  assert.deepEqual(plain(carried.querySelectorAll(".hb-lever").map((li) => li.textContent)), [
    "Your long runs topped out well at 11 miles.",
  ]);
  const undo = carried.querySelectorAll("[data-decision-undo]");
  assert.equal(undo.length, 1);
  assert.equal(undo[0].getAttribute("data-decision-undo"), "42");
  assert.equal(undo[0].textContent, "Undo");

  const settled = detail({ carried: { ...detail().carried, undoable: false } });
  host.innerHTML = win.CairnHorizonBehind.detailHtml(settled);
  assert.equal(host.querySelector("[data-decision-undo]"), null);
  const noDecision = detail({ carried: { ...detail().carried, decision_id: null } });
  host.innerHTML = win.CairnHorizonBehind.detailHtml(noDecision);
  assert.equal(host.querySelector("[data-decision-undo]"), null);
});

test("a strength or weight review has no build; absent pieces are simply not drawn", () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.detailHtml(
    detail({
      kind: "strength_objective",
      title: "Back squat 315 lb",
      build: null,
      fact_lines: [],
      carried: { text: null, levers: [], decision_id: null, undoable: false },
      review: { headline: "It moved.", story: "", lessons: "", carry_forward: "" },
    })
  );
  assert.equal(host.querySelector(".hbuild"), null);
  assert.equal(host.querySelector(".hb-facts"), null);
  assert.equal(host.querySelector(".hb-carried"), null);
  assert.equal(host.querySelector(".hb-story"), null);
  assert.equal(host.querySelector(".hb-title").textContent, "Back squat 315 lb");
});

test("before the look back: the hero, the facts, and a calm line — the waiting line while recovering", () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.detailHtml(
    detail({ status: "pending", line: null, review: null, reviewed_at: null })
  );
  assert.equal(host.querySelector(".hb-title").textContent, "Cambridge Half Marathon");
  assert.equal(host.querySelectorAll(".hb-facts li").length, 2);
  assert.equal(host.querySelector(".hb-soon").textContent, "Looked back on soon.");
  assert.equal(host.querySelector(".hb-headline"), null);
  assert.equal(host.querySelector(".hbuild"), null, "the build waits for the look back");
  assert.equal(host.querySelector(".hb-carried"), null);
  host.innerHTML = win.CairnHorizonBehind.detailHtml(
    detail({ status: "waiting", line: "Looked back on once the recovery days are done", review: null })
  );
  assert.equal(host.querySelector(".hb-soon").textContent, "Looked back on once the recovery days are done");
  assert.equal(win.CairnHorizonBehind.detailHtml(null), "");
  assert.equal(win.CairnHorizonBehind.detailHtml({ id: 9 }), "");
});

test("server text on the look back stays text", () => {
  const win = load();
  const evil = '<img src=x onerror="boom()">';
  const base = detail();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizonBehind.detailHtml(
    detail({
      title: evil,
      date_text: evil,
      result_line: evil,
      fact_lines: [evil],
      review: { headline: evil, story: evil, lessons: evil, carry_forward: evil },
      build: { ...base.build, weeks: base.build.weeks.map((w) => ({ ...w, label: evil, words: evil })) },
      carried: { ...base.carried, text: evil, levers: [{ ...base.carried.levers[0], because: evil, status: evil }] },
    })
  );
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.querySelector(".hb-title").textContent, evil);
  assert.equal(host.querySelector(".hb-lever").textContent, evil);
});

// ---------- the Season wiring ----------

function reads({ fail = [], extra = {} } = {}) {
  const table = { "/goal-reviews": { reviews: rows() }, ...extra };
  const calls = [];
  const load = (path) => {
    calls.push(path);
    if (fail.includes(path)) return Promise.reject(new Error("offline"));
    return Promise.resolve(path in table ? table[path] : null);
  };
  return { load, calls };
}

async function openSeason(root) {
  await root.querySelector('[data-horizon-seg="season"]').click();
  await flush();
  await flush();
}

function mounted(win, deps) {
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  win.CairnHorizonController.mount(root, { today: TODAY, navigate: () => {}, ...deps });
  return root;
}

test("the Season ends on Behind you once /goal-reviews lands, read only when Season opens", async () => {
  const win = load();
  const { load: loader, calls } = reads();
  const went = [];
  const root = mounted(win, { load: loader, navigate: (t) => went.push(t) });
  await flush();
  assert.ok(!calls.includes("/goal-reviews"), "not read at the Week landing");
  const slot = root.querySelector('[data-horizon-panel="season"] [data-horizon-behind]');
  assert.ok(slot, "the slot sits in the Season panel");
  assert.equal(slot.innerHTML, "");
  await openSeason(root);
  assert.equal(calls.filter((p) => p === "/goal-reviews").length, 1);
  // At the foot of the Season, after the lanes.
  const panel = root.querySelector('[data-horizon-panel="season"]');
  assert.equal(panel.lastElementChild, slot);
  const rowsShown = slot.querySelectorAll(".hbehind-row");
  assert.equal(rowsShown.length, 3);
  await rowsShown[0].click();
  assert.deepEqual(plain(went), [{ tab: "horizon", section: "behind", id: "1" }]);
});

test("no rows or a failed read leaves Behind you out", async () => {
  for (const opts of [{ extra: { "/goal-reviews": { reviews: [] } } }, { fail: ["/goal-reviews"] }]) {
    const win = load();
    const { load: loader } = reads(opts);
    const root = mounted(win, { load: loader });
    await openSeason(root);
    assert.equal(root.querySelector(".hbehind"), null);
    assert.equal(root.querySelector("[data-horizon-behind]").innerHTML, "");
  }
});
