import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the three IIFE-global client modules into ONE shared VM context — the way
// they share scope in the browser bundle — so tovJourneyPointerHtml exercises the REAL
// CairnProgressJourney.phaseSummary / CairnJourneyTimeline.nextLabel helpers.
function loadRoadFold() {
  const esc = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const context = {
    Array,
    Boolean,
    JSON,
    Math,
    Number,
    Object,
    Set,
    String,
    document: { querySelectorAll: () => [] },
    escHtml: esc,
    escAttr: esc,
    fmtShortDate(value) {
      return `short:${String(value || "")}`;
    },
    stagger(index) {
      return `--i:${index}`;
    },
  };
  context.globalThis = context;
  context.window = context;
  for (const file of [
    "public/js/date-utils.js",
    "public/js/ui-format.js",
    "public/js/journey-progress-client.js",
    "public/js/journey-timeline-client.js",
    "public/js/progress-overview-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context;
}

// A populated Mid-cut journey read (mirrors clientProgressJourney.test.js).
function journeyFixture() {
  return {
    profile: { goal_mode: "lose", goal_weight_lb: 180 },
    active_phase: { kind: "cut", start_date: "2026-06-01", target_weight_lb: 180 },
    transition_suggestion: null,
    proposed_phases: [],
    recomposition: {
      as_of: "2026-07-08",
      stage: { kind: "mid_cut", label: "Mid-cut", confidence: "high", basis: [] },
      progress: {
        start_weight_lb: 205,
        current_weight_lb: 195,
        goal_weight_lb: 180,
        lost_lb: 10,
        remaining_lb: 15,
        progress_fraction: 0.4,
        robust_trend_lb_wk: -1,
        target_rate: { low: 0.7, ideal: 1, high: 1.3 },
        timeline: { earliest_weeks: 12, likely_weeks: 16, latest_weeks: 22, confidence: "high", includes_stabilization: true },
      },
      scale: { state: "trend_clear", line: "The completed-day trend is clear." },
      muscle: { state: "holding", evidence: [] },
      fuel: { state: "protect", evidence: [] },
      action: { kind: "protect_fuel", status: "recommended", label: "Next protective adjustment", line: "Available to the nutrition loop." },
      line: "The path is moving while strength is protected.",
      reassurance: null,
      evidence_keys: [],
    },
    milestones: [],
  };
}

// Dated entries first (chronological, as the server returns them), horizon last.
function timelineFixture() {
  return [
    { id: "recheck1", kind: "recheck", when: { date: "2026-08-01" }, label: "Lipid recheck", detail: null, basis: "~90 days" },
    { id: "rescan", kind: "rescan", when: { window: { start: "2026-08-25", end: "2026-09-22" } }, label: "DEXA re-scan window", detail: null, basis: "since last scan" },
    { id: "goal", kind: "goal", when: { date: "2026-11-15" }, label: "Goal weight", detail: null, basis: "declared goal" },
    { id: "std", kind: "milestone", when: {}, label: "Bodyweight bench on the horizon", detail: null, basis: "" },
  ];
}

test("journey phaseSummary reuses the card's plain-language phase read, empty when no read", () => {
  const ctx = loadRoadFold();
  const line = ctx.CairnProgressJourney.phaseSummary(journeyFixture(), []);
  assert.match(line, /Mid-cut/);
  assert.match(line, /toward 180 lb/);
  assert.equal(ctx.CairnProgressJourney.phaseSummary(null, []), "");
});

test("timeline nextLabel names the nearest checkpoint and the road-ahead lead", () => {
  const ctx = loadRoadFold();
  const line = ctx.CairnJourneyTimeline.nextLabel(timelineFixture());
  assert.match(line, /Next: Lipid recheck/);
  assert.match(line, /The road to November/);
  assert.match(line, /checkpoint/);
  assert.equal(ctx.CairnJourneyTimeline.nextLabel([]), "");
});

test("the journey line points to Horizon's goal line, carrying the phase read and no score", () => {
  const ctx = loadRoadFold();
  const data = { journey: journeyFixture(), journeyMilestones: [], timeline: timelineFixture() };
  const html = ctx.tovJourneyPointerHtml(data);
  assert.match(html, /<a class="tov-jpoint/);
  assert.match(html, /href="\/app\/horizon\/goal"/);
  assert.match(html, /data-tov-horizon/);
  assert.match(html, /Mid-cut/);
  // One line: the cards themselves live on the goal line now, never folded here.
  assert.doesNotMatch(html, /jprog-card|ftl-card|<details/);
  assert.doesNotMatch(html, /\/100|\bscore\b|\bgrade\b/i);
});

test("without a phase read, the journey line names the next checkpoint on the road", () => {
  const ctx = loadRoadFold();
  const html = ctx.tovJourneyPointerHtml({ journey: null, journeyMilestones: [], timeline: timelineFixture() });
  assert.match(html, /Next: Lipid recheck/);
});

test("the journey line is empty when neither read has anything to say", () => {
  const ctx = loadRoadFold();
  assert.equal(ctx.tovJourneyPointerHtml({ journey: null, journeyMilestones: [], timeline: [] }), "");
});

test("train overview masthead never surfaces a day streak", () => {
  const overview = readFileSync(join(root, "src/client/progress-overview-client.ts"), "utf8");
  assert.doesNotMatch(overview, /day streak/);
  // The week reads as one voice line and one fact (working sets) — no stat strip.
  assert.doesNotMatch(overview, /class="statstrip"/);
  assert.match(overview, /working set\$\{sets === 1 \? "" : "s"\} this week/);
});

// ---------- the muscle rows fold ----------

function tovRow(group, tone, overrides = {}) {
  return { group, label: group, tone, sets: 6, band: "productive", verdict: "", trend: "", loadNote: "", ...overrides };
}

test("the muscle rows lead with the groups that ask for a look; the rest fold under one line", () => {
  const ctx = loadRoadFold();
  const rows = [
    tovRow("chest", "ok"),
    tovRow("back", "due", { band: "low" }),
    tovRow("shoulders", "ok"),
    tovRow("quads", "high", { band: "high" }),
    tovRow("hamstrings", "ok", { verdict: "stalling" }),
    tovRow("biceps", "ok"),
    tovRow("calves", "none", { sets: 0, band: "" }),
    tovRow("neck", "none", { sets: 0, band: "" }),
  ];
  const html = ctx.tovRowsHtml(rows);
  const [lead, fold] = html.split('<details class="tov-more">');
  const groups = (part) => [...part.matchAll(/class="tov-row[^"]*"[^>]*data-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups(lead), ["back", "quads", "hamstrings"]);
  // Quiet groups outside the anatomical scan (neck) are left out altogether.
  assert.deepEqual(groups(fold), ["chest", "shoulders", "biceps", "calves"]);
  assert.match(fold, /4 more muscle groups/);
  assert.match(fold, /Chest, Shoulders, Biceps…/);
  // Nothing asking for a look: the first three lead anyway, and no empty fold.
  const calm = ctx.tovRowsHtml([tovRow("chest", "ok"), tovRow("back", "ok"), tovRow("shoulders", "ok")]);
  assert.doesNotMatch(calm, /<details/);
  assert.equal(ctx.tovRowsHtml([tovRow("neck", "none")]), "");
});

test("a muscle whose volume is in range while its lifts stall says both facts, never one contradictory verdict", () => {
  const ctx = loadRoadFold();
  const html = ctx.tovRowsHtml([tovRow("chest", "ok", { verdict: "stalling", sets: 12 }), tovRow("back", "ok"), tovRow("shoulders", "ok")]);
  const chest = /data-group="chest"[\s\S]*?<span class="tov-row-note">([^<]*)<\/span>/.exec(html)[1];
  assert.equal(chest, "12 sets this week · volume is in range, progress has stalled");
  assert.doesNotMatch(chest, /in the productive range/);
  // Not stalling: the range reads as before.
  const back = /data-group="back"[\s\S]*?<span class="tov-row-note">([^<]*)<\/span>/.exec(html)[1];
  assert.equal(back, "6 sets this week · in the productive range");
});

test("a tap on a folded muscle opens its fold and finds its row", () => {
  const ctx = loadRoadFold();
  const opened = { open: false, setAttribute: (name) => (opened[name] = true) };
  const row = { closest: (sel) => (sel === "details" ? opened : null) };
  const view = { querySelector: (sel) => (sel === '.tov-row[data-group="calves"]' ? row : null) };
  assert.equal(ctx.tovOpenRow(view, "calves"), row);
  assert.equal(opened.open, true);
  assert.equal(ctx.tovOpenRow(view, "neck"), null);
  assert.equal(ctx.tovOpenRow(view, ""), null);
});
