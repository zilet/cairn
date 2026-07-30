// The Today wearable card's personal-baseline band rows (loadRecoveryBands in
// src/client/today-side-loaders.ts).
//
// The behavior these pin is the episodic wearer's: the server sends a band whose
// newest reading is too old to speak for today, so it arrives with `position` and
// `current` null. The row must still DRAW — the personal range is durable — but
// without a dot, without a tone, and dated in calm words. A stale reading is never
// placed on the track as though it were current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Load the compiled side-loaders with just the globals this path touches. The
// band renderer itself is stubbed so the assertions read the OPTIONS the loader
// chose (baselineBandHtml's own output is covered in clientUiReads.test.js).
// `relAge` defaults to a marker stub so a test can prove WHICH date was handed to
// it; pass the real-shaped wording when the assertion is about what a person reads.
function loadSideLoaders(relAge = (iso) => `rel:${iso}`) {
  const calls = [];
  const context = {
    Math,
    Number,
    Object,
    String,
    Array,
    Promise,
    Date,
    escHtml: escapeHtml,
    escAttr: escapeHtml,
    relAge,
    CairnTodayLately: { garminSessionCard: () => "" },
    CairnTodayContext: {},
    CairnUiReads: {
      baselineBandHtml(options) {
        calls.push(options);
        return `<div class="read-band">${escapeHtml(options.label)}|${escapeHtml(options.phrase)}</div>`;
      },
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-side-loaders.js"), "utf8"), context);
  return { loaders: context.CairnTodaySideLoaders, calls };
}

// A minimal stand-in for the #wearBands slot the loader writes into.
function slotDeps(payload) {
  const slot = { innerHTML: "", isConnected: true };
  const deps = {
    root: { querySelector: (sel) => (sel === "#wearBands" ? slot : null) },
    state: { tab: "today", logDate: "2026-07-30" },
    api: async () => payload,
    activateTab() {},
    runCountUps() {},
    escapeHtml,
    localISO: () => "2026-07-30",
    stagger: () => "",
  };
  return { slot, deps };
}

const dottedDim = {
  key: "hrv",
  label: "HRV",
  phrase: "above your usual",
  hot: false,
  position: 0.8,
  range_start: 0.3,
  range_end: 0.6,
  current: 80,
  p25: 50,
  p75: 60,
  n: 28,
  readings: 28,
  span_days: 27,
  last_reading_date: "2026-07-30",
};

// An episodic wearer's dot: today's reading is current, but the band behind it
// is sample-anchored (baseline-bands.ts) and spans months of intermittent wear —
// span_days well past the disclosure threshold.
const dottedWideSpanDim = {
  key: "hrv",
  label: "HRV",
  phrase: "above your usual",
  hot: false,
  position: 0.8,
  range_start: 0.3,
  range_end: 0.6,
  current: 80,
  p25: 50,
  p75: 60,
  n: 13,
  readings: 13,
  span_days: 124,
  last_reading_date: "2026-07-30",
};

const dotlessDim = {
  key: "hrv",
  label: "HRV",
  phrase: "your usual range",
  hot: false,
  position: null,
  range_start: 0.3,
  range_end: 0.6,
  current: null,
  p25: 50,
  p75: 60,
  n: 12,
  readings: 12,
  span_days: 120,
  last_reading_date: "2026-07-09",
};

test("a dotless band still draws, dated in calm words instead of a position", async () => {
  const { loaders, calls } = loadSideLoaders();
  const { slot, deps } = slotDeps({ dimensions: [dotlessDim] });
  await loaders.loadRecoveryBands(deps);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].position, null, "no dot is placed from a reading that cannot speak for today");
  assert.equal(calls[0].rangeStart, 0.3, "the personal range is still drawn");
  assert.equal(calls[0].rangeEnd, 0.6);
  assert.equal(calls[0].phrase, "your usual range · last reading rel:2026-07-09");
  assert.equal(calls[0].hot, false);
  assert.match(slot.innerHTML, /wear-bands/);
});

test("the dotless annotation is relative, calm, and never a nudge or a number", async () => {
  // The real relAge wording, so the assertion is about the sentence a person reads.
  const { loaders, calls } = loadSideLoaders(() => "3 weeks ago");
  const { deps } = slotDeps({ dimensions: [dotlessDim] });
  await loaders.loadRecoveryBands(deps);
  const phrase = calls[0].phrase;
  assert.equal(phrase, "your usual range · last reading 3 weeks ago");
  assert.doesNotMatch(phrase, /\d{4}-\d{2}-\d{2}/, "the raw date never reaches the row");
  assert.doesNotMatch(phrase, /score|wear|put on|should|need to|only \d/i, "information, not a nudge");
});

test("a fresh dot renders exactly as before — position, tone and phrase untouched", async () => {
  const { loaders, calls } = loadSideLoaders();
  const { deps } = slotDeps({ dimensions: [dottedDim] });
  await loaders.loadRecoveryBands(deps);
  assert.equal(calls[0].position, 0.8);
  assert.equal(calls[0].phrase, "above your usual", "no provenance note when the dot can speak");
  assert.equal(calls[0].hot, false);
});

// MEDIUM-4: a dot present is not the same claim as "the range is fresh". An
// episodic wearer can have today's current reading sitting on top of a
// sample-anchored range built from readings spread over months — disclose that,
// even though there's a dot to place.
test("a dot sitting on a months-wide sample still discloses its span", async () => {
  const { loaders, calls } = loadSideLoaders();
  const { deps } = slotDeps({ dimensions: [dottedWideSpanDim] });
  await loaders.loadRecoveryBands(deps);
  assert.equal(calls[0].position, 0.8, "the dot itself is untouched — it can still speak for today");
  assert.equal(
    calls[0].phrase,
    "above your usual · range from readings over the last ~4 months",
    "the phrase discloses how wide the supporting sample is"
  );
  assert.doesNotMatch(calls[0].phrase, /\bbaseline\b/i, "no engineering vocabulary reaches the athlete");
});

test("the span disclosure is a threshold: at the line it stays silent, past it it speaks", async () => {
  const atLine = { ...dottedDim, span_days: 45 };
  const pastLine = { ...dottedDim, span_days: 46 };
  const { loaders, calls } = loadSideLoaders();
  const { deps } = slotDeps({ dimensions: [atLine, pastLine] });
  await loaders.loadRecoveryBands(deps);
  assert.equal(calls[0].phrase, "above your usual", "45 days is still an ordinary recent sample");
  assert.equal(
    calls[1].phrase,
    "above your usual · range from readings over the last ~7 weeks",
    "46 days is past the line"
  );
});

test("a hot dimension keeps its tone only while it has a dot to justify it", async () => {
  const { loaders, calls } = loadSideLoaders();
  const { deps } = slotDeps({
    dimensions: [
      { ...dottedDim, key: "rhr", label: "Resting HR", phrase: "above your usual", hot: true },
      { ...dotlessDim, key: "rhr", label: "Resting HR", hot: true },
    ],
  });
  await loaders.loadRecoveryBands(deps);
  assert.equal(calls[0].hot, true, "an elevated resting HR read from a current reading is a lever");
  assert.equal(calls[1].hot, false, "the same dimension without a dot cannot be one");
});

test("a dotless band with no last_reading_date degrades to the bare phrase", async () => {
  const { loaders, calls } = loadSideLoaders();
  const { deps } = slotDeps({ dimensions: [{ ...dotlessDim, last_reading_date: null }] });
  await loaders.loadRecoveryBands(deps);
  assert.equal(calls[0].phrase, "your usual range");
});

test("no dimensions clears the slot rather than leaving a stale strip", async () => {
  const { loaders } = loadSideLoaders();
  const { slot, deps } = slotDeps({ dimensions: [] });
  slot.innerHTML = "<div>old</div>";
  await loaders.loadRecoveryBands(deps);
  assert.equal(slot.innerHTML, "");
});
