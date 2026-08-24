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

function loadTodaySessionStatus(extra = {}) {
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
    fmtWeight: (weight) => weight == null ? "BW" : `${weight} lb`,
    ...extra,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-status-client.js"), "utf8"), context);
  return context.CairnTodaySessionStatus;
}

test("Today session status helper renders set chips and tonnage safely", () => {
  const status = loadTodaySessionStatus();

  assert.equal(status.setsTonnage([
    { weight: 100, reps: 5 },
    { weight: -20, reps: 8 },
    { duration_sec: 45 },
    { weight: 50, reps: 10 },
  ]), 1000);

  const chip = status.setChipHtml({ id: "7<bad>", set_number: 2, weight: 45, reps: 8, rir: "<2" });
  assert.match(chip, /data-set="7&lt;bad&gt;"/);
  assert.match(chip, /#2/);
  assert.match(chip, /45 lb <span>×<\/span> 8/);
  assert.match(chip, /@&lt;2/);
  assert.doesNotMatch(chip, /7<bad>|<2<\/span>/);

  assert.match(status.setChipHtml({ id: 9, duration_sec: 30 }), /30s/);
});

test("Today session done card preserves calm completion selectors and escaping", () => {
  const status = loadTodaySessionStatus();
  const html = status.sessionDoneCardHtml({
    title: "Pull <heavy>",
    day_name: "Fallback",
    duration_min: 52,
    notes: "felt <solid>",
    sets: [
      { exercise: "Squat <A>", weight: 100, reps: 5 },
      { exercise: "Row", weight: 50, reps: 10 },
    ],
  }, { name: "Plan day" }, { isToday: true });

  assert.match(html, /class="sessiondone reveal"/);
  assert.match(html, /Today · complete/);
  assert.match(html, /Pull &lt;heavy&gt;/);
  assert.match(html, /2 sets/);
  assert.match(html, /2 movements/);
  assert.match(html, /1,000 lb/);
  assert.match(html, /52 min/);
  assert.match(html, /ANALYSIS/);
  assert.match(html, /Top loaded work: Squat &lt;A&gt; · 500 lb/);
  assert.match(html, /Squat &lt;A&gt;/);
  assert.match(html, /100 lb x 5/);
  assert.match(html, /Row/);
  // Ranked rows only — no meaningless per-exercise bar (a share of session
  // tonnage/time/sets that duplicated the meta text and always rendered short).
  assert.match(html, /class="done-analysis-row"/);
  assert.doesNotMatch(html, /done-bar-track|done-bar-row|width:\d/);
  assert.match(html, /felt &lt;solid&gt;/);
  assert.match(html, /id="feedbackSlot"/);
  assert.match(html, /id="reopenBtn"/);
  assert.match(html, /id="toHistoryBtn"/);
  assert.doesNotMatch(html, /Pull <heavy>|felt <solid>|Squat <A>/);
  // With no highlights payload the card stays exactly as calm as today: no PR chip,
  // no "NEW BEST" lead, no per-row deltas — pure totals + the loaded-work fallback.
  assert.doesNotMatch(html, /done-chip-pr|NEW BEST|done-pr-spark/);
  assert.doesNotMatch(html, /done-analysis-delta|first time logged|matched last|vs last/);
  // Names are plain text (not tap-through buttons) when navigation isn't reachable.
  assert.doesNotMatch(html, /data-done-ex/);
});

test("Today outcome helper renders only escaped server-authored learning strings", () => {
  const status = loadTodaySessionStatus();
  const html = status.outcomeReadHtml({
    athlete_read: {
      learning: "Clean <work>",
      next_exposure: "Next: Squat <A> +5 <lb>",
    },
  }, "7<bad>");
  assert.match(html, /Clean &lt;work&gt;/);
  assert.match(html, /Next: Squat &lt;A&gt; \+5 &lt;lb&gt;/);
  assert.doesNotMatch(html, /Clean <work>|Squat <A>|\+5 <lb>/);
  assert.equal(status.outcomeReadHtml(null, "7"), "");
});

test("Today outcome hydration is an independent failure-safe and rejects stale cards", async () => {
  const slot = { innerHTML: "" };
  const card = {
    isConnected: true,
    sequence: "4",
    getAttribute(name) {
      return name === "data-done-seq" ? this.sequence : null;
    },
  };
  const document = {
    getElementById(id) {
      if (id === "doneCard-7") return card;
      if (id === "doneOutcomeSlot-7") return slot;
      return null;
    },
  };
  const status = loadTodaySessionStatus({
    document,
    api: async () => ({
      athlete_read: {
        learning: "Clean <work>",
        next_exposure: "Next <step>",
      },
    }),
  });
  await status.hydrateOutcome("7", 4, 0);
  assert.match(slot.innerHTML, /Clean &lt;work&gt;/);
  assert.match(slot.innerHTML, /Next &lt;step&gt;/);

  slot.innerHTML = "unchanged";
  card.sequence = "5";
  await status.hydrateOutcome("7", 4, 0);
  assert.equal(slot.innerHTML, "unchanged", "a stale response cannot touch a newer done card");

  const failed = loadTodaySessionStatus({
    document,
    api: async () => {
      throw new Error("offline");
    },
  });
  card.sequence = "6";
  await failed.hydrateOutcome("7", 6, 0);
  assert.equal(slot.innerHTML, "unchanged", "outcome failure leaves the existing completion UI intact");
});

test("finished anchor session shows bounded capacity movement only when provided", () => {
  const status = loadTodaySessionStatus();
  const moved = status.sessionDoneCardHtml({
    id: 9,
    title: "Push",
    sets: [{ exercise: "Bench Press", weight: 120, reps: 5 }],
    strength_journey_movement: {
      exercise: "Bench <Press>",
      current_est_1rm: 140,
      current_date: "2026-07-14",
      capacity_delta_lb: 5.2,
      gap_closed_lb: 5.2,
    },
  }, {}, { isToday: true });
  assert.match(moved, /class="done-journey"/);
  assert.match(moved, /Bench &lt;Press&gt; estimated 1RM moved \+5\.2 lb · 5\.2 lb of the gap closed/);

  const unchanged = status.sessionDoneCardHtml({ id: 10, title: "Push", sets: [] }, {}, { isToday: true });
  assert.doesNotMatch(unchanged, /done-journey|estimated 1RM moved/);
});

test("Today done card leads with PRs when highlights carry them", () => {
  const status = loadTodaySessionStatus();
  const html = status.sessionDoneCardHtml(
    { id: 42, title: "Lower", duration_min: 48, sets: [
      { exercise: "Back Squat", weight: 165, reps: 10 },
      { exercise: "Row", weight: 50, reps: 12 },
    ] },
    { name: "Plan day" },
    { isToday: true },
    {
      prs: [
        { exercise: "Back Squat", kind: "e1rm", label: "165 lb × 10" },
        { exercise: "Row", kind: "e1rm", label: "50 lb × 12" },
      ],
      comparisons: [],
      week: { prs: 2, trained_days_7: 4 },
    },
  );

  // The lead line becomes the PR celebration (sparkle + "New best"), never a score.
  assert.match(html, /class="lbl done-head-lbl done-head-pr">NEW BEST</);
  assert.match(html, /done-pr-spark/);
  // The lift name leads as the plain subject; the figure supports it, muted.
  assert.match(html, /✦<\/span> Back Squat <span class="done-head-stat">165 lb × 10<\/span>/);
  assert.match(html, /class="done-pr-more">\+1 more best</);
  // A terracotta "N PRs" chip joins the row, and it leads while tonnage sits LAST.
  assert.match(html, /class="done-chip done-chip-pr chip-in">2 PRs</);
  assert.ok(html.indexOf("2 PRs") < html.indexOf("48 min"), "PR chip precedes the duration chip");
  assert.ok(html.indexOf("48 min") < html.indexOf("2,250 lb"), "tonnage chip sits last, after duration");
  // Calm week context reads as a plain sentence of forward motion, not a metric wall.
  assert.match(html, /class="done-week">Trained 4 of the last 7 days, with 2 new bests</);
});

// W4.2: weekHtml is exported standalone so today-brief-client.ts can thread the
// same sentence onto rest/easy Briefs (todayBriefWeekHtml reads it off
// CairnTodaySessionStatus at render time).
test("weekHtml is exported and renders the same week-context sentence the done card uses", () => {
  const status = loadTodaySessionStatus();
  assert.equal(typeof status.weekHtml, "function");
  assert.match(status.weekHtml({ week: { trained_days_7: 4, prs: 2 } }), /Trained 4 of the last 7 days, with 2 new bests/);
  assert.equal(status.weekHtml({ week: { trained_days_7: 0, prs: 0 } }), "", "a zero-training week renders nothing");
  assert.equal(status.weekHtml({}), "");
});

test("Today done card leads with a forward comparison when there are no PRs", () => {
  const status = loadTodaySessionStatus();
  const html = status.sessionDoneCardHtml(
    { id: 7, title: "Push", sets: [
      { exercise: "Bench Press", weight: 185, reps: 5 },
      { exercise: "Incline DB", weight: 60, reps: 10 },
    ] },
    { name: "Plan day" },
    { isToday: false },
    {
      prs: [],
      comparisons: [
        { exercise: "Bench Press", prev_date: "2026-07-06", delta_label: "+5 lb", direction: "up" },
        { exercise: "Incline DB", prev_date: "2026-07-06", delta_label: "-5 lb", direction: "down" },
      ],
    },
  );

  // Forward-looking momentum line, human date ("Jul 6"), never a raw ISO.
  assert.match(html, /class="lbl done-head-lbl">MOMENTUM</);
  assert.match(html, /Bench Press \+5 lb <span class="done-head-vs">vs Jul 6</);
  assert.doesNotMatch(html, /NEW BEST|done-chip-pr/);
  assert.doesNotMatch(html, /2026-07-06/);
});

test("Today done card renders the calm fallback headline when highlights are absent", () => {
  const status = loadTodaySessionStatus();
  const html = status.sessionDoneCardHtml(
    { id: 9, title: "Full", sets: [{ exercise: "Deadlift", weight: 225, reps: 3 }] },
    { name: "Plan day" },
    { isToday: true },
    null,
  );
  assert.match(html, /class="lbl">ANALYSIS<\/span><strong>Top loaded work: Deadlift · 675 lb</);
  assert.doesNotMatch(html, /NEW BEST|MOMENTUM|done-analysis-delta|done-chip-pr/);
});

test("Today done card renders per-row deltas by direction", () => {
  const status = loadTodaySessionStatus();
  const html = status.sessionDoneCardHtml(
    { id: 11, title: "Mix", sets: [
      { exercise: "Squat", weight: 200, reps: 5 },
      { exercise: "Bench", weight: 150, reps: 5 },
      { exercise: "Row", weight: 100, reps: 8 },
      { exercise: "Curl", weight: 40, reps: 12 },
    ] },
    { name: "Plan day" },
    { isToday: true },
    {
      prs: [],
      comparisons: [
        { exercise: "Squat", delta_label: "+10 lb", direction: "up" },
        { exercise: "Bench", delta_label: "-5 lb", direction: "down" },
        { exercise: "Row", direction: "even" },
        // Curl intentionally omitted → "first time logged".
      ],
    },
  );
  assert.match(html, /class="done-analysis-delta done-delta-up">\+10 lb vs last</);
  assert.match(html, /class="done-analysis-delta done-delta-down">-5 lb vs last</);
  assert.match(html, /class="done-analysis-delta done-delta-even">matched last</);
  assert.match(html, /class="done-analysis-delta done-delta-new">first time logged</);
});

test("Today done card wires tap-through to Progress and escapes hostile names", () => {
  // With activateTab reachable, exercise names become tap-through buttons.
  const status = loadTodaySessionStatus({ activateTab: () => {} });
  const evil = 'Squat <img src=x onerror="alert(1)">';
  const html = status.sessionDoneCardHtml(
    { id: 3, title: "Lower", sets: [{ exercise: evil, weight: 100, reps: 5 }] },
    { name: "Plan day" },
    { isToday: true },
    { prs: [{ exercise: evil, kind: "e1rm", label: "<b>PR</b>" }], comparisons: [] },
  );
  assert.ok(
    html.includes('data-done-ex="Squat &lt;img src=x onerror=&quot;alert(1)&quot;&gt;"'),
    "tap-through data attribute is attribute-escaped",
  );
  assert.ok(
    html.includes('<span>Squat &lt;img src=x onerror="alert(1)"&gt;</span>'),
    "name text is html-escaped",
  );
  // The hostile name + PR label are escaped everywhere they surface — no live markup.
  assert.match(html, /&lt;b&gt;PR&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img src=x|<b>PR<\/b>/);
});

test("Today feedback markup owns scale, done state, and empty state", () => {
  const status = loadTodaySessionStatus();

  assert.equal(status.hasFeedback({}), false);
  assert.equal(status.hasFeedback({ joint_pain: "  " }), false);
  assert.equal(status.hasFeedback({ performance: 4 }), true);
  assert.match(status.feedbackOpenHtml(), /id="feedbackOpen"/);

  const form = status.feedbackFormHtml({ joint_pain: "left <knee>" });
  assert.match(form, /data-feel="soreness"/);
  assert.match(form, /data-feel="performance"/);
  // The scales are taps on a face, so they read back as words. A "3/5" here would
  // be a numeric grade on how the athlete felt — the one thing Cairn never shows.
  assert.match(form, /aria-label="soreness: fresh"/);
  assert.doesNotMatch(form, /aria-label="soreness \d"/);
  // A stored note never becomes an editable field again: the pain mini-UI is gone
  // from the finish form entirely (pain arrives in words). The done line below
  // still SHOWS it — display is not the same as asking someone to fill it in.
  assert.doesNotMatch(form, /feedbackJoint/);
  assert.doesNotMatch(form, /knee/);
  assert.match(form, /id="feedbackDismiss"/);
  assert.doesNotMatch(form, /left <knee>/);

  const done = status.feedbackDoneHtml({ soreness: 2, performance: 5, joint_pain: "right <hip>" });
  assert.match(done, /barely sore/);
  assert.match(done, /felt well above expected/);
  assert.doesNotMatch(done, /\d\s*\/\s*5/, "no numeric score reaches the athlete");
  assert.match(done, /right &lt;hip&gt;/);
  assert.match(done, /id="feedbackEdit"/);
  assert.equal(status.feedbackDoneHtml({}), "");
});

test("Today skip line renders stable undo selectors and empty state", () => {
  const status = loadTodaySessionStatus();

  const empty = status.skipLineHtml([]);
  assert.match(empty, /skipline-empty/);
  assert.match(empty, /id="skipLine"/);

  const html = status.skipLineHtml(["Back squat", "Run <easy>"]);
  assert.match(html, /data-unskip="Back%20squat"/);
  assert.match(html, /data-unskip="Run%20%3Ceasy%3E"/);
  assert.match(html, /Run &lt;easy&gt;/);
  assert.match(html, /title="Restore Run &lt;easy&gt;"/);
  assert.doesNotMatch(html, /Run <easy>/);
});
