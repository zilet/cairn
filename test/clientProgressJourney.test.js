import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJourneyClient() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    Set,
    String,
    document: { querySelectorAll: () => [] },
    escHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    },
    escAttr(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    },
    fmtShortDate(value) {
      return `short:${String(value || "")}`;
    },
    stagger(index) {
      return `--i:${index}`;
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/journey-progress-client.js"), "utf8"), context);
  return context;
}

test("journey progress card renders a calm milestone moment and escapes route text", () => {
  const context = loadJourneyClient();
  const html = context.CairnProgressJourney.journeyCardHtml(
    {
      profile: { goal_mode: "lose", goal_weight_lb: 180 },
      active_phase: { kind: "cut", start_date: "2026-06-01", target_weight_lb: 180 },
      transition_suggestion: {
        kind: "diet_break",
        reason: "Stalled after <several> weeks",
        start_date: "2026-07-08",
        target_weight_lb: 190,
        target_bodyfat_pct: null,
        planned_rate_lb_wk: 0,
      },
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
        action: {
          kind: "protect_fuel",
          status: "recommended",
          label: "Next protective adjustment",
          kcal_delta: 150,
          carb_forward: true,
          training_directive: "hold_aggression",
          autonomy: "none",
          effective_boundary: null,
          line: "The next protective adjustment is available to the nutrition autonomy loop.",
        },
        line: "The path is moving while strength is protected.",
        reassurance: "Later phases normally move more slowly.",
        evidence_keys: [],
      },
      milestones: [{
        id: "weight-loss-10",
        kind: "weight_loss",
        label: "10 lb <down>",
        detail: "From 205 to 195 <cleanly>.",
        achieved_date: "2026-07-01",
        achieved_at: null,
        value: 10,
        priority: 80,
      }],
    },
    [],
  );

  assert.match(html, /Journey/);
  assert.match(html, /Latest milestone/);
  assert.match(html, /10 lb &lt;down&gt;/);
  assert.match(html, /From 205 to 195 &lt;cleanly&gt;\./);
  assert.match(html, /Mid-cut/);
  assert.match(html, /10 lb down/);
  assert.match(html, /0\.7–1\.3 lb per week/);
  assert.match(html, /about 12–22 weeks/);
  assert.match(html, /What the scale says/);
  assert.match(html, /Muscle \/ fuel/);
  assert.match(html, /Next protective adjustment/);
  assert.doesNotMatch(html, /What Cairn is doing/);
  assert.match(html, /Possible next phase/);
  assert.match(html, /possible next/i);
  assert.doesNotMatch(html, /Coming next|coming next/);
  assert.match(html, /Discuss with coach/);
  assert.doesNotMatch(html, /Reviewable suggestion|Review in Coach/);
  assert.doesNotMatch(html, /<down>|<cleanly>|<several>/);
});

test("journey transition discussion prefills Coach without creating an approval gate", () => {
  const context = loadJourneyClient();
  const button = {
    handler: null,
    getAttribute(name) {
      assert.equal(name, "data-jpreview");
      return "Discuss a possible Cairn journey phase: diet break. This is a read-only possibility, not a scheduled change or approval gate.";
    },
    addEventListener(type, handler) {
      assert.equal(type, "click");
      this.handler = handler;
    },
  };
  const rootEl = { querySelectorAll: (selector) => selector === "[data-jpreview]" ? [button] : [] };
  context.state = {};
  context.activated = null;
  context.activateTab = (name) => { context.activated = name; };

  context.CairnProgressJourney.wire(rootEl);
  button.handler();

  assert.equal(context.activated, "chat");
  assert.match(context.state.chatPrefill, /read-only possibility/);
  assert.match(context.state.chatPrefill, /not a scheduled change or approval gate/);
  assert.doesNotMatch(context.state.chatPrefill, /do not apply it automatically/);
});

test("journey progress keeps a missing goal out of zero-pound copy", () => {
  const context = loadJourneyClient();
  const html = context.CairnProgressJourney.journeyCardHtml(
    {
      profile: { goal_mode: "lose", goal_weight_lb: null, goal_bodyfat_pct: null },
      active_phase: null,
      transition_suggestion: null,
      proposed_phases: [],
      milestones: [],
      recomposition: {
        as_of: "2026-07-08",
        stage: { kind: "uncertain", label: "Still learning the phase", confidence: "low", basis: [] },
        progress: {
          start_weight_lb: 205,
          current_weight_lb: 195,
          goal_weight_lb: null,
          lost_lb: 10,
          remaining_lb: null,
          progress_fraction: null,
          robust_trend_lb_wk: null,
          target_rate: null,
          timeline: null,
        },
        scale: { state: "ordinary_noise", line: "The trend is still thin." },
        muscle: { state: "unknown", evidence: [] },
        fuel: { state: "unknown", evidence: [] },
        action: {
          kind: "collect_signal",
          status: "holding",
          label: "Current move",
          kcal_delta: null,
          carb_forward: false,
          training_directive: "proceed",
          autonomy: "none",
          effective_boundary: null,
          line: "Keep collecting signal.",
        },
        line: "The destination is still open.",
        reassurance: null,
        evidence_keys: [],
      },
    },
    [],
  );

  assert.match(html, /Still learning the phase/);
  assert.doesNotMatch(html, /(?:>|toward )0 lb/);
});
