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
  const html = brief.briefHtml(
    {
      kind: "train",
      headline: "Push <today>",
      focus: "Upper <body>",
      why: "recovered & ready",
      est_minutes: 45,
      forward: "Next: legs <tomorrow>",
      arc: "Hidden when forward exists",
      signals: {},
    },
    { isToday: true, showPlan: false }
  );

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
  const html = brief.briefHtml(
    {
      kind: "easy",
      headline: "Light day",
      why: "",
      est_minutes: 25,
      signals: {},
    },
    { isToday: true, activeOverride: "rough night" }
  );

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

test("Today Brief renders separate recovery and calendar-block clocks with escaped content", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "easy",
      headline: "Easy today",
      why: "Keep the dose light.",
      computed_at: "2026-03-15T12:30:00.000Z",
      decision: {
        rule_code: "recovery_week_rest_softened_to_easy_after_loading_day",
        basis: "server_policy",
        baseline_kind: "train",
        reason: "Yesterday <loaded> the system.",
        evidence: [],
        computed_at: "2026-03-15T12:30:00.000Z",
      },
      forward: "Next: Push",
      arc: "Week 3 of 6 — opaque legacy arc",
      periodization_context: {
        recovery_overlay: {
          applied_on: "2026-03-13",
          until: "2026-03-20",
          day_index: 3,
          total_days: 7,
          proposal_id: 41,
          label: "reduced volume",
        },
        program_block: {
          goal: "Build <squat> & base",
          focus: "strength",
          stored_phase: "accumulation",
          effective_phase: "deload",
          week_index: 3,
          total_weeks: 6,
          started_at: "2026-03-01T08:00:00.000Z",
          counter_basis: "calendar_program_block",
        },
      },
      signals: {},
    },
    { isToday: true }
  );

  assert.match(html, /Recovery week · Day 3 of 7 · reduced volume/);
  assert.match(html, /Build &lt;squat&gt; &amp; base · Week 3 of 6/);
  assert.doesNotMatch(html, /Next: Push/, "an easy-day Brief does not add an unrelated forward line");
  assert.doesNotMatch(html, /opaque legacy arc|Build <squat>|Yesterday <loaded>/);
  assert.match(html, /Yesterday &lt;loaded&gt; the system/);
  assert.doesNotMatch(
    html,
    /recovery_week_rest_softened_to_easy_after_loading_day/,
    "machine rule codes stay in structured data"
  );
  assert.match(html, /Updated /);
});

test("easy/rest freshness copy shows a useful reason once without leaking machine codes", () => {
  const brief = loadTodayBrief();
  const base = {
    kind: "rest",
    headline: "Rest today",
    why: "Several hard days have stacked.",
    computed_at: "2026-03-15T12:30:00.000Z",
    decision: {
      rule_code: "accumulated_load_rest",
      basis: "deterministic",
      baseline_kind: "rest",
      reason: "Several hard days have stacked.",
      evidence: [],
      computed_at: "2026-03-15T12:30:00.000Z",
    },
    signals: {},
  };

  const duplicate = brief.briefHtml(base);
  assert.equal(duplicate.match(/Several hard days have stacked/g)?.length, 1);
  assert.doesNotMatch(duplicate, /accumulated_load_rest/);

  const useful = brief.briefHtml({
    ...base,
    decision: {
      ...base.decision,
      reason: "Yesterday exceeded the reduced recovery dose.",
      rule_code: "recovery_dose_overrun",
    },
  });
  assert.match(useful, /Yesterday exceeded the reduced recovery dose/);
  assert.doesNotMatch(useful, /recovery_dose_overrun/);
});

test("default train Brief keeps freshness subtle without repeating a decision reason", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml({
    kind: "train",
    headline: "Good to train",
    why: "You're recovered and due.",
    computed_at: "2026-03-15T12:30:00.000Z",
    decision: {
      rule_code: "planned_training",
      basis: "deterministic",
      baseline_kind: "train",
      reason: "A programmed session is due.",
      evidence: [],
      computed_at: "2026-03-15T12:30:00.000Z",
    },
    signals: {},
  });

  assert.match(html, /Updated /);
  assert.doesNotMatch(html, /planned_training|A programmed session is due/);
});

test("Today Brief handles done, provisional, and offline states", () => {
  const brief = loadTodayBrief();
  // The finished-session "Log more" card already covers entry — no action needed.
  const done = brief.briefHtml(
    {
      kind: "done",
      headline: "Training logged",
      why: "Top set in",
      est_minutes: null,
      signals: {},
    },
    { isToday: true, showDone: true }
  );
  const provisional = brief.briefHtml(brief.provisionalRead(), { isToday: true, reducedMotion: false });
  const offline = brief.briefHtml(
    {
      kind: "train",
      headline: "Today",
      why: "",
      est_minutes: null,
      signals: {},
      agent_status: "all_failed",
    },
    { isToday: true }
  );
  const dismissed = brief.briefHtml(
    {
      kind: "train",
      headline: "Today",
      why: "",
      est_minutes: null,
      signals: {},
      agent_status: "all_failed",
    },
    { isToday: true, offlineDismissed: true }
  );

  assert.match(done, /TRAINED TODAY/);
  assert.doesNotMatch(done, /data-redirect=|data-override=/);
  assert.match(provisional, /aria-busy="true"/);
  assert.match(provisional, /is-thinking/);
  assert.match(offline, /couldn't complete this read/);
  assert.match(offline, /reliable baseline/);
  assert.doesNotMatch(dismissed, /couldn't complete this read/);

  const invalid = brief.briefHtml(
    {
      kind: "train",
      headline: "Today",
      why: "",
      est_minutes: null,
      signals: {},
      agent_status: "all_failed",
      agent_issue: "invalid_response",
    },
    { isToday: true }
  );
  const unreachable = brief.briefHtml(
    {
      kind: "train",
      headline: "Today",
      why: "",
      est_minutes: null,
      signals: {},
      agent_status: "all_failed",
      agent_issue: "unreachable",
    },
    { isToday: true }
  );
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

  const train = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "", signals: {} },
    { isToday: true, showPlan: false, showDone: false }
  );
  assert.match(train, /data-redirect="start-session"/);
  assert.match(train, /brief-redirect-primary/);
  assert.match(train, /Start session/);
  assert.doesNotMatch(train, /Log training/);

  const easy = brief.briefHtml(
    { kind: "easy", headline: "Easy day", why: "", signals: {} },
    { isToday: true, showPlan: false }
  );
  assert.match(easy, /data-redirect="reveal-plan"/);
  assert.match(easy, /Train anyway/);
  assert.match(easy, /data-redirect="ask-session"/);

  const rest = brief.briefHtml(
    { kind: "rest", headline: "Rest day", why: "", signals: {} },
    { isToday: true, showPlan: false }
  );
  assert.match(rest, /data-redirect="reveal-plan"/);
  assert.match(rest, /data-redirect="ask-session"/);
});

test("Today Brief stops the thinking shimmer once a fetch has terminally failed", () => {
  const brief = loadTodayBrief();
  const stillLoading = brief.briefHtml(brief.provisionalRead(), { isToday: true, reducedMotion: false });
  const failed = brief.briefHtml(
    { ...brief.provisionalRead(), _failed: true },
    { isToday: true, reducedMotion: false }
  );

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
  assert.equal(
    withCheckin.find((r) => r.label === "Recovery signals"),
    undefined
  );

  // Recovery data present — not thin — so no gap row either.
  const withRecovery = brief.signalsRows({
    signals: { consecutive_training_days: 3, has_recovery_data: true },
  });
  assert.equal(
    withRecovery.find((r) => r.label === "Recovery signals"),
    undefined
  );

  // A provisional/empty read yields no rows — the caller falls back to prose.
  assert.deepEqual(plain(brief.signalsRows({ signals: {} })), []);
  assert.deepEqual(plain(brief.signalsRows(null)), []);
});

test("Today Brief materiallyDiffers compares only the visible fields", () => {
  const brief = loadTodayBrief();
  const base = {
    kind: "train",
    headline: "Upper day",
    why: "recovered and due",
    focus: "push",
    est_minutes: 45,
    signals: {},
  };

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

test("Today Brief materiallyDiffers tracks rendered periodization and freshness only", () => {
  const brief = loadTodayBrief();
  const base = {
    kind: "easy",
    headline: "Easy day",
    why: "Keep the dose light.",
    focus: null,
    est_minutes: 20,
    computed_at: "2026-03-15T12:30:00.000Z",
    decision: {
      rule_code: "recovery_week_rest_softened_to_easy_after_loading_day",
      basis: "server_policy",
      baseline_kind: "train",
      reason: "Yesterday carried a real load.",
      evidence: [],
      computed_at: "2026-03-15T12:30:00.000Z",
    },
    periodization_context: {
      recovery_overlay: {
        applied_on: "2026-03-13",
        until: "2026-03-20",
        day_index: 3,
        total_days: 7,
        proposal_id: 41,
        label: "reduced volume",
      },
      program_block: {
        goal: "Build squat + base",
        focus: "strength",
        stored_phase: "accumulation",
        effective_phase: "deload",
        week_index: 3,
        total_weeks: 6,
        started_at: "2026-03-01T08:00:00.000Z",
        counter_basis: "calendar_program_block",
      },
    },
    signals: {},
  };

  assert.equal(
    brief.materiallyDiffers(base, {
      ...base,
      source: "agent",
      agent: "claude",
      signals: { private: "changed" },
      decision: { ...base.decision, rule_code: "another_private_rule" },
    }),
    false,
    "identical visible output ignores private provenance and a rule-code-only change"
  );
  assert.equal(
    brief.materiallyDiffers(base, {
      ...base,
      periodization_context: {
        ...base.periodization_context,
        recovery_overlay: { ...base.periodization_context.recovery_overlay, day_index: 4 },
      },
    }),
    true,
    "the visible recovery day increment repaints"
  );
  assert.equal(
    brief.materiallyDiffers(base, {
      ...base,
      periodization_context: {
        ...base.periodization_context,
        program_block: { ...base.periodization_context.program_block, week_index: 4 },
      },
    }),
    true,
    "the visible block week repaints"
  );
  assert.equal(
    brief.materiallyDiffers(base, {
      ...base,
      periodization_context: {
        ...base.periodization_context,
        program_block: { ...base.periodization_context.program_block, goal: "Build deadlift + base" },
      },
    }),
    true,
    "the visible block goal repaints"
  );
  assert.equal(
    brief.materiallyDiffers(base, {
      ...base,
      decision: { ...base.decision, reason: "The longer run needs a lighter follow-up." },
    }),
    true,
    "the visible easy-day reason repaints"
  );
  assert.equal(
    brief.materiallyDiffers(base, {
      ...base,
      computed_at: "2026-03-15T13:30:00.000Z",
    }),
    false,
    "a clock tick alone is not worth rewriting the whole Brief"
  );
  assert.equal(
    brief.materiallyDiffers(base, { ...base, computed_at: undefined, decision: undefined }),
    true,
    "losing the freshness line entirely IS visible"
  );
});

test("a Brief with no specific reason renders the freshness line and nothing else", () => {
  const brief = loadTodayBrief();
  // Belt and braces for the server contract: when there is no athlete-facing
  // reason, the Brief must show NOTHING rather than engineering prose about
  // boundaries, postures or policies.
  const html = brief.briefHtml({
    kind: "rest",
    headline: "Rest today",
    why: "Let yesterday consolidate.",
    computed_at: "2026-03-15T12:30:00.000Z",
    decision: {
      rule_code: "cached_read_write",
      basis: "deterministic",
      baseline_kind: "rest",
      reason: "",
      evidence: [],
      computed_at: "2026-03-15T12:30:00.000Z",
    },
    signals: {},
  });

  assert.match(html, /Updated /);
  assert.doesNotMatch(html, /cached_read_write|boundary|deterministic|posture/i);
  assert.equal(html.match(/brief-updated">Updated [^<]*<\/div>/)?.length, 1, "the freshness line carries no reason");
  assert.equal(brief.decisiveReason({ kind: "rest", decision: { reason: "" } }, "rest"), "");
  assert.equal(brief.decisiveReason({ kind: "rest" }, "rest"), "", "a decision-less read has no reason to show");
});

test("a past date's freshness line names the day, not a bare clock time", () => {
  const brief = loadTodayBrief();
  const read = {
    kind: "rest",
    headline: "Rest today",
    why: "Let yesterday consolidate.",
    computed_at: "2026-03-14T10:12:00.000Z",
    signals: {},
  };

  // "Updated 6:12 AM" while browsing back to last Tuesday reads as this morning.
  const past = brief.briefHtml(read, { isToday: false });
  assert.doesNotMatch(past, /Updated \d{1,2}:\d{2}/);
  assert.match(past, /Updated Mar 1[34]/);

  const today = brief.briefHtml(read, { isToday: true });
  assert.match(today, /Updated \d{1,2}:\d{2}/);
});

// ---------- W4.2: the week-wins reassurance on rest/easy Briefs ----------
// Loads today-session-status-client.js ALONGSIDE today-brief-client.js in the
// same vm realm, since todayBriefWeekHtml reads CairnTodaySessionStatus.weekHtml
// off globalThis at render time (a lazy cross-module reference, not an eager
// top-level one — see CLAUDE.md's client-module load-order rule).
function loadTodayBriefWithSessionStatus() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    encodeURIComponent,
    escHtml,
    escAttr,
    fmtDur: (seconds) => `${seconds}s`,
    fmtWeight: (weight) => (weight == null ? "BW" : `${weight} lb`),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-status-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

test("Today Brief surfaces the week-wins sentence on a rest day", () => {
  const brief = loadTodayBriefWithSessionStatus();
  const html = brief.briefHtml(
    {
      kind: "rest",
      headline: "Rest today",
      why: "Nothing stacked up.",
      signals: {},
      week: { trained_days_7: 4, prs: 2 },
    },
    { isToday: true }
  );
  assert.match(html, /Trained 4 of the last 7 days, with 2 new bests/);
});

test("Today Brief surfaces the week-wins sentence on an easy day too", () => {
  const brief = loadTodayBriefWithSessionStatus();
  const html = brief.briefHtml(
    { kind: "easy", headline: "Keep it light", why: "Yesterday was heavy.", signals: {}, week: { trained_days_7: 3, prs: 0 } },
    { isToday: true }
  );
  assert.match(html, /Trained 3 of the last 7 days/);
  assert.doesNotMatch(html, /new best/);
});

test("Today Brief says nothing for a zero-training week — absence is not failure", () => {
  const brief = loadTodayBriefWithSessionStatus();
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {}, week: { trained_days_7: 0, prs: 0 } },
    { isToday: true }
  );
  assert.doesNotMatch(html, /done-week|0 of 7/);
});

test("Today Brief never renders week-wins on a train or done day even if the payload carries it", () => {
  const brief = loadTodayBriefWithSessionStatus();
  const trainHtml = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "Recovered.", signals: {}, week: { trained_days_7: 5, prs: 1 } },
    { isToday: true, showPlan: false }
  );
  assert.doesNotMatch(trainHtml, /Trained 5 of/);
});

test("Today Brief renders no week-wins line without the session-status module loaded (safe no-throw fallback)", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {}, week: { trained_days_7: 4, prs: 1 } },
    { isToday: true }
  );
  assert.doesNotMatch(html, /Trained 4 of/);
});

// ---------- the morning wake-up review (W4.7) ----------

test("Today Brief renders the look-back passage above today's suggestion, HTML-escaped", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "rest",
      headline: "Rest today",
      why: "Nothing stacked up.",
      signals: {},
      look_back: { passages: ["You rested yesterday <script>, as the read called for."], win: null },
    },
    { isToday: true }
  );
  assert.match(html, /brief-lookback/);
  assert.match(html, /Since yesterday/);
  assert.match(html, /You rested yesterday &lt;script&gt;, as the read called for\./);
  assert.doesNotMatch(html, /<script>/);
  const lookBackIndex = html.indexOf("brief-lookback");
  const kickerIndex = html.indexOf("brief-kicker");
  assert.ok(lookBackIndex > -1 && kickerIndex > -1 && lookBackIndex < kickerIndex, "look-back renders ABOVE the suggestion");
});

test("Today Brief combines a passage and the win into one quiet block", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "easy",
      headline: "Keep it light",
      why: "Yesterday was heavy.",
      signals: {},
      look_back: { passages: ["The read said easy yesterday; you went past it — noted."], win: "HRV came back." },
    },
    { isToday: true }
  );
  assert.match(html, /The read said easy yesterday; you went past it — noted\. HRV came back\./);
});

test("Today Brief renders no look-back block when the server sent nothing", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {}, look_back: { passages: [], win: null } },
    { isToday: true }
  );
  assert.doesNotMatch(html, /brief-lookback/);
});

test("Today Brief renders no look-back block when look_back is absent entirely", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "rest", headline: "Rest today", why: "Nothing stacked up.", signals: {} },
    { isToday: true }
  );
  assert.doesNotMatch(html, /brief-lookback/);
});

test("Today Brief never renders the look-back block on a routed past date", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "rest",
      headline: "Rest today",
      why: "Nothing stacked up.",
      signals: {},
      look_back: { passages: ["You rested yesterday."], win: null },
    },
    { isToday: false }
  );
  assert.doesNotMatch(html, /brief-lookback/);
});
