import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the three IIFE-global client modules into ONE shared VM context — the way
// they share scope in the browser bundle — so tovJfoldHtml exercises the REAL
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

// Grab only the <summary>…</summary> text — the fold summary must carry no score.
function summaryOf(html) {
  const m = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html);
  return m ? m[1] : "";
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

test("tovJfoldHtml is a collapsed fold by default with populated journey data", () => {
  const ctx = loadRoadFold();
  const data = { journey: journeyFixture(), journeyMilestones: [], timeline: timelineFixture() };
  const html = ctx.tovJfoldHtml(data, {});
  assert.match(html, /<details class="tov-jfold/);
  // Collapsed: the <details> opening tag carries no `open` attribute.
  const openTag = /<details[^>]*>/.exec(html)[0];
  assert.doesNotMatch(openTag, /\bopen\b/);
});

test("tovJfoldHtml auto-opens when asked (muscle sections have nothing to lead with)", () => {
  const ctx = loadRoadFold();
  const data = { journey: journeyFixture(), journeyMilestones: [], timeline: timelineFixture() };
  const openTag = /<details[^>]*>/.exec(ctx.tovJfoldHtml(data, { open: true }))[0];
  assert.match(openTag, /\bopen\b/);
});

test("tovJfoldHtml summary carries the phase read + next checkpoint, and no score", () => {
  const ctx = loadRoadFold();
  const data = { journey: journeyFixture(), journeyMilestones: [], timeline: timelineFixture() };
  const summary = summaryOf(ctx.tovJfoldHtml(data, {}));
  // phase read (line 1) + next checkpoint (line 2)
  assert.match(summary, /Mid-cut/);
  assert.match(summary, /Next: Lipid recheck/);
  // Constitution: no 0-100 grade, no score/grade wording. A composition target like
  // "toward 15% BF" is a legitimate journey target (the card's own h3 shows it), so a
  // bare percentage is NOT banned here — only score-shaped framing is.
  assert.doesNotMatch(summary, /\/100|\bscore\b|\bgrade\b/i);
});

test("tovJfoldHtml renders BOTH cards inside the fold body, after the summary", () => {
  const ctx = loadRoadFold();
  const data = { journey: journeyFixture(), journeyMilestones: [], timeline: timelineFixture() };
  const html = ctx.tovJfoldHtml(data, {});
  assert.match(html, /jprog-card/); // journey card
  assert.match(html, /ftl-card/); // road-ahead timeline card
  const bodyStart = html.indexOf('class="tov-jfold-body"');
  assert.ok(bodyStart > 0);
  assert.ok(html.indexOf("jprog-card") > bodyStart, "journey card is inside the fold body");
  assert.ok(html.indexOf("ftl-card") > bodyStart, "timeline card is inside the fold body");
  // The summary itself carries none of the card markup.
  assert.doesNotMatch(summaryOf(html), /jprog-card|ftl-card/);
});

test("tovJfoldHtml degrades: only the surviving summary half, and only that card", () => {
  const ctx = loadRoadFold();
  // Journey only, no road ahead.
  const jOnly = ctx.tovJfoldHtml({ journey: journeyFixture(), journeyMilestones: [], timeline: [] }, {});
  assert.match(jOnly, /jprog-card/);
  assert.doesNotMatch(jOnly, /ftl-card/);
  assert.match(summaryOf(jOnly), /Mid-cut/);
  // Road ahead only, no journey read.
  const tOnly = ctx.tovJfoldHtml({ journey: null, journeyMilestones: [], timeline: timelineFixture() }, {});
  assert.match(tOnly, /ftl-card/);
  assert.doesNotMatch(tOnly, /jprog-card/);
  assert.match(summaryOf(tOnly), /Next: Lipid recheck/);
});

test("tovJfoldHtml is empty when neither card has anything to say", () => {
  const ctx = loadRoadFold();
  assert.equal(ctx.tovJfoldHtml({ journey: null, journeyMilestones: [], timeline: [] }, {}), "");
});
