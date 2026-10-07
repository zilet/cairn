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
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-signals-client.js"), "utf8"), context);
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
      // arc used to be silently discarded whenever forward existed (dead code) — the
      // two now render together (compactly), so this asserts arc actually appears.
      arc: "Week 2 of 6 arc <line>",
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
  // Today's own Brief no longer carries the "Around today" fold: the road ahead is the
  // Coming up rail (the Today redesign). Another date's Brief keeps it.
  assert.doesNotMatch(html, /Next: legs|brief-around/);
  assert.doesNotMatch(html, /Push <today>|Upper <body>|Week 2 of 6 arc <line>/);
  const other = brief.briefHtml(
    { kind: "train", headline: "Push", forward: "Next: legs <tomorrow>", arc: "Week 2 of 6 arc <line>", signals: {} },
    { isToday: false, showPlan: false }
  );
  assert.match(other, /Next: legs &lt;tomorrow&gt;/);
  assert.match(other, /Week 2 of 6 arc &lt;line&gt;/, "arc renders alongside forward, not discarded");
  assert.doesNotMatch(other, /Week 2 of 6 arc <line>/);
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

  // (Another date's Brief: today's own carries the road ahead in Coming up instead.)
  assert.doesNotMatch(brief.briefHtml(read, { isToday: false }), /Next: Hinge/);
  assert.match(brief.briefHtml({ ...read, kind: "train" }, { isToday: false }), /Next: Hinge/);
  assert.doesNotMatch(brief.briefHtml({ ...read, kind: "train" }, { isToday: true }), /Next: Hinge/);
  // After the work is in, "Next: …" is the so-what that replaces the retired
  // Start-session controls — a DONE day is never a dead end.
  const done = brief.briefHtml({ ...read, kind: "done", headline: "Long run done" }, { isToday: false });
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
    // Another date's Brief: today's carries the block clock on This week's header.
    { isToday: false }
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

test("Today Brief handles done and provisional states, and never carries agent health", () => {
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

  assert.match(done, /TRAINED TODAY/);
  assert.doesNotMatch(done, /data-redirect=|data-override=/);
  assert.match(provisional, /aria-busy="true"/);
  assert.match(provisional, /is-thinking/);

  // v2 wave 7: a read that fell back to Cairn's baseline reads like any other read.
  // Where the agent layer stands lives in Settings > Agents, never on Today.
  for (const [agent_status, agent_issue] of [
    ["all_failed", undefined],
    ["all_failed", "invalid_response"],
    ["all_failed", "unreachable"],
    ["unconfigured", undefined],
  ]) {
    const html = brief.briefHtml(
      { kind: "train", headline: "Today", why: "", est_minutes: null, signals: {}, agent_status, agent_issue },
      { isToday: true }
    );
    assert.doesNotMatch(html, /agent-offline|data-agentoffx/);
    assert.doesNotMatch(html, /reliable baseline|Coaching is offline|coaching agent/i);
  }
  assert.equal(brief.agentOfflineNoticeHtml, undefined);
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

test("Today Brief withholds Start session on a genuinely empty plan day, but still offers it once there's something to launch", () => {
  const brief = loadTodayBrief();

  // A train read whose plan/preview/logged-sets all agree the day is empty (the
  // same witness today-screen.ts's launch card uses) must not leave the Brief
  // offering a Start button into a session with nothing to open.
  const empty = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "", signals: {} },
    { isToday: true, showPlan: false, showDone: false, nothingToStart: true }
  );
  assert.doesNotMatch(empty, /data-redirect="start-session"/);
  assert.doesNotMatch(empty, /Start session/);
  // The other train-day action stays available.
  assert.match(empty, /data-redirect="ask-session"/);

  // A day that does carry items (nothingToStart false, or simply omitted) keeps
  // the Start action exactly as before.
  const hasItems = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "", signals: {} },
    { isToday: true, showPlan: false, showDone: false, nothingToStart: false }
  );
  assert.match(hasItems, /data-redirect="start-session"/);
  assert.match(hasItems, /Start session/);

  const omitted = brief.briefHtml(
    { kind: "train", headline: "Push day", why: "", signals: {} },
    { isToday: true, showPlan: false, showDone: false }
  );
  assert.match(omitted, /data-redirect="start-session"/);
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
  assert.equal(
    html.match(/data-brief-stamp hidden>Updated [^<]*<\/div>/)?.length,
    1,
    "the freshness line carries no reason"
  );
  assert.doesNotMatch(html, /brief-reason/, "and no reason line renders in the body either");
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
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-signals-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

test("the week-wins sentence on a rest day: another date's Brief says it; today's leaves the week to Horizon", () => {
  const brief = loadTodayBriefWithSessionStatus();
  const read = {
    kind: "rest",
    headline: "Rest today",
    why: "Nothing stacked up.",
    signals: {},
    week: { trained_days_7: 4, prs: 2 },
  };
  // The consistency line, never a week's new-best count (Train's What moved owns that).
  assert.match(brief.briefHtml(read, { isToday: false }), /Trained 4 of the last 7 days</);
  assert.doesNotMatch(brief.briefHtml(read, { isToday: false }), /new best/);
  // The week's counts are Horizon's (one home per fact): today's Brief says none of them.
  assert.doesNotMatch(brief.briefHtml(read, { isToday: true }), /Trained 4 of|done-week/);
});

test("the week-wins sentence on an easy day too (another date's Brief)", () => {
  const brief = loadTodayBriefWithSessionStatus();
  const html = brief.briefHtml(
    { kind: "easy", headline: "Keep it light", why: "Yesterday was heavy.", signals: {}, week: { trained_days_7: 3, prs: 0 } },
    { isToday: false }
  );
  assert.match(html, /Trained 3 of the last 7 days/);
  assert.doesNotMatch(html, /new best/);
});

// TODAY'S RUN ORDER (the front door): headline + why → push line → state line → check-in
// → What's ahead → the Horizon glance line → the push offer → the quiet day's menu → its actions → steer.
test("today's rest/easy Brief reads in one order, the lift line held light in the server's own words", () => {
  const brief = loadBriefWithReads();
  const html = brief.briefHtml(
    {
      kind: "easy",
      headline: "Keep it light",
      why: "Your sleep ran short.",
      est_minutes: 25,
      signals: {},
      strength_line: {
        state: "not_started",
        title: "Pull",
        text: "Pull · not started",
        suggestion: "easy",
        suggestion_label: "lighter <today>",
        caveat: "Today reads easy — Pull is still yours, just take it light.",
        reshaped: false,
        original: [],
      },
      recovery: { line: "If you want to move:", options: [{ label: "Easy walk", detail: "", minutes: 20 }] },
    },
    { isToday: true }
  );
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, `${needle} is on the Brief`);
    return i;
  };
  const order = [
    at('class="brief-why"'),
    at('id="todayPushSlot"'),
    at('class="brief-strength"'),
    at('id="checkinSlot"'),
    at('id="todayStripSlot"'),
    at('id="todayPathSlot"'),
    at('id="todayPushOfferSlot"'),
    at('class="brief-recovery"'),
    at('class="brief-now"'),
    at('class="brief-steer"'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the run order holds");
  // The state line says the plan day is held light (Train's own word), escaped; the kicker
  // drops a minutes figure that would contradict it.
  assert.match(html, /<span class="brief-strength-held">lighter &lt;today&gt;<\/span>/);
  assert.match(html, /EASY DAY<\/div>/);
  assert.doesNotMatch(html, /EASY DAY · 25 min/i);
  // The quiet day's actions keep their place below the menu, without a second lift line.
  const now = html.slice(at('class="brief-now"'));
  assert.doesNotMatch(now.slice(0, now.indexOf("</div>") + 6), /strength-line/);
});

test("today's train Brief leads with the NOW card under the why, before the week and the path", () => {
  const brief = loadBriefWithReads();
  const html = brief.briefHtml(
    {
      kind: "train",
      headline: "A strong Pull day",
      why: "Recovered.",
      signals: {},
      strength_line: { state: "not_started", title: "Pull", text: "Pull · not started", reshaped: false, original: [] },
    },
    { isToday: true, showPlan: false }
  );
  const now = html.indexOf('class="brief-now');
  assert.ok(now > html.indexOf('class="brief-why"'));
  assert.ok(now < html.indexOf('id="todayStripSlot"'), "the state line leads the week");
  assert.ok(html.indexOf('id="todayStripSlot"') < html.indexOf('id="todayPathSlot"'));
  assert.doesNotMatch(html, /id="checkinSlot"/, "a train read asks no check-in");
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

// ---- the morning check-in's mount (Finding 5, render half) ----

test("Today Brief mounts the check-in slot only on today's own rest/easy read", () => {
  const brief = loadTodayBrief();
  const base = { headline: "Today", why: "Let it settle.", signals: {} };

  for (const kind of ["rest", "easy"]) {
    const html = brief.briefHtml({ ...base, kind }, { isToday: true });
    assert.match(html, /id="checkinSlot"/, `${kind} read mounts the check-in`);
    // It sits under the sentence that asks the question, not below the actions.
    assert.ok(html.indexOf('class="brief-why"') < html.indexOf('id="checkinSlot"'));
    assert.ok(html.indexOf('id="checkinSlot"') < html.indexOf('class="brief-launch"'));
  }

  for (const kind of ["train", "done"]) {
    assert.doesNotMatch(
      brief.briefHtml({ ...base, kind }, { isToday: true }),
      /id="checkinSlot"/,
      `${kind} read asks nothing`
    );
  }

  assert.doesNotMatch(
    brief.briefHtml({ ...base, kind: "rest" }, { isToday: false }),
    /id="checkinSlot"/,
    "a routed past date is not a morning to check in on"
  );
});

// ---- the freshness stamp (Finding 6, client half) ----

test("Today Brief stamp says evidence freshness and read time separately when they differ", () => {
  const brief = loadTodayBrief();
  const read = {
    kind: "easy",
    headline: "Keep it light",
    why: "Load has been stacking.",
    signals: {},
    computed_at: "2026-03-15T12:39:00.000Z",
    evidence_as_of: "2026-03-15T12:35:00.000Z",
  };
  const html = brief.briefHtml(read, { isToday: true });

  assert.match(html, /As of .* sync/);
  assert.match(html, /Read at /);
  assert.doesNotMatch(html, /Updated /, "the ambiguous single stamp is gone once evidence is dated");
  assert.equal(html.match(/brief-stamp-line/g)?.length, 2);
});

test("Today Brief stamp collapses to one line when evidence and read share a minute", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "easy",
      headline: "Keep it light",
      why: "Load has been stacking.",
      signals: {},
      computed_at: "2026-03-15T12:35:10.000Z",
      evidence_as_of: "2026-03-15T12:35:40.000Z",
    },
    { isToday: true }
  );

  assert.match(html, /As of .* sync/);
  assert.doesNotMatch(html, /Read at /);
});

test("Today Brief stamp falls back to the read's own time when the server sends no evidence stamp", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    { kind: "easy", headline: "Keep it light", why: "", signals: {}, computed_at: "2026-03-15T12:39:00.000Z" },
    { isToday: true }
  );

  assert.match(html, /Updated /);
  assert.doesNotMatch(html, /As of |Read at /);
});

// ---- provenance behind the disclosure; the reason in the body ----

test("the freshness stamp is provenance: hidden, muted, with the why disclosure under the why", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "easy",
      headline: "Keep it light",
      why: "Load has been stacking.",
      signals: { consecutive_training_days: 3 },
      computed_at: "2026-03-15T12:39:00.000Z",
      evidence_as_of: "2026-03-15T12:35:00.000Z",
      decision: { reason: "The longer run needs a lighter follow-up.", computed_at: "2026-03-15T12:39:00.000Z" },
    },
    { isToday: true }
  );
  assert.match(html, /<div class="brief-updated lbl" data-brief-stamp hidden>/);
  const stampAt = html.indexOf("data-brief-stamp");
  // v2 wave 7: "tap to see why" sits right under the why it explains, not at the foot
  // of the Brief among Around today's rows; the stamp rides with it.
  assert.ok(stampAt > html.indexOf('brief-why"'), "the stamp follows the why");
  assert.ok(stampAt < html.indexOf("data-briefwhy"), "right before the disclosure toggle that opens it");
  assert.ok(html.indexOf("data-briefwhy") < html.indexOf("brief-launch"), "the disclosure sits above the actions");
  // The decisive reason is coaching, not provenance: it prints in the body, once.
  assert.match(html, /<p class="brief-reason">The longer run needs a lighter follow-up\.<\/p>/);
  assert.equal(html.match(/lighter follow-up/g)?.length, 1);
  assert.equal(
    brief.updatedInnerHtml({ computed_at: "2026-03-15T12:39:00.000Z", decision: { reason: "x y z" } }, "easy").includes("x y z"),
    false
  );
});

// ---- say each fact once (distinctLine) ----

test("distinctLine keeps a secondary line only when it adds something", () => {
  const brief = loadTodayBrief();
  const d = brief.distinctLine;
  const focus = "Quad-dominant strength & ankle resilience";
  // Equal (case / whitespace / punctuation-insensitive) or contained in a shown line.
  assert.equal(d(focus, focus), "");
  assert.equal(d("  quad-dominant STRENGTH and ankle resilience. ", "Quad-dominant strength and ankle resilience"), "");
  assert.equal(d(focus, `${focus} · in progress`), "");
  // A thin restatement ("Day 3 · <the same line>") is decoration, not a new fact.
  assert.equal(d(`Day 3 · ${focus}`, focus), "");
  // A sentence that merely MENTIONS a shown line still says something new.
  const why = `Squats lead today because the block asks for ${focus.toLowerCase()} this week`;
  assert.equal(d(why, focus), why);
  // Whole words only: "Push" is not contained in "Push-ups".
  assert.equal(d("Push", "Push-ups · in progress"), "Push");
  assert.equal(d("Pull", "Pull · in progress"), "");
  // Unrelated lines, empties and nulls.
  assert.equal(d("Upper body", "Push day", null, ""), "Upper body");
  assert.equal(d("", "Push day"), "");
  assert.equal(d(null), "");
  assert.equal(d("  Upper body  "), "Upper body");
});

// ---- one action, one button ----

function loadBriefWithReads() {
  const context = { Array, Math, Number, Object, String, Set, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-reads.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-voice-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-signals-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

test("a session with logged work says Continue, carries its progress, and names the focus once", () => {
  const brief = loadBriefWithReads();
  const focus = "Quad-dominant strength & ankle resilience";
  const read = {
    kind: "train",
    headline: "Good to go",
    focus,
    why: "Legs are fresh and the week has room.",
    est_minutes: 60,
    signals: {},
    strength_line: {
      state: "in_progress",
      title: focus,
      text: `${focus} · in progress`,
      caveat: null,
      suggestion: null,
      reshaped: false,
      original: [],
    },
  };
  const html = brief.briefHtml(read, {
    isToday: true,
    showPlan: true,
    session: {
      date: "2026-09-23",
      started: true,
      progress: "1 of 5 logged",
      minutes: 60,
      lines: ["Anchor day · Back Squat", focus],
    },
  });
  assert.match(html, /data-redirect="start-session">Continue session</);
  assert.doesNotMatch(html, /Start session/);
  assert.equal(html.match(/data-redirect="start-session"/g)?.length, 1, "one action, one button");
  // The card's progress rides as one quiet line in the NOW card, with the session's
  // minutes; the kicker then stops saying them, so they are said once.
  assert.match(html, /<div class="brief-session-meta">1 of 5 logged · ~60 min<\/div>/);
  assert.match(html, /TRAIN DAY<\/div>/, "the kicker leaves the minutes to the NOW card");
  assert.match(html, /class="brief-now brief-now-card"/);
  assert.ok(html.indexOf("brief-session-meta") < html.indexOf("brief-launch"));
  // The anchor line is the engine's reason: it waits behind "tap to see why".
  assert.match(html, /<div class="brief-caveats" data-brief-caveats hidden><div class="brief-caveat">Anchor day · Back Squat</);
  // The focus sentence appears exactly once — in today's lift line.
  assert.equal(html.match(/Quad-dominant strength &amp; ankle resilience/g)?.length, 1);
  assert.doesNotMatch(html, /class="brief-focus"/);

  // Different minutes than the kicker ARE a new fact.
  const other = brief.briefHtml(read, {
    isToday: true,
    showPlan: true,
    session: { date: "2026-09-23", started: true, progress: "1 of 5 logged", minutes: 45, lines: [] },
  });
  assert.match(other, /brief-session-meta">1 of 5 logged · ~45 min</);
});

test("the Brief's start follows the server lift line, and says Start before any work", () => {
  const brief = loadBriefWithReads();
  const line = (state) => ({ state, title: "Pull", text: `Pull · ${state.replace("_", " ")}`, reshaped: false, original: [] });
  const base = { kind: "train", headline: "Good to go", why: "", signals: {} };
  // The server line alone (no fold) is enough to say Continue.
  assert.match(
    brief.briefHtml({ ...base, strength_line: line("in_progress") }, { isToday: true }),
    /data-redirect="start-session">Continue session</
  );
  const fresh = brief.briefHtml(
    { ...base, strength_line: line("not_started") },
    { isToday: true, showPlan: true, session: { date: "d", started: false, progress: "5 movements", minutes: null, lines: [] } }
  );
  assert.match(fresh, /data-redirect="start-session">Start session</);
  assert.match(fresh, /brief-session-meta">5 movements</);
  // No fold, no quiet line — nothing invented.
  assert.doesNotMatch(brief.briefHtml(base, { isToday: true }), /brief-session/);
  // The fold is inert on a read whose Brief carries no start.
  assert.doesNotMatch(
    brief.briefHtml(
      { ...base, kind: "rest" },
      { isToday: true, showPlan: true, session: { date: "d", started: true, progress: "1 of 5 logged", minutes: 60, lines: [] } }
    ),
    /brief-session|Continue session/
  );
});

// ---- the earned default and the trade (Finding 10 + Finding 4's button) ----

function overriddenRead(days, extra = {}) {
  return {
    kind: "easy",
    headline: "Keep it light",
    why: "Load has been stacking.",
    signals: { easy_outcome_feedback: { active: days.length >= 2, overridden_and_fine: days } },
    ...extra,
  };
}

test("Today Brief keeps the generic label and hides the trade below two overridden mornings", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(overriddenRead(["2026-03-13"]), { isToday: true, planDayName: "Pull" });

  assert.match(html, /Train anyway/);
  assert.doesNotMatch(html, /data-tradetomorrow/);
  assert.doesNotMatch(html, /Pull day/);
});

test("Today Brief names the plan day and offers the trade after two overridden mornings", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(overriddenRead(["2026-03-12", "2026-03-13"]), {
    isToday: true,
    planDayName: "Pull",
  });

  assert.match(html, /brief-redirect-primary" data-redirect="reveal-plan">Pull day · your plan</);
  assert.match(html, /data-tradetomorrow>Train today, rest tomorrow</);
  assert.doesNotMatch(html, /Train anyway/);
  // "Ask for a session" stays, and stays last.
  assert.ok(html.indexOf("data-tradetomorrow") < html.indexOf('data-redirect="ask-session"'));
});

test("Today Brief leaves the plan-day label off when no plan day resolved, and still offers the trade", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(overriddenRead(["2026-03-12", "2026-03-13"]), { isToday: true });

  assert.match(html, /Train anyway/, "a button naming the wrong day would be worse than a generic one");
  assert.match(html, /data-tradetomorrow/);
});

test("Today Brief escapes a plan-day name and never repeats the word day", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(overriddenRead(["2026-03-12", "2026-03-13"]), {
    isToday: true,
    planDayName: "Recovery day <x>",
  });

  assert.match(html, /Recovery day &lt;x&gt; · your plan/);
  assert.doesNotMatch(html, /day day/);
});

test("Today Brief treats crossing the second overridden morning as a material difference", () => {
  const brief = loadTodayBrief();
  const one = overriddenRead(["2026-03-13"]);
  const two = overriddenRead(["2026-03-12", "2026-03-13"]);

  assert.equal(brief.materiallyDiffers(one, two), true);
  assert.equal(brief.materiallyDiffers(two, { ...two }), false);
});

test("Today Brief drops the trade once the server has refused it, keeping the plan-day label", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(overriddenRead(["2026-03-12", "2026-03-13"]), {
    isToday: true,
    planDayName: "Pull",
    tradeRefused: true,
  });

  assert.doesNotMatch(html, /data-tradetomorrow/, "a refused trade is not re-offered on the next paint");
  // The earned default is untouched — the refusal is about tomorrow, not today.
  assert.match(html, /data-redirect="reveal-plan">Pull day · your plan</);
  assert.match(html, /data-redirect="ask-session"/);
});

// The Brief prints the server's today strength line — the same words the Session
// header, the week strip and the Train overview print — and a run-only "done" day
// with the plan's lift still open offers that lift by NAME, never as the loud button
// against a rest suggestion.
test("Today Brief carries the today strength line and names the open lift", () => {
  const context = { Array, Math, Number, Object, String, Set, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-reads.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-signals-client.js"), "utf8"), context);
  const brief = context.CairnTodayBrief;
  const line = {
    state: "not_started",
    title: "Pull",
    text: "Run in · Pull still open",
    caveat: "The read suggests rest today — Pull is still yours if you want it.",
    suggestion: "rest",
    reshaped: false,
    original: [],
  };
  const done = brief.briefHtml(
    { kind: "done", headline: "Solid run logged.", why: "Road miles in.", strength_line: line },
    { isToday: true }
  );
  assert.match(done, /class="brief-strength"/);
  assert.match(done, /Run in · Pull still open/);
  assert.match(done, /suggests rest today/);
  assert.match(done, /data-redirect="start-session">Start Pull</);
  assert.doesNotMatch(done, /brief-redirect-primary" data-redirect="start-session"/);
  // On a rest read the Brief IS the caveat: only the line rides along.
  const rest = brief.briefHtml({ kind: "rest", headline: "Rest.", why: "Recover.", strength_line: line }, { isToday: true });
  assert.match(rest, /Run in · Pull still open/);
  assert.doesNotMatch(rest, /strength-line-caveat/);
  // No line → nothing new rendered.
  assert.doesNotMatch(brief.briefHtml({ kind: "train", headline: "x" }, { isToday: true }), /brief-strength/);
});

function loadVoicedBrief() {
  const context = { Array, Math, Number, Object, String, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-voice-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-signals-client.js"), "utf8"), context);
  return { brief: context.CairnTodayBrief, voice: context.CairnTodayBriefVoice };
}

test("the why marks at most one word per stone, escaped first, and leaves plain prose alone", () => {
  const { brief, voice } = loadVoicedBrief();
  assert.equal(voice.whyHtml("Keep the dose light."), "Keep the dose light.");
  const html = voice.whyHtml("You slept well, deadlift climbs, and sleep holds; protein matters");
  assert.match(html, /<span class="brief-tok stone-recovery">slept<\/span>/);
  assert.match(html, /<span class="brief-tok stone-strength">deadlift<\/span>/);
  assert.equal((html.match(/stone-recovery/g) || []).length, 1, "one token per stone");
  // The Brief escapes before the tokens run.
  const painted = brief.briefHtml({ kind: "train", headline: "Pull", why: "Sleep <script>", signals: {} }, { isToday: true });
  assert.match(painted, /<span class="brief-tok stone-recovery">Sleep<\/span> &lt;script&gt;/);
  // Without the voice module (a partial boot) the why is plain escaped prose.
  assert.match(loadTodayBrief().briefHtml({ kind: "train", headline: "Pull", why: "Sleep <script>", signals: {} }, { isToday: true }), /<p class="brief-why">Sleep &lt;script&gt;<\/p>/);
});

test("the week around the read folds behind one tap, and a started session shows the live card", () => {
  const { brief } = loadVoicedBrief();
  const html = brief.briefHtml(
    { kind: "train", headline: "Pull", why: "", forward: "Next: legs", signals: {} },
    {
      isToday: true,
      session: {
        date: "2026-01-05",
        started: true,
        progress: "1 of 3 logged",
        minutes: 50,
        lines: [],
        live: { name: "Pull <b>", done: 1, total: 3, last: "Row 140 × 8", next: "Curl 30 × 12" },
      },
    }
  );
  // Today's Brief no longer folds the week around it (Coming up carries the road
  // ahead); the connected-brain provenance stays in view.
  assert.doesNotMatch(html, /brief-around|Next: legs/);
  assert.match(html, /id="briefProvenance"/);
  const other = brief.briefHtml({ kind: "train", headline: "Pull", why: "", forward: "Next: legs", signals: {} }, { isToday: false });
  assert.match(other, /<details class="brief-around">[\s\S]*Next: legs[\s\S]*<\/details>/);
  assert.ok(other.indexOf('id="briefProvenance"') > other.indexOf("</details>"), "provenance stays in view");
  assert.match(html, /class="brief-live"/);
  assert.match(html, /Now · Pull &lt;b&gt; · 1 of 3/);
  assert.match(html, /Row 140 × 8\. Next: Curl 30 × 12\./);
  assert.equal((html.match(/<i class="on"><\/i>/g) || []).length, 1);
  assert.match(html, /data-redirect="start-session">Continue session/);
  assert.ok(html.indexOf("brief-live") < html.indexOf("brief-launch"), "the live card sits over the Continue button");
});

test("the live card keeps the server's lift line and the session's guardrails, and only takes the progress meta", () => {
  const { brief } = loadVoicedBrief();
  const session = {
    date: "2026-01-05",
    started: true,
    progress: "1 of 3 logged",
    minutes: 50,
    lines: ["Recheck the sore knee on the affected movement"],
    live: { name: "Pull", done: 1, total: 3, last: "Row 140 × 8", next: "Curl 30 × 12" },
  };
  const html = brief.briefHtml({ kind: "train", headline: "Pull", why: "", signals: {} }, { isToday: true, session });
  assert.match(html, /class="brief-live"/);
  assert.match(html, /Recheck the sore knee on the affected movement/);
  assert.doesNotMatch(html, /brief-session-meta/);
  assert.doesNotMatch(html, /1 of 3 logged/);
  // A past date's train read never shows a session as under way; its fold keeps the meta.
  const past = brief.briefHtml({ kind: "train", headline: "Pull", why: "", forward: "Next: legs", signals: {} }, { isToday: false, session });
  assert.doesNotMatch(past, /brief-live/);
  assert.match(past, /1 of 3 logged/);
  assert.match(past, /Around this day/);
});

test("the live card counts every lift in its words and caps only the bars", () => {
  const { voice } = loadVoicedBrief();
  const html = voice.liveHtml({ name: "Full", done: 7, total: 14 });
  assert.match(html, /Full · 7 of 14/);
  assert.equal((html.match(/<i[ >]/g) || []).length, 12);
  assert.equal((html.match(/<i class="on"><\/i>/g) || []).length, 6);
});

test("a bar load is not the body stone", () => {
  const { voice } = loadVoicedBrief();
  assert.doesNotMatch(voice.whyHtml("add weight to the bar"), /stone-body/);
  assert.match(voice.whyHtml("your bodyweight is holding"), /stone-body/);
});

test("the live facts come off the log: the newest set, then the next set or the next open lift", () => {
  const { voice } = loadVoicedBrief();
  const items = [
    { exercise: "Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 140 },
    { exercise: "Assisted Pull-Up", sets: 2, rep_low: 6, rep_high: 8, target_weight: -30 },
  ];
  const mid = voice.liveFacts({ name: "Pull", done: 0, total: 2, items, logged: { Row: [{ id: 4, weight: 140, reps: 9 }] } });
  assert.equal(mid.last, "Row 140 × 9");
  assert.equal(mid.next, "set 2 of 3");
  const moved = voice.liveFacts({
    name: "Pull",
    done: 1,
    total: 2,
    items,
    logged: { Row: [{ id: 4, weight: 140, reps: 9 }, { id: 5, weight: 140, reps: 8 }, { id: 7, weight: 140, reps: 8 }] },
  });
  assert.equal(moved.next, "Assisted Pull-Up 30 assist × 6–8");
  assert.equal(voice.liveHtml(null), "");
});

test("the NOW card: today's lift as its key, the focus once (what it adds), one idle bar per lift, then the start", () => {
  const brief = loadBriefWithReads();
  const read = {
    kind: "train",
    headline: "A strong, controlled Pull day.",
    focus: "Pull — back, rear delts, biceps",
    why: "Recovered and due.",
    est_minutes: 55,
    signals: {},
    strength_line: { state: "not_started", title: "Pull", text: "Pull · not started", reshaped: false, original: [] },
  };
  const html = brief.briefHtml(read, {
    isToday: true,
    showPlan: true,
    session: { date: "d", started: false, progress: "5 movements", minutes: 60, count: 5, lines: [] },
  });
  assert.match(html, /class="brief-now brief-now-card"/);
  assert.match(html, /brief-now-top lbl">.*Today's lift</);
  assert.match(html, /strength-line-t">Pull · not started</, "the server line, verbatim");
  assert.match(html, /brief-now-focus">back, rear delts, biceps</, "the focus says only what the line does not");
  assert.equal(html.match(/rear delts/g)?.length, 1, "the focus is said once, in the card");
  assert.equal(html.match(/<i><\/i>/g)?.length, 5, "one idle bar per lift");
  assert.match(html, /brief-session-meta">5 movements · ~60 min</);
  assert.doesNotMatch(html, /TRAIN DAY · 55 min/, "one number for the session's length, not two");
  const order = ["brief-headline", "brief-now-card", "brief-launch", "brief-steer"].map((k) => html.indexOf(k));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "voice, then NOW with its start, then the steer");
});

test("a read that carries no session keeps a bare NOW wrapper (the stones' anchor) and no card", () => {
  const brief = loadBriefWithReads();
  const rest = brief.briefHtml({ kind: "rest", headline: "Rest day", why: "", signals: {} }, { isToday: true, showPlan: false });
  assert.match(rest, /class="brief-now"/);
  assert.doesNotMatch(rest, /brief-now-card/);
  const train = brief.briefHtml(
    { kind: "train", headline: "Push", focus: "Upper", est_minutes: 45, why: "", signals: {} },
    { isToday: true, showPlan: false }
  );
  assert.doesNotMatch(train, /brief-now-card/);
  assert.match(train, /TRAIN DAY · 45 min/, "with no card the kicker keeps the minutes");
  assert.match(train, /class="brief-focus">Upper</, "and the focus stays under the headline");
});
