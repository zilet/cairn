// One home per fact (docs/IA.md Principle 1, contract test 4; src/contracts/fact-owners.ts).
//
// Today and Train are rendered from ONE seeded fixture through their real renderers:
// Today as its components in screen order (the Brief, the push line, the week strip,
// the Horizon glance line, the focus thread, Body & recovery, the new connection), Train
// through renderTrainOverview itself over a stubbed request layer. Two rules:
//   1. no sentence of 8+ words appears twice within one screen;
//   2. an owner's sentence (the fixture's full form of each fact) never shows on a
//      screen it does not own — a listed glance may name the fact in a shorter line,
//      never repeat the sentence; any other component may not carry it at all.
// The owners that render on Today or Train must say their sentence there in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FACT_KEYS, FACT_OWNERS, mayShowFact, screenOfComponent } from "../dist/contracts/fact-owners.js";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-10-06"; // a Tuesday
const WEEK = ["2026-10-05", TODAY, "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];

// ---------- the one fixture ----------

const strengthLine = {
  date: TODAY,
  day_number: 2,
  title: "Push",
  focus: null,
  role: "lift",
  state: "logged",
  suggestion: null,
  caveat: null,
  run_in: { km: 6 },
  reshaped: false,
  original: [],
  text: "Push · logged · run in",
};

const weekSummary = "Two of five lifting days are in and 6.1 of about 31 km run, with three new bests so far.";

const planWeek = {
  as_of: TODAY,
  week_start: WEEK[0],
  summary: weekSummary,
  run_units: "km",
  strength_line: strengthLine,
  layout: { clean: true, suggestion: null },
  schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  progress: { lift_days_done: 2, lift_days_planned: 5, runs_done: 1, run_km: 6.1, longest_run_km: 6.1, runs_open: [], prs: 3, line: weekSummary },
  days: WEEK.map((date, i) => ({
    date,
    weekday: null,
    dow: null,
    status: i < 2 ? "done" : "upcoming",
    plan_day:
      i === 1 || i === 2
        ? { day_number: i, name: i === 1 ? "Push" : "Pull", focus: null, purpose: null, day_type: "training", role: "lift", out_of_order: false }
        : null,
    session: i <= 1 ? { id: i + 1, title: i === 0 ? "Upper Body" : "Push", date, finished: true } : null,
    run: i === 6 ? { kind: "long", label: "Long run", status: "open", suggested_date: date, completion_date: null, km: 14 } : null,
    hard: false,
  })),
};

const frame = {
  headline: "26 days to Cambridge Half",
  line: "Sharpen · block week 6 of 6 · push through Nov 15",
  glance: { line: "26 days to Cambridge · Sharpen, wk 6 of 6", href: "/app/horizon" },
};

const todayPath = { as_of: TODAY, trail_start: "2026-09-08", race: null, weight: null, anchor: null, milestones: [], lever: null, focus: null, board: [], week: null, frame };

const weightTrend = {
  as_of: TODAY,
  units: "lb",
  mode: "lose",
  rate_lb_wk: -0.9,
  rate_value: -0.9,
  rate_words: "−0.9 lb/wk",
  needed_lb_wk: -0.8,
  needed_value: -0.8,
  needed_words: "−0.8 lb/wk",
  verdict: "on_pace",
  verdict_words: "on pace",
  line: "Trending −0.9 lb/wk — on pace for your goal on Nov 15.",
};

const stats = {
  week_planned: 5,
  week_done: 2,
  week_sets: 38,
  week_cardio: 1,
  goal_mode: "lose",
  goal_weight_lb: 154,
  trend_lb_wk: -0.93,
  weight_lb: 159.6,
  weight_trend: weightTrend,
  endurance: { week_km: 6.1 },
};

const pushRead = {
  date: TODAY,
  drive: "push",
  standing: "push",
  stance: {
    since: TODAY,
    until: "2026-11-15",
    scope: "date",
    words: "push me",
    days_left: 40,
    decision_id: 3,
    line: "Pushing through Nov 15, as you asked on Oct 6.",
  },
  ended: null,
  licenses: [],
  never_overrides: [],
  today: {
    date: TODAY,
    reaching: false,
    reach_hosts: 0,
    holding: [{ code: "signal", words: "a short night" }],
    line: "Push is on, and today it gives way to one thing: a short night.",
  },
  offer: null,
};

const newBests = "New bests this week: Farmer's Carry 55 lb × 1:06 and Chest-Supported Row 40 lb × 12.";

const focus = {
  available: true,
  acts: false,
  headline: "Week 6 of 6, 26 days to Cambridge Half: your overhead press leads this week, with your lipids alongside.",
  lead: {
    domain: "training",
    title: "Bring up your overhead press",
    why: "Your overhead press has held flat for three sessions while the rest of your upper body moved on.",
    move: "This week a strong top set at the top of the range earns the load step, so give the press its best set early.",
  },
  parallel: [{ domain: "health", title: "Move your lipids & cardiovascular", why: "ApoB sits above the optimal band." }],
  later: [],
  connections: [],
  retest: null,
  horizon_weeks: 6,
  block_line: "Sharpen · Week 6 of 6 — the scheduled deload is set aside.",
  block: {
    week: 6,
    of: 6,
    phase: "intensification",
    scheduled_phase: "deload",
    deload: "set_aside",
    decision: "Your loaded weeks haven't called for one, so intensity carries on.",
    race_taper_from: null,
  },
  day_state: { posture: "done", title: "Today's work is complete", line: "Nothing more needed today", move: "" },
  changed_since: [
    { domain: "training", kind: "new_best", text: newBests, since: "2026-09-30", direction: "up" },
    { domain: "body", kind: "weight", text: "Weight came down about a pound against the week before.", since: "2026-09-29", direction: "down" },
  ],
  evidence: [],
  push: pushRead,
};

const brief = {
  kind: "done",
  headline: "Push work and run banked.",
  why: "You got your overhead pressing and an easy run in this morning, leaving the rest of the day to absorb the work.",
  signals: {},
  strength_line: strengthLine,
};

const insights = [{ id: 3, kind: "connection", status: "new", text: "Your lowest-energy mornings all followed a short night's sleep." }];

// The full form of each fact, as its owner says it.
const OWNER_SENTENCES = {
  week_summary: [weekSummary],
  today_lift_line: [strengthLine.text],
  new_bests: [newBests],
  race_countdown: [frame.headline, frame.line],
  weight_trend: [weightTrend.line],
  deload_decision: [focus.block_line, focus.block.decision],
  push_stance: [pushRead.stance.line],
};

// ---------- reading a rendered screen as sentences ----------

const BLOCK_TAGS = new Set([
  "div", "p", "section", "li", "ol", "ul", "h1", "h2", "h3", "h4", "details", "summary", "button", "figure",
  "figcaption", "header", "footer", "article", "aside", "nav", "a", "svg",
]);

/** The element's text as lines: a block boundary is a line break, inline markup is not. */
function lines(root) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.data;
      return;
    }
    if (node.nodeType !== 1) return;
    const block = BLOCK_TAGS.has(node.localName);
    if (block) out += "\n";
    for (const child of node.childNodes) walk(child);
    if (block) out += "\n";
  };
  walk(root);
  return out
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Every 8+ word sentence said twice on one screen, with where. */
function duplicateSentences(chunks) {
  const seen = new Map();
  const dupes = [];
  for (const { component, host } of chunks) {
    for (const line of lines(host)) {
      for (const sentence of sentencesOf(line)) {
        if (words(sentence) < 8) continue;
        const key = norm(sentence);
        if (seen.has(key)) dupes.push(`"${sentence}" (${seen.get(key)} and ${component})`);
        else seen.set(key, component);
      }
    }
  }
  return dupes;
}

/** Where an owner's sentence shows on a screen it does not own, or is repeated by a glance. */
function strayOwnerSentences(chunks) {
  const stray = [];
  for (const fact of FACT_KEYS) {
    for (const owned of OWNER_SENTENCES[fact]) {
      const want = norm(owned);
      for (const { component, host } of chunks) {
        if (component === FACT_OWNERS[fact].owner) continue;
        const text = lines(host);
        if (mayShowFact(fact, component)) {
          // A glance may name the fact in a shorter line, never say the owner's sentence.
          const said = text.some((l) => norm(l) === want || sentencesOf(l).some((s) => norm(s) === want));
          if (said) stray.push(`${fact}: glance ${component} repeats "${owned}"`);
        } else if (text.some((l) => norm(l).includes(want))) {
          stray.push(`${fact}: ${component} carries "${owned}"`);
        }
      }
    }
  }
  return stray;
}

function ownersSay(screen, chunks) {
  const missing = [];
  for (const fact of FACT_KEYS) {
    const entry = FACT_OWNERS[fact];
    if (entry.screen !== screen) continue;
    const owner = chunks.filter((c) => c.component === entry.owner);
    const text = owner.flatMap((c) => lines(c.host)).map(norm).join(" ");
    for (const owned of OWNER_SENTENCES[fact]) if (!text.includes(norm(owned))) missing.push(`${fact}: ${entry.owner} never says "${owned}"`);
  }
  return missing;
}

// ---------- Today, composed from its renderers in screen order ----------

function renderToday() {
  const win = loadClientModule(
    [
      "html-utils",
      "ui-format",
      "ui-reads",
      "today-brief-voice-client",
      "today-brief-client",
      "today-push-client",
      "today-path-client",
      "today-horizon-client",
      "today-compass-client",
      "today-main-shell-client",
      "ui-feedback-client",
      "coaching-focus-render-client",
      "coaching-focus-client",
      "day-detail-model",
      "day-detail-run-client",
      "day-detail-client",
      "today-strip-client",
    ],
    { globals: { state: {}, view: { querySelector: () => null }, api: async () => null, activateTab: () => {}, localISO: () => TODAY } }
  );
  const esc = { escapeHtml: win.escHtml, escapeAttr: win.escAttr, formatKm: win.fmtKm };
  const compass = win.CairnTodayCompass.build(stats, esc, { currentWeight: stats.weight_lb, isToday: true, weightTile: false });
  const parts = [
    ["today.brief", win.CairnTodayBrief.briefHtml(brief, { isToday: true, showPlan: true })],
    ["today.push-line", win.CairnTodayPush.stateHtml(pushRead, "done")],
    ["today.week-strip", win.CairnTodayStrip.stripHtml(planWeek, TODAY)],
    ["today.horizon-glance", win.CairnTodayPath.glanceHtml(todayPath)],
    ["today.focus-thread", win.CairnCoachingFocus.coachingFocusThreadHtml(focus)],
    [
      "today.body-recovery",
      win.CairnTodayMainShell.weekFoldHtml(compass, esc, {
        currentWeight: stats.weight_lb,
        trendWords: weightTrend.rate_words,
        runs: true,
        weekCardio: stats.week_cardio,
      }),
    ],
    ["today.connection", win.CairnTodayHorizon.connectionHtml(insights[0])],
  ];
  return parts.map(([component, html]) => ({ component, html, host: renderHtml(html, { document: win.document }) }));
}

// ---------- Train, through its own renderer over a stubbed request layer ----------

async function renderTrain() {
  const asked = [];
  const reads = {
    "/stats": stats,
    "/program/balance": {
      groups: [
        { group: "chest", sets: 12, band: "productive", status: "ok" },
        { group: "back", sets: 4, band: "low", status: "due" },
        { group: "shoulders", sets: 10, band: "productive", status: "ok" },
      ],
    },
    "/muscle-trajectory": {
      groups: [
        { group: "chest", label: "chest", verdict: "stalling", trend: "stable" },
        { group: "shoulders", label: "shoulders", verdict: "advancing", trend: "rising" },
      ],
    },
    "/coaching-focus": focus,
    "/muscle-load": { groups: [] },
    "/training-load": { band: null },
    "/program/adjustments": [],
    "/sessions?limit=3": [
      { id: 2, date: TODAY, title: "Push", day_name: "Push", sets: [{}, {}, {}] },
      { id: 1, date: "2026-10-05", title: "Session", day_name: null, sets: [{}, {}] },
    ],
    "/journey": null,
    "/journey/milestones": [],
    "/journey/timeline": [],
    // Answered if anything still asked: Train must not print today's lift line.
    [`/today-strength-line?date=${TODAY}`]: strengthLine,
  };
  const win = loadClientModule(
    [
      "html-utils",
      "ui-format",
      "ui-feedback-client",
      "coaching-focus-render-client",
      "coaching-focus-client",
      "train-focus-card-client",
      "progress-data-client",
      "progress-overview-client",
    ],
    {
      globals: {
        state: { tab: "progress", progressSeg: "overview" },
        api: async (path) => {
          asked.push(path);
          return path in reads ? reads[path] : null;
        },
        activateTab: () => {},
        localISO: () => TODAY,
        stagger: (i) => `--i:${i}`,
        segBar: () => `<nav class="segwrap"></nav>`,
        segSkeleton: () => "",
        wireSeg: () => {},
        runCountUps: () => {},
        withViewTransition: (fn) => fn(),
        viewEnter: () => {},
        reducedMotion: () => true,
        PROGRESS_SEG: [],
        PROGRESS_HANDLERS: {},
        CairnTrainSnapshot: { load: () => null, save: () => {} },
        CairnOffline: { isUnreachable: () => false },
        CairnProgressJourney: { hasRead: () => false, phaseSummary: () => "" },
        CairnJourneyTimeline: { nextLabel: () => "" },
      },
    }
  );
  win.view = createHost(win.document);
  win.headerTitle = createHost(win.document, { tag: "h1" });
  await win.renderTrainOverview();
  await flush();
  // Train's components, by their own markup.
  const view = win.view;
  const pick = (selector) => [...view.querySelectorAll(selector)];
  const chunks = [
    ...pick(".tfc-headline").map((host) => ({ component: "train.focus-headline", host })),
    ...pick(".tfc-moved").map((host) => ({ component: "train.what-moved", host })),
    ...pick(".tfc-block").map((host) => ({ component: "train.block-line", host })),
    ...pick(".tfc-push").map((host) => ({ component: "train.push-strip", host })),
  ];
  // Everything else on the screen, as one more chunk with the owned parts taken out.
  const rest = renderHtml(view.innerHTML, { document: win.document });
  for (const sel of [".tfc-headline", ".tfc-moved", ".tfc-block", ".tfc-push"]) for (const el of [...rest.querySelectorAll(sel)]) el.remove();
  chunks.push({ component: "train.home", host: rest });
  return { chunks, asked, view, headerTitle: win.headerTitle };
}

// ---------- the contract ----------

test("the contract: every fact has one owner on a real screen, and its glances live elsewhere", () => {
  for (const fact of FACT_KEYS) {
    const entry = FACT_OWNERS[fact];
    assert.equal(screenOfComponent(entry.owner), entry.screen, `${fact}: owner sits on its screen`);
    assert.ok(!entry.glances.includes(entry.owner), `${fact}: an owner is not its own glance`);
    assert.ok(OWNER_SENTENCES[fact]?.length, `${fact}: the fixture says it in full`);
  }
  assert.deepEqual(
    [...FACT_KEYS].sort(),
    ["deload_decision", "new_bests", "push_stance", "race_countdown", "today_lift_line", "week_summary", "weight_trend"]
  );
});

test("Today: no 8+ word sentence twice, no owner's sentence it does not own, and the Brief says the lift", () => {
  const chunks = renderToday();
  assert.deepEqual(duplicateSentences(chunks), []);
  assert.deepEqual(strayOwnerSentences(chunks), []);
  assert.deepEqual(ownersSay("today", chunks), []);
  // The road ahead is one glance line into Horizon, not the Path card or Coming up.
  const glance = chunks.find((c) => c.component === "today.horizon-glance").host.querySelector("a.tglance");
  assert.equal(glance.getAttribute("href"), "/app/horizon");
  assert.match(glance.textContent, /^26 days to Cambridge · Sharpen, wk 6 of 6/);
  const all = chunks.map((c) => c.html).join("");
  assert.doesNotMatch(all, /Your path|Coming up|tpath-svg|thz-/);
  // The strip is a glance: its days, no summary or tally line.
  const strip = chunks.find((c) => c.component === "today.week-strip").host;
  assert.equal(strip.querySelectorAll("button.tstrip-day").length, 7);
  assert.equal(strip.querySelector(".tstrip-tally"), null);
  assert.doesNotMatch(strip.textContent, /lifting days|new best/);
  // The thread glances at the lever; the block week and its deload decision are elsewhere.
  const thread = chunks.find((c) => c.component === "today.focus-thread").host.textContent;
  assert.match(thread, /Bring up your overhead press/);
  assert.doesNotMatch(thread, /Week 6 of 6|deload/);
});

test("Train: no Today card, no week count; Where to focus and What moved lead; each fact said once", async () => {
  const { chunks, asked, view, headerTitle } = await renderTrain();
  assert.equal(headerTitle.textContent, "Train");
  assert.deepEqual(duplicateSentences(chunks), []);
  assert.deepEqual(strayOwnerSentences(chunks), []);
  assert.deepEqual(ownersSay("train", chunks), []);
  assert.ok(!asked.some((p) => p.startsWith("/today-strength-line")), "Train no longer asks for today's lift line");
  assert.equal(view.querySelector(".tov-today"), null, "the Today card is gone");
  assert.doesNotMatch(view.textContent, /sessions in this week|Week complete/);
  const html = view.innerHTML;
  assert.ok(html.indexOf("tfc-headline") < html.indexOf("tov-mast"), "Where to focus leads the screen");
  assert.ok(html.indexOf("tfc-moved") < html.indexOf("tov-mast"), "What moved rides the lead card");
  // The deload decision once: the line names the set-aside, the decision gives the reason.
  const block = view.querySelector(".tfc-block").textContent;
  assert.equal((block.match(/loaded weeks/g) || []).length, 1, block);
  assert.equal((block.match(/intensity/gi) || []).length, 1, block);
  // A muscle in its productive range whose lifts stall says both facts, never as one verdict.
  const chest = view.querySelector('.tov-row[data-group="chest"] .tov-row-note').textContent;
  assert.match(chest, /volume is in range, progress has stalled/);
  assert.doesNotMatch(chest, /in the productive range/);
  // A session stored as a bare "Session" gets a real name.
  const names = [...view.querySelectorAll(".tov-sess-name")].map((el) => el.textContent);
  assert.deepEqual(names, ["Push", "Monday's session"]);
});

test("one source for new bests: Today never counts them; Train's What moved names them once", async () => {
  const today = renderToday();
  for (const { component, host } of today) assert.doesNotMatch(host.textContent, /new bests?/i, component);
  const { chunks } = await renderTrain();
  const said = chunks.flatMap((c) => lines(c.host)).filter((l) => /new best/i.test(l));
  assert.equal(said.length, 1, said.join(" | "));
  assert.ok(said[0].includes(newBests), said[0]);
  assert.equal(chunks.find((c) => c.component === "train.what-moved").host.textContent.includes(newBests), true);
});
