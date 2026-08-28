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
    isCardioItem: (item) => item && item.kind === "cardio",
    cardioIntervalNote: (interval) => (interval && interval.note) || "",
    cardioArtPhrase: (item) => item.note || "run",
    cardioLabel: (item) => item.note || "Cardio",
    cardioDescription: (item) => item.description || "",
    cardioPrescription: (item) => item.prescription || "45 min · Z2",
    art: (kind, text) => `<svg data-kind="${kind}" data-text="${String(text)}"></svg>`,
    artImg: (kind, text, className) => `<span class="${className}" data-kind="${kind}">${escapeText(text)}</span>`,
    fmtDur: (seconds) => `${Math.round(Number(seconds) / 60)}m`,
    fmtWeight: (weight) => `${Number(weight)} lb`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-editor-client.js"), "utf8"), context);
  return context.CairnPlanEditor;
}

test("plan editor normalizes plan rows and exposes stable blank item defaults", () => {
  const editor = loadPlanEditor();

  const day = editor.dayModelFromPlan({
    day_number: 2,
    name: "Tempo",
    items: [
      { kind: "strength", exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5, interval: { note: "ignored" } },
      { kind: "cardio", note: "Easy run", interval: { note: "6x400m" }, target_zone: "Z2" },
    ],
  });

  assert.equal(day.focus, "");
  assert.equal(day.items[0].kind, "strength");
  assert.equal(day.items[0].interval_note, "ignored");
  assert.equal(day.items[1].kind, "cardio");
  assert.equal(day.items[1].interval_note, "6x400m");
  const strength = editor.blankStrength();
  assert.equal(strength.kind, "strength");
  assert.equal(strength.exercise, "");
  assert.equal(strength.sets, 3);
  assert.equal(strength.rep_low, 8);
  assert.equal(strength.rep_high, 10);
  assert.equal(strength.target_weight, null);
  assert.equal(strength.note, "");
  assert.equal(strength.warmup_sets, null);
  assert.equal(strength.target_distance_km, null);
  assert.equal(strength.target_duration_min, null);
  assert.equal(strength.target_zone, null);
  assert.equal(strength.interval_note, "");
  assert.equal(editor.blankCardio().kind, "cardio");
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
      { kind: "cardio", note: "Easy ride", description: "keep it nasal <easy>", prescription: "45 min · Z2" },
    ],
  }, 0);

  assert.match(html, /Upper &lt;push&gt;/);
  assert.match(html, /Chest &amp; back/);
  assert.match(html, /Bench &lt;press&gt;/);
  assert.match(html, /2 warmup · pause &lt;rep&gt;/);
  assert.match(html, /3 × 5/);
  assert.match(html, /185 lb/);
  assert.match(html, /Easy ride/);
  assert.match(html, /keep it nasal &lt;easy&gt;/);
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
      { kind: "cardio", note: "Long run", target_distance_km: 12.5, target_duration_min: 75, target_zone: "Z2", interval_note: "last 10m steady" },
    ],
  }, 2);

  assert.match(dayHtml, /class="pday" data-d="2"/);
  assert.match(dayHtml, /class="pday-name" value="Day &quot;A&quot;"/);
  assert.match(dayHtml, /class="pday-focus" value="Build &lt;base&gt;"/);
  assert.match(dayHtml, /data-upitem="2:0" disabled/);
  assert.match(dayHtml, /data-downitem="2:1" disabled/);
  assert.match(dayHtml, /data-pikind="2:0:strength"/);
  assert.match(dayHtml, /data-pikind="2:1:cardio"/);
  assert.match(dayHtml, /value="Deadlift &quot;heavy&quot;"/);
  assert.match(dayHtml, /value="smooth &lt;pull&gt;"/);
  assert.match(dayHtml, /class="pitem pitem-cardio" data-d="2" data-i="1" data-kind="cardio"/);
  assert.match(dayHtml, /value="12.5" placeholder="km"/);
  assert.match(dayHtml, /value="last 10m steady"/);
  assert.doesNotMatch(dayHtml, /<base>|<pull>|Deadlift "heavy"/);
});

// ---- the week's rest day, in the editor (v99) ----
// The editor saves the WHOLE week through one PUT, so the day's type has to survive
// the model round-trip or a rest day would be erased by editing any other day.
test("the editor carries a rest day through the model, the read view, and the edit view", () => {
  const editor = loadPlanEditor();
  const rest = editor.dayModelFromPlan({ day_number: 3, name: "Rest", focus: null, day_type: "rest", items: [] });
  assert.equal(rest.day_type, "rest");
  assert.deepEqual(rest.items, []);
  assert.equal(
    editor.dayModelFromPlan({ day_number: 1, name: "Push", focus: "push", items: [] }).day_type,
    "training",
    "a day that says nothing is an ordinary day"
  );

  const read = editor.progDayHtml(rest, 0);
  assert.match(read, /Day 3 · Rest/, "the read view names the seam");
  assert.match(read, /rest day/i);
  assert.doesNotMatch(read, /No exercises yet/, "emptiness is the prescription, not a gap to fill");

  const edit = editor.pdayHtml(rest, 0);
  assert.match(edit, /data-restday="0"/, "there is a way to unmark it");
  assert.match(edit, /This is a rest day/);
  assert.doesNotMatch(edit, /data-additem/, "a rest day offers no way to add work to it");

  const training = editor.pdayHtml(
    editor.dayModelFromPlan({ day_number: 1, name: "Push", focus: "push", items: [] }),
    0
  );
  assert.match(training, /Make this a rest day/);
  assert.match(training, /data-additem/);
});
