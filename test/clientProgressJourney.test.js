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
  assert.match(html, /Reviewable suggestion/);
  assert.match(html, /Review in Coach/);
  assert.doesNotMatch(html, /<down>|<cleanly>|<several>/);
});

test("journey transition review button prefills Coach without applying anything", () => {
  const context = loadJourneyClient();
  const button = {
    handler: null,
    getAttribute(name) {
      assert.equal(name, "data-jpreview");
      return "Review this journey phase suggestion as a draft, but do not apply it automatically: diet break.";
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
  assert.match(context.state.chatPrefill, /do not apply it automatically/);
});
