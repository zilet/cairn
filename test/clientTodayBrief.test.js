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

// signalsRows returns objects/arrays built inside the vm realm, whose prototypes
// differ from this test realm — deepStrictEqual rejects that. Round-trip through
// JSON to compare structure, matching the controller test's `plain` helper.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
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
  // The finished-session "Log more" card already covers entry — no action needed.
  const done = brief.briefHtml({
    kind: "done",
    headline: "Training logged",
    why: "Top set in",
    est_minutes: null,
    signals: {},
  }, { isToday: true, showDone: true });
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
  assert.match(offline, /couldn't complete this read/);
  assert.match(offline, /reliable baseline/);
  assert.doesNotMatch(dismissed, /couldn't complete this read/);

  const invalid = brief.briefHtml({
    kind: "train",
    headline: "Today",
    why: "",
    est_minutes: null,
    signals: {},
    agent_status: "all_failed",
    agent_issue: "invalid_response",
  }, { isToday: true });
  const unreachable = brief.briefHtml({
    kind: "train",
    headline: "Today",
    why: "",
    est_minutes: null,
    signals: {},
    agent_status: "all_failed",
    agent_issue: "unreachable",
  }, { isToday: true });
  assert.match(invalid, /didn't return a usable read/);
  assert.match(unreachable, /Couldn't reach a coaching agent/);
});

test("Today Brief offers one quiet entry on a done read with nothing below to start training from", () => {
  const brief = loadTodayBrief();
  const doneRead = {
    kind: "done",
    headline: "Long run done",
    why: "Nice work",
    est_minutes: null,
    signals: {},
  };

  // A logged activity alone (no session row, no revealed plan) leaves neither
  // the finished-session card nor the plan surface on screen — the Brief must
  // be the one way in.
  const stranded = brief.briefHtml(doneRead, { isToday: true, showPlan: false, showDone: false });
  assert.match(stranded, /data-redirect="start-session"/);
  assert.match(stranded, /Log training/);
  // Exactly one entry action, not the primary "Start session" launch styling.
  assert.doesNotMatch(stranded, /brief-redirect-primary/);
  assert.doesNotMatch(stranded, /data-redirect="ask-session"/);

  // The finished-session "Log more" card already provides entry — no duplicate action.
  const withDoneCard = brief.briefHtml(doneRead, { isToday: true, showPlan: false, showDone: true });
  assert.doesNotMatch(withDoneCard, /data-redirect=/);

  // A revealed/launchable plan surface already provides entry — no duplicate action.
  const withPlan = brief.briefHtml(doneRead, { isToday: true, showPlan: true, showDone: false });
  assert.doesNotMatch(withPlan, /data-redirect=/);
});

test("Today Brief train/easy/rest actions are unaffected by the done-state entry fix", () => {
  const brief = loadTodayBrief();

  const train = brief.briefHtml({ kind: "train", headline: "Push day", why: "", signals: {} }, { isToday: true, showPlan: false, showDone: false });
  assert.match(train, /data-redirect="start-session"/);
  assert.match(train, /brief-redirect-primary/);
  assert.match(train, /Start session/);
  assert.doesNotMatch(train, /Log training/);

  const easy = brief.briefHtml({ kind: "easy", headline: "Easy day", why: "", signals: {} }, { isToday: true, showPlan: false });
  assert.match(easy, /data-redirect="reveal-plan"/);
  assert.match(easy, /Train anyway/);
  assert.match(easy, /data-redirect="ask-session"/);

  const rest = brief.briefHtml({ kind: "rest", headline: "Rest day", why: "", signals: {} }, { isToday: true, showPlan: false });
  assert.match(rest, /data-redirect="reveal-plan"/);
  assert.match(rest, /data-redirect="ask-session"/);
});

test("Today Brief stops the thinking shimmer once a fetch has terminally failed", () => {
  const brief = loadTodayBrief();
  const stillLoading = brief.briefHtml(brief.provisionalRead(), { isToday: true, reducedMotion: false });
  const failed = brief.briefHtml({ ...brief.provisionalRead(), _failed: true }, { isToday: true, reducedMotion: false });

  assert.match(stillLoading, /is-thinking/);
  assert.match(stillLoading, /aria-busy="true"/);
  assert.doesNotMatch(failed, /is-thinking/);
  assert.doesNotMatch(failed, /aria-busy="true"/);
  // Today's train-kind fallback content stays intact and clickable.
  assert.match(failed, /data-redirect="start-session"/);
});

test("Today signal summary preserves plain-language framing", () => {
  const brief = loadTodayBrief();
  assert.equal(brief.signalsText({ signals: {} }), "Reading your recent training and recovery.");
  assert.equal(
    brief.signalsText({ signals: { consecutive_training_days: 3, low_sleep: true, checkin: true } }),
    "3 days of training in a row; your sleep's been running short; you mentioned how you're feeling."
  );
  assert.equal(
    brief.signalsText({
      signals: { avg_sleep_min: 420, has_recovery_data: true, fatigue: { sleep_vs_norm: -40 } },
    }),
    "your sleep's been running short.",
    "adequate absolute sleep is not called normal when it is materially below the athlete's baseline"
  );
  assert.equal(
    brief.signalsText({
      signals: { avg_sleep_min: 420, has_recovery_data: true, fatigue: { sleep_vs_norm: -10 } },
    }),
    "sleep's been about normal for you."
  );
  assert.equal(
    brief.signalsText({ signals: { avg_sleep_min: 420, has_recovery_data: true } }),
    "Reading your recent training and recovery.",
    "missing personal-baseline evidence produces no normality claim"
  );
});

test("signalsRows maps the read's signals to reading-grammar contributor rows", () => {
  const brief = loadTodayBrief();

  // A settled, well-fed read: training + sleep both calm (ok), a check-in noted.
  const calm = brief.signalsRows({
    signals: {
      consecutive_training_days: 2,
      avg_sleep_min: 440,
      has_recovery_data: true,
      fatigue: { sleep_vs_norm: -5 },
      checkin: { energy: 4 },
    },
  });
  assert.deepEqual(plain(calm), [
    { label: "Training load", state: "2 loaded days in a row", tone: "ok" },
    { label: "Sleep", state: "settling in about normal for you", tone: "ok" },
    { label: "How you're feeling", state: "you checked in this morning", tone: "ok" },
  ]);

  // A stacking-up read: training high + sleep short are the two levers (watch);
  // no more than two watch rows, per the grammar.
  const strained = brief.signalsRows({
    signals: { consecutive_training_days: 6, low_sleep: true, has_recovery_data: true },
  });
  assert.deepEqual(plain(strained), [
    { label: "Training load", state: "running high, 6 loaded days in a row", tone: "watch" },
    { label: "Sleep", state: "running short of your usual", tone: "watch" },
  ]);
  assert.equal(strained.filter((r) => r.tone === "watch").length, 2);

  // An anticipated reset flips training load to a lever even below the day count.
  const anticipated = brief.signalsRows({
    signals: { consecutive_training_days: 2, has_recovery_data: true, fatigue: { anticipate_deload: true } },
  });
  assert.equal(anticipated[0].tone, "watch");
  assert.match(anticipated[0].state, /running high, 2 loaded days in a row/);

  // A rested stretch reads calmly, never as failure.
  const rested = brief.signalsRows({ signals: { consecutive_training_days: 0, has_recovery_data: true } });
  assert.deepEqual(plain(rested), [{ label: "Training load", state: "fresh — nothing stacked up lately", tone: "ok" }]);
});

test("signalsRows names an active life context as quiet information, escaping-safe input", () => {
  const brief = loadTodayBrief();
  const rows = brief.signalsRows({
    signals: {
      consecutive_training_days: 1,
      has_recovery_data: true,
      context: { reduce_load: true, active: [{ title: "Rome <trip>", kind: "travel" }] },
    },
  });
  const ctx = rows.find((r) => r.label === "Life context");
  assert.ok(ctx, "a life-context row is present");
  // Informational (quiet) even when it reduces load — the day's own signals stay levers.
  assert.equal(ctx.tone, "quiet");
  assert.equal(ctx.state, "planning around Rome <trip>");
});

test("signalsRows surfaces the thin-data gap as one calm quiet line with the next small move", () => {
  const brief = loadTodayBrief();

  // No wearable + no check-in: the read is looser — name the gap, offer the move.
  const thin = brief.signalsRows({ signals: { consecutive_training_days: 3 } });
  const gap = thin.find((r) => r.label === "Recovery signals");
  assert.ok(gap, "gap row present when nothing has fed the read");
  assert.equal(gap.tone, "quiet");
  assert.equal(gap.state, "none synced yet — a morning check-in sharpens the read");

  // A check-in already sharpens the read — no gap row, no double-count.
  const withCheckin = brief.signalsRows({
    signals: { consecutive_training_days: 3, checkin: { energy: 3 } },
  });
  assert.equal(withCheckin.find((r) => r.label === "Recovery signals"), undefined);

  // Recovery data present — not thin — so no gap row either.
  const withRecovery = brief.signalsRows({
    signals: { consecutive_training_days: 3, has_recovery_data: true },
  });
  assert.equal(withRecovery.find((r) => r.label === "Recovery signals"), undefined);

  // A provisional/empty read yields no rows — the caller falls back to prose.
  assert.deepEqual(plain(brief.signalsRows({ signals: {} })), []);
  assert.deepEqual(plain(brief.signalsRows(null)), []);
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
