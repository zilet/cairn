import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthStanding() {
  const context = {
    console,
    Date,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    String,
    JSON,
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  for (const file of [
    "public/js/date-utils.js",
    "public/js/html-utils.js",
    "public/js/ui-components.js",
    "public/js/ui-reads.js",
    "public/js/health-evidence-client.js",
    "public/js/health-marker-order-client.js",
    "public/js/health-client.js",
    "public/js/health-standing-primitives-client.js",
    "public/js/health-standing-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context.CairnHealthStanding;
}

function standingFixture() {
  return {
    subject: { age: 44, sex: "male" },
    hero: {
      headline: "Ahead, but watch ApoB <risk>",
      calendar_age: 44,
      biological_age: 39,
      biological_age_source: "lab",
      biological_age_delta: -5,
      direction: "younger",
    },
    confidence: "medium <signal>",
    momentum: {
      has_momentum: true,
      chips: [{ dir: "good", text: "VO2 up <fast>" }],
    },
    lead_lever: {
      group: "Lipids <lead>",
      why: "ApoB is the cleanest lever <now>",
      move: "More soluble fiber <daily>",
    },
    comparisons: [
      {
        key: "vo2",
        label: "VO2 <max>",
        value: 52.4,
        unit: "ml/kg/min <unit>",
        percentile: 82,
        reference_percentile: 70,
        reference_age_band: "30s",
        actual_age_band: "40s",
        equivalent_age: 35,
        verb: "ahead of",
        source: "Garmin <watch>",
        reading: { source: "daily metric <raw>", date: "2026-06-25" },
        next: { direction: "up", delta: 3, label: "next rung <goal>", equivalent_age: 32 },
      },
    ],
    body_comp: {
      estimated: { value: "16.5<script>" },
      measured: { value: 18.9, date: "2026-06-01" },
      fat_mass: { delta_lbs: -7.4 },
      regional: { notes: [{ tone: "watch", text: "Trunk fat <watch>" }] },
      note: "DEXA anchored <note>",
    },
    blood_pressure: {
      latest: true,
      category: "optimal",
      tone: "strong",
      read: "Home readings look calm <ok>",
      trajectory: {
        dir: "improving",
        from: { systolic: 144, diastolic: 91 },
        to: { systolic: 113, diastolic: 72 },
      },
      recent: [
        { systolic: 113, diastolic: 72, pulse: 55, measured_at: "2026-06-30 06:00:00", position: "seated <home>", source: "clinic <import>" },
      ],
      note: "Resting target <note>",
    },
    dimensions: [
      { id: "bp", label: "Hidden BP" },
      { id: "body", label: "Hidden body" },
      { id: "sleep", tone: "steady", label: "Sleep <recovery>", headline: "Enough signal", body: "Consistent <nights>", measures: [{ label: "HRV <avg>", value: 62.4, unit: "ms <unit>" }] },
    ],
    balance: "Keep the read calm <constitution>",
  };
}

test("health standing helpers clamp age bands, percentiles, and datetime values", () => {
  const standing = loadHealthStanding();

  assert.equal(standing.hstandDecade(44), 40);
  assert.equal(standing.hstandDecade(12), 20);
  assert.equal(standing.hstandDecade(91), 70);
  assert.equal(standing.hstandPct(120), 100);
  assert.equal(standing.hstandPct(-12), 0);
  assert.equal(standing.hstandPct("nope"), null);
  assert.equal(standing.hstandBandTone(90), "strong");
  assert.equal(standing.hstandBandTone(55), "steady");
  assert.equal(standing.hstandBandTone(20), "watch");
  // Qualitative level word derived from the same 75 / 50 thresholds (the
  // reading-grammar replacement for the retired percentile bar).
  assert.equal(standing.hstandLevelWord(90), "strong");
  assert.equal(standing.hstandLevelWord(55), "solid");
  assert.equal(standing.hstandLevelWord(20), "building");
  assert.equal(standing.hstandLevelWord("nope"), "");
  assert.equal(
    standing.localDateTimeInputValue({ getTime: () => Date.UTC(2026, 5, 30, 6, 7), getTimezoneOffset: () => 0 }),
    "2026-06-30T06:07",
  );
});

test("health standing renderer preserves calm standing sections and escapes data", () => {
  const standing = loadHealthStanding();
  const html = standing.renderHealthStandingHtml(standingFixture(), { referenceAge: 30 });

  assert.match(html, /Health standing/);
  assert.match(html, /biological age/);
  assert.match(html, /class="hstand-refbtn active" data-refage="30"/);
  assert.match(html, /If you stood among men in their 30s/);
  assert.match(html, /VO2 &lt;max&gt;/);
  assert.match(html, /ml\/kg\/min &lt;unit&gt;/);
  assert.match(html, /moves like age 35/);
  assert.match(html, /where to head/);
  // Population-relative GEOMETRY is banned (VISION.md Amendment 2): the percentile
  // fill bar/track is gone, replaced by the qualitative level chip; the number
  // survives ONLY as prose ("ahead of 82% / 70% …").
  assert.doesNotMatch(html, /hstand-fill|hstand-track|style="width:/);
  assert.match(html, /class="level-chip"/);
  assert.match(html, /ahead of <b>82%<\/b> of men your age/);
  assert.match(html, /ahead of <b>70%<\/b>/);
  assert.match(html, /hstand-bc-win/);
  assert.match(html, /≈ 7 lb of fat off since the scan/);
  assert.match(html, /113\/72/);
  assert.match(html, /144\/91/);
  assert.match(html, /Sleep &lt;recovery&gt;/);
  assert.match(html, /Living well/);
  assert.doesNotMatch(html, /Hidden BP|Hidden body/);
  assert.doesNotMatch(html, /<risk>|<signal>|<fast>|<lead>|<now>|<daily>|<max>|<unit>|<watch>|<note>|<ok>|<home>|<import>|<recovery>|<nights>|<constitution>|<script>/);
});

test("health standing renderer keeps quiet empty states", () => {
  const standing = loadHealthStanding();

  assert.match(standing.hstandBodyCompHtml(null), /A DEXA or a compatible scale anchors this/);
  assert.match(standing.hstandBpRows([]), /No readings yet/);
  const html = standing.renderHealthStandingHtml({ subject: { age: null }, comparisons: [] }, {});
  assert.match(html, /Your standing read will sharpen as data lands/);
  assert.match(html, /VO2max or a DEXA\/body-fat anchor unlocks real age-band percentiles/);
});
