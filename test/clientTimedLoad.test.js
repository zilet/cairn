// Loaded timed work on Today: the timed log row takes an optional WT beside the
// TIME, the header reads "2 × 0:40 @ 55", and every timed display shows the load
// when there is one (and only the time when there is not).
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

function loadContext() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    encodeURIComponent,
    decodeURIComponent,
    escHtml,
    escAttr,
    stagger: (index) => `--i:${index}`,
    art: () => "",
    artImg: () => "",
  };
  context.window = context;
  for (const file of [
    "format-utils.js",
    "date-utils.js",
    "ui-components.js",
    "today-training-client.js",
    "today-session-status-client.js",
    "today-plan-surface-client.js",
    "today-session-set-model.js",
    "today-cards-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, "public/js", file), "utf8"), context);
  }
  return context;
}

const CARRY = { fromPlan: true, exercise: "Farmer's Carry", mode: "timed", sets: 2, target_seconds: 40 };

test("a loaded carry card shows its load in the header and a WT + TIME log row", () => {
  const context = loadContext();
  const html = context.CairnTodayCards.exerciseCardHtml(
    { ...CARRY, target_weight: 55 },
    [],
    { weight: 55, duration_sec: 40 },
    null,
    null,
    { day: 2 }
  );
  assert.match(html, /<span class="ex-sets">2 × 0:40 @ <span class="ex-target numeral">55<\/span><\/span>/);
  assert.match(html, /<span>WT<\/span><span>TIME<\/span>/);
  const logrow = html.match(/<div class="logrow logrow-timed"[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(logrow, /data-mode="timed"/);
  assert.match(logrow, /class="in-w"[^>]*value="55"/);
  assert.match(logrow, /class="in-dur"[^>]*value="0:40"/);
  assert.match(logrow, /class="timerbtn"/, "the stopwatch stays on the row");
  assert.ok(logrow.indexOf("in-w") < logrow.indexOf("in-dur"), "WT comes before TIME");
});

test("an unloaded hold keeps a time-only header and a blank WT", () => {
  const context = loadContext();
  const html = context.CairnTodayCards.exerciseCardHtml({ ...CARRY, exercise: "Plank" }, [], { weight: null, duration_sec: 40 }, null, null, {});
  assert.match(html, /<span class="ex-sets">2 × 0:40<\/span>/);
  assert.match(html, /class="in-w"[^>]*value=""/);
});

test("the timed row posts its load (or null) with the duration", () => {
  const context = loadContext();
  function row(weight, time) {
    const inputs = { "in-w": { value: weight }, "in-dur": { value: time } };
    return {
      dataset: { ex: encodeURIComponent("Farmer's Carry"), day: "2", mode: "timed" },
      querySelector: (selector) => inputs[selector.slice(1)] ?? null,
    };
  }
  const deps = { state: { logDate: "2026-09-24" }, parseDur: context.parseDur, fmtDur: context.fmtDur };
  const loaded = context.CairnTodaySessionSetModel.logPayloadFromRow(row("50", "0:58"), deps);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.body.weight, 50);
  assert.equal(loaded.body.duration_sec, 58);
  assert.equal(loaded.body.exercise_mode, "timed");
  assert.equal(loaded.body.reps, null);

  const bare = context.CairnTodaySessionSetModel.logPayloadFromRow(row("", "45"), deps);
  assert.equal(bare.body.weight, null);
  assert.equal(bare.body.duration_sec, 45);
});

test("timed displays carry the load when present", () => {
  const context = loadContext();
  const model = context.CairnTodaySessionSetModel;
  const deps = { fmtDur: context.fmtDur };
  assert.equal(model.lastSetLineText({ weight: 50, duration_sec: 58 }, deps), "Last time: 50 × 0:58");
  assert.equal(model.lastSetLineText({ weight: null, duration_sec: 58 }, deps), "Last time: 0:58");
  assert.equal(model.lastSetLineText({ weight: -20, duration_sec: 30 }, deps), "Last time: 20 lb assist × 0:30");

  const chip = context.CairnTodaySessionStatus.setChipHtml({ id: 1, set_number: 1, weight: 50, duration_sec: 58 });
  assert.match(chip, /50 <span>×<\/span> 0:58/);
  const bareChip = context.CairnTodaySessionStatus.setChipHtml({ id: 2, set_number: 2, weight: null, duration_sec: 58 });
  assert.match(bareChip, /<\/span> 0:58<button/, "an unloaded hold's chip is the time alone");

  const rx = context.CairnTodayTraining.exRxLineHtml({
    mode: "timed",
    action: "overload",
    suggested: { sets: 2, seconds: 40, weight: 55 },
    delta_text: "+5 lb, 40s",
    why: "Every set owned the full time.",
  });
  assert.match(rx, /55 · 2 × 0:40/);
});
