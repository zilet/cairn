import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPlanEditor() {
  const escapeText = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const context = {
    Object,
    String,
    Array,
    Number,
    Math,
    encodeURIComponent,
    art: (kind, text) => `<svg data-kind="${kind}" data-text="${String(text)}"></svg>`,
    artImg: (kind, text, className) => `<span class="${className}" data-kind="${kind}">${escapeText(text)}</span>`,
    fmtDur: (seconds) => `${Math.round(Number(seconds) / 60)}m`,
    fmtWeight: (weight) => `${Number(weight)} lb`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  // The real strength-only filters (loaded ahead of the Plan bundle in the app).
  vm.runInNewContext(readFileSync(join(root, "public/js/cardio-plan-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-editor-client.js"), "utf8"), context);
  return context.CairnPlanEditor;
}

test("plan editor normalizes plan rows and exposes stable blank item defaults", () => {
  const editor = loadPlanEditor();

  // Runs left the strength plan: a cardio item an older payload still carries is
  // dropped from the model, never edited as a plan row.
  const day = editor.dayModelFromPlan({
    day_number: 2,
    name: "Tempo",
    items: [
      { kind: "strength", exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5, interval: { note: "ignored" } },
      { kind: "cardio", note: "Easy run", interval: { note: "6x400m" }, target_zone: "Z2" },
    ],
  });

  assert.equal(day.focus, "");
  assert.equal(day.items.length, 1);
  assert.equal(day.items[0].kind, "strength");
  assert.equal(day.items[0].exercise, "Bench");
  const strength = editor.blankStrength();
  assert.equal(strength.kind, "strength");
  assert.equal(strength.exercise, "");
  assert.equal(strength.sets, 3);
  assert.equal(strength.rep_low, 8);
  assert.equal(strength.rep_high, 10);
  assert.equal(strength.target_weight, null);
  assert.equal(strength.note, "");
  assert.equal(strength.warmup_sets, null);
  assert.equal(editor.blankCardio, undefined, "the editor no longer builds a run row");
});

test("plan editor calendar footer and read-only day cards escape dynamic content", () => {
  const editor = loadPlanEditor();

  const footer = editor.calendarFooterHtml([{ day_number: 1 }], `host"<bad>`, `/api/plan.ics?token="<x>`);
  assert.match(footer, /webcal:\/\/host&quot;&lt;bad&gt;\/api\/plan\.ics\?token=&quot;&lt;x&gt;/);
  assert.doesNotMatch(footer, /host"<bad>|token="<x>/);
  assert.equal(editor.calendarFooterHtml([], "host", "/api/plan.ics"), "");

  const html = editor.progDayHtml({
    day_number: 1,
    name: "Upper <push>",
    focus: "Chest & back",
    items: [
      { kind: "strength", exercise: "Bench <press>", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185, note: "pause <rep>", warmup_sets: 2 },
      { kind: "cardio", note: "Easy ride <easy>", target_duration_min: 45, target_zone: "Z2" },
    ],
  }, 0);

  assert.match(html, /Upper &lt;push&gt;/);
  assert.match(html, /Chest &amp; back/);
  assert.match(html, /Bench &lt;press&gt;/);
  assert.match(html, /2 warmup · pause &lt;rep&gt;/);
  assert.match(html, /3 × 5/);
  assert.match(html, /185 lb/);
  // A run on an old payload's day is not drawn on the strength card.
  assert.doesNotMatch(html, /Easy ride|cardio/);
  assert.match(html, /data-guide="Bench%20%3Cpress%3E"/);
  assert.doesNotMatch(html, /<push>|<press>|<rep>|<easy>/);
  // Every plan day in the read view offers a "Train this day" entry into logging,
  // keyed by the day's array index (mirrors data-editday).
  assert.match(html, /<button class="ghostbtn prog-train" data-trainday="0">Train<\/button>/);
  assert.match(html, /data-editday="0"/);
});

test("plan editor editable rows preserve selectors, ordering controls, and escaped values", () => {
  const editor = loadPlanEditor();

  const dayHtml = editor.pdayHtml({
    name: `Day "A"`,
    focus: "Build <base>",
    items: [
      { kind: "strength", exercise: `Deadlift "heavy"`, sets: 4, rep_low: 3, rep_high: 5, target_weight: 275, note: "smooth <pull>", warmup_sets: 2 },
      { kind: "strength", exercise: "Row", sets: 3, rep_low: 8, rep_high: 10 },
      { kind: "cardio", note: "Long run", target_distance_km: 12.5, target_duration_min: 75, target_zone: "Z2", interval_note: "last 10m steady" },
    ],
  }, 2);

  assert.match(dayHtml, /class="pday" data-d="2"/);
  assert.match(dayHtml, /class="pday-name" value="Day &quot;A&quot;"/);
  assert.match(dayHtml, /class="pday-focus" value="Build &lt;base&gt;"/);
  assert.match(dayHtml, /data-upitem="2:0" disabled/);
  assert.match(dayHtml, /data-downitem="2:1" disabled/);
  assert.match(dayHtml, /value="Deadlift &quot;heavy&quot;"/);
  assert.match(dayHtml, /value="smooth &lt;pull&gt;"/);
  assert.match(dayHtml, /data-additem="2"/);
  // Lifts only: no Lift/Cardio kind toggle, no run row, no "+ cardio", no rest toggle.
  assert.doesNotMatch(dayHtml, /data-pikind|pitem-cardio|data-kind="cardio"|placeholder="km"|data-addcardio|data-restday/);
  assert.doesNotMatch(dayHtml, /<base>|<pull>|Deadlift "heavy"/);
});

// ---- rest is the calendar, not a plan row ----
// Runs left the strength plan and a rest day is a weekday with neither a lift nor a
// run, so the editor models lift days only: no rest toggle, no rest read view.
test("the editor models lift days only — a day is a training day, an empty one still isn't startable", () => {
  const editor = loadPlanEditor();
  assert.equal(
    editor.dayModelFromPlan({ day_number: 3, name: "Rest", focus: null, day_type: "rest", items: [] }).day_type,
    "training",
    "the model never carries a rest row back to the server"
  );
  assert.equal(
    editor.dayModelFromPlan({ day_number: 1, name: "Push", focus: "push", items: [] }).day_type,
    "training",
    "a day that says nothing is an ordinary day"
  );

  // An EMPTY training day is not startable either: a Start button into an empty
  // session was the bug ("an Easy day I could actually start, with no exercises").
  const emptyTraining = editor.progDayHtml(
    editor.dayModelFromPlan({ day_number: 2, name: "Easy", focus: "Easy day", items: [] }),
    1
  );
  assert.doesNotMatch(emptyTraining, /prog-train/);
  assert.match(emptyTraining, /data-editday="1"/, "it can still be edited into a day");

  const training = editor.pdayHtml(
    editor.dayModelFromPlan({ day_number: 1, name: "Push", focus: "push", items: [] }),
    0
  );
  assert.doesNotMatch(training, /rest day|data-restday/);
  assert.match(training, /data-additem/);

  // The one pointer to where runs live: calm, escaped, a button into Endurance.
  const pointer = editor.runsElsewhereHtml();
  assert.match(pointer, /your runs live in Endurance/);
  assert.match(pointer, /data-plan-runs/);
});

test("a gallery card: units on loads, no Train on a day already done, a shared purpose said once", () => {
  const editor = loadPlanEditor();
  const day = {
    day_number: 1,
    name: "Push",
    focus: "Chest",
    purpose: "laying down the block's foundation",
    items: [
      { kind: "strength", exercise: "Bench", sets: 3, rep_low: 8, rep_high: 12, target_weight: 125 },
      { kind: "strength", exercise: "Dip", sets: 3, rep_low: 8, rep_high: 10, target_weight: -30 },
    ],
  };
  const open = editor.progDayHtml(day, 0, { weekday: "Wed", status: "upcoming" });
  assert.match(open, /125 lb</);
  assert.match(open, /30 lb assist</);
  assert.match(open, /data-trainday="0"/);
  assert.match(open, /laying down the block/);
  const done = editor.progDayHtml(day, 0, { weekday: "Mon", status: "done" }, {
    sharedPurpose: "laying down the block's foundation",
  });
  assert.doesNotMatch(done, /data-trainday/, "a trained day offers no Train");
  assert.match(done, /data-editday="0"/);
  assert.doesNotMatch(done, /laying down the block/, "the shared purpose is said once, above the cards");
});
