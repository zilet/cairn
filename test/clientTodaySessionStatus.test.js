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

function loadTodaySessionStatus() {
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
      { weight: 100, reps: 5 },
      { weight: 50, reps: 10 },
    ],
  }, { name: "Plan day" }, { isToday: true });

  assert.match(html, /class="sessiondone reveal"/);
  assert.match(html, /Today · complete/);
  assert.match(html, /Pull &lt;heavy&gt;/);
  assert.match(html, /2 sets/);
  assert.match(html, /1,000 lb/);
  assert.match(html, /52 min/);
  assert.match(html, /felt &lt;solid&gt;/);
  assert.match(html, /id="feedbackSlot"/);
  assert.match(html, /id="reopenBtn"/);
  assert.match(html, /id="toHistoryBtn"/);
  assert.doesNotMatch(html, /Pull <heavy>|felt <solid>/);
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
  assert.match(form, /aria-label="soreness 1"/);
  assert.match(form, /value="left &lt;knee&gt;"/);
  assert.match(form, /id="feedbackDismiss"/);
  assert.doesNotMatch(form, /left <knee>/);

  const done = status.feedbackDoneHtml({ soreness: 2, performance: 5, joint_pain: "right <hip>" });
  assert.match(done, /soreness 2\/5/);
  assert.match(done, /performance 5\/5/);
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
