import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escAttr(value) {
  return escHtml(value).replaceAll('"', "&quot;");
}

function loadTodayBrief() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    escHtml,
    escAttr,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

test("Today Brief renders calm launch and steer controls safely", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml({
    kind: "train",
    headline: "Push <today>",
    focus: "Upper <body>",
    why: "recovered & ready",
    est_minutes: 45,
    forward: "Next: legs <tomorrow>",
    arc: "Hidden when forward exists",
    signals: {},
  }, { isToday: true, showPlan: false });

  assert.match(html, /brief brief-train reveal/);
  assert.match(html, /TRAIN DAY · 45 min/);
  assert.match(html, /Push &lt;today&gt;/);
  assert.match(html, /Upper &lt;body&gt;/);
  assert.match(html, /recovered &amp; ready/);
  assert.match(html, /data-redirect="start-session"/);
  assert.match(html, /data-redirect="ask-session"/);
  assert.match(html, /data-override="rough night"/);
  assert.match(html, /Next: legs &lt;tomorrow&gt;/);
  assert.doesNotMatch(html, /Hidden when forward exists|Push <today>|Upper <body>/);
});

test("Today Brief suppresses irrelevant steer chips and exposes reset when steered", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml({
    kind: "easy",
    headline: "Light day",
    why: "",
    est_minutes: 25,
    signals: {},
  }, { isToday: true, activeOverride: "rough night" });

  assert.doesNotMatch(html, /data-override="rough night"/);
  assert.doesNotMatch(html, /data-override="short on time"/);
  assert.doesNotMatch(html, /data-override="give me an easy day"/);
  assert.match(html, /back to today's read/);
  assert.match(html, /Changed your mind\?/);
});

test("Today Brief shows the forward plan link on train AND done reads (not rest)", () => {
  const brief = loadTodayBrief();
  const read = {
    kind: "rest",
    headline: "Rest today",
    why: "Let the work absorb.",
    forward: "Next: Hinge / posterior chain",
    arc: "Week 1 of 6",
    signals: {},
  };

  assert.doesNotMatch(brief.briefHtml(read, { isToday: true }), /Next: Hinge/);
  assert.match(brief.briefHtml({ ...read, kind: "train" }, { isToday: true }), /Next: Hinge/);
  // After the work is in, "Next: …" is the so-what that replaces the retired
  // Start-session controls — a DONE day is never a dead end.
  const done = brief.briefHtml({ ...read, kind: "done", headline: "Long run done" }, { isToday: true });
  assert.match(done, /Next: Hinge/);
  assert.doesNotMatch(done, /Start session/);
});

test("Today Brief handles done, provisional, and offline states", () => {
  const brief = loadTodayBrief();
  const done = brief.briefHtml({
    kind: "done",
    headline: "Training logged",
    why: "Top set in",
    est_minutes: null,
    signals: {},
  }, { isToday: true });
  const provisional = brief.briefHtml(brief.provisionalRead(), { isToday: true, reducedMotion: false });
  const offline = brief.briefHtml({
    kind: "train",
    headline: "Today",
    why: "",
    est_minutes: null,
    signals: {},
    agent_status: "all_failed",
  }, { isToday: true });
  const dismissed = brief.briefHtml({
    kind: "train",
    headline: "Today",
    why: "",
    est_minutes: null,
    signals: {},
    agent_status: "all_failed",
  }, { isToday: true, offlineDismissed: true });

  assert.match(done, /TRAINED TODAY/);
  assert.doesNotMatch(done, /data-redirect=|data-override=/);
  assert.match(provisional, /aria-busy="true"/);
  assert.match(provisional, /is-thinking/);
  assert.match(offline, /showing the deterministic read/);
  assert.doesNotMatch(dismissed, /showing the deterministic read/);
});

test("Today signal summary preserves plain-language framing", () => {
  const brief = loadTodayBrief();
  assert.equal(brief.signalsText({ signals: {} }), "Reading your recent training and recovery.");
  assert.equal(
    brief.signalsText({ signals: { consecutive_training_days: 3, low_sleep: true, checkin: true } }),
    "3 days of training in a row; your sleep's been running short; you mentioned how you're feeling."
  );
});

test("Today Brief materiallyDiffers compares only the visible fields", () => {
  const brief = loadTodayBrief();
  const base = { kind: "train", headline: "Upper day", why: "recovered and due", focus: "push", est_minutes: 45, signals: {} };

  // Identical visible content — even with different non-visible fields — is NOT a diff.
  assert.equal(brief.materiallyDiffers(base, { ...base, source: "agent", agent: "claude", signals: { x: 1 } }), false);
  // Whitespace-only headline change is not material.
  assert.equal(brief.materiallyDiffers(base, { ...base, headline: "  Upper day " }), false);
  // est_minutes rounds before comparing.
  assert.equal(brief.materiallyDiffers(base, { ...base, est_minutes: 45.2 }), false);

  // Any visible-field change IS a diff.
  assert.equal(brief.materiallyDiffers(base, { ...base, kind: "easy" }), true);
  assert.equal(brief.materiallyDiffers(base, { ...base, headline: "Easy day" }), true);
  assert.equal(brief.materiallyDiffers(base, { ...base, why: "you're sore" }), true);
  assert.equal(brief.materiallyDiffers(base, { ...base, focus: "pull" }), true);
  assert.equal(brief.materiallyDiffers(base, { ...base, est_minutes: 30 }), true);
  // A missing operand is treated as a difference.
  assert.equal(brief.materiallyDiffers(null, base), true);
  assert.equal(brief.materiallyDiffers(base, null), true);
});
