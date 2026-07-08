import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthRisk() {
  const context = { console, Math, Number, Object, String, JSON };
  context.window = context;
  for (const file of ["public/js/html-utils.js", "public/js/health-risk-client.js"]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context.CairnHealthRisk;
}

function computedFixture(overrides = {}) {
  return {
    model_status: {
      prevent: "computed",
      ascvd_pce: "not_computed",
      reason:
        "AHA PREVENT (2023) base-model equations, computed from vendored coefficients using your captured status for every input.",
      next: "Nothing further needed for these inputs.",
    },
    inputs: {
      age: 45,
      sex: "male",
      bmi: 24.1,
      body_fat_pct: 18,
      body_fat_source: "dexa",
      diabetes_by_a1c: false,
      markers: {},
      missing_inputs: [],
    },
    prevent: {
      provisional: false,
      assumptions: [],
      confidence: "high",
      estimates: {
        total_cvd: { ten_year: 0.072, thirty_year: 0.245 },
        ascvd: { ten_year: 0.041, thirty_year: 0.15 },
        heart_failure: { ten_year: 0.02, thirty_year: null },
      },
      vascular_age: 39,
      projection: {
        current: { ten_year: 0.072, thirty_year: 0.245, vascular_age: 39 },
        targets_met: { ten_year: 0.051, thirty_year: 0.19, vascular_age: 36 },
        levers_applied: [
          {
            key: "lipids",
            label: "Lipid-lowering to target",
            from: 150,
            to: 110,
            unit: "mg/dL non-HDL",
            detail: "Bringing ApoB toward ~80 mg/dL lowers non-HDL cholesterol with it, from 150 to 110 mg/dL.",
          },
        ],
      },
      horizons_note: "30-year estimates are validated only for ages 30–59.",
      frame: "A validated estimate from the AHA PREVENT (2023) equations.",
    },
    enhancers: [
      {
        key: "apob",
        label: "ApoB above optimal <bad>",
        finding: "ApoB 95 mg/dL (2026-05-01) <finding>",
        why: "ApoB is the atherogenic particle count <why>",
        lever: "Bring ApoB toward ~80 mg/dL <lever>",
      },
    ],
    projections: [
      {
        key: "apob",
        label: "ApoB particle reduction",
        current: 95,
        target: 80,
        unit: "mg/dL",
        expected_direction: "lower",
        why: "...",
      },
    ],
    frame: "Informational, not medical advice <script>. The prevent block is the clinical risk read.",
    ...overrides,
  };
}

test("cardiovascular risk renderer pairs a favorable vascular age with the enhancer overlay (honesty guard)", () => {
  const risk = loadHealthRisk();
  const html = risk.renderCardiovascularRiskHtml(computedFixture());

  // vascular age headline
  assert.match(html, /hrisk-vage-num">39</);
  assert.match(html, /vascular age/);
  assert.match(html, /vs\. 45 calendar/);
  // the honesty guard: vascular_age (39) < age (45) AND enhancers non-empty must
  // surface the explicit tension sentence, never a standalone "younger!" headline
  assert.match(html, /Your base numbers read favorable — but the factors below push your real risk higher/);
  assert.match(html, /hrisk-enh-lede-tension/);
  // the enhancer overlay itself, in the SAME card
  assert.match(html, /ApoB above optimal &lt;bad&gt;/);
  assert.match(html, /ApoB 95 mg\/dL \(2026-05-01\) &lt;finding&gt;/);
  assert.match(html, /atherogenic particle count &lt;why&gt;/);
  assert.match(html, /Bring ApoB toward ~80 mg\/dL &lt;lever&gt;/);
  // clinical risk percentages, rendered as %, 1 decimal
  assert.match(html, /7\.2%/);
  assert.match(html, /24\.5%/);
  assert.match(html, /4\.1%/);
  assert.match(html, /2\.0%/);
  // the ribbon is a REAL current-vs-targets-met recompute (from prevent.projection),
  // every dimension bound to a computed number — no invented "optimized lift".
  assert.match(html, /hrisk-viz/);
  assert.match(html, /Risk trajectory/);
  assert.match(html, /Current vs\. if you hit your targets/);
  // axis carries the real current 10-yr / 30-yr reads
  assert.match(html, /10 yr 7\.2%/);
  assert.match(html, /30 yr 24\.5%/);
  // legend carries plain current vs targets-met labels
  assert.match(html, /Current path/);
  assert.match(html, /If you hit your targets/);
  // the note enumerates ONLY the dimensions that actually move (real recompute):
  // 30-yr 24.5%→19.0%, 10-yr 7.2%→5.1%, vascular age 39→36
  assert.match(html, /30-year risk from 24\.5% to 19\.0%/);
  assert.match(html, /10-year risk from 7\.2% to 5\.1%/);
  assert.match(html, /vascular age from 39 to 36/);
  assert.match(html, /recomputed with the PREVENT equations, not a separate score/);
  // the heart-failure 30-yr horizon is null → shows the horizons_note, not a number
  assert.match(html, /30-year estimates are validated only for ages 30–59/);
  // levers strip (from data.projections — the current→target lever chips)
  assert.match(html, /ApoB particle reduction/);
  assert.match(html, /95mg\/dL → 80mg\/dL/);
  // top-level frame footer, surfaced verbatim + escaped
  assert.match(html, /Informational, not medical advice &lt;script&gt;/);
  // constitution: no 0-100 score, no letter grade, anywhere
  assert.doesNotMatch(html, /\d+\s*\/\s*100/);
  assert.doesNotMatch(html, /\bgrade\b/i);
  assert.doesNotMatch(html, /<script>/);
});

test("cardiovascular risk ribbon never claims 'from X% to X%' when the 10-yr rounds identical", () => {
  const risk = loadHealthRisk();
  // A young, low-risk profile: the 10-yr % rounds identical (0.7% → 0.7%) but the
  // 30-yr and vascular age genuinely improve. The copy must speak to the dims that
  // actually move, never print a same-to-same delta.
  const html = risk.renderCardiovascularRiskHtml(
    computedFixture({
      prevent: {
        ...computedFixture().prevent,
        vascular_age: 34,
        estimates: {
          total_cvd: { ten_year: 0.007, thirty_year: 0.057 },
          ascvd: { ten_year: 0.004, thirty_year: 0.03 },
          heart_failure: { ten_year: 0.002, thirty_year: 0.01 },
        },
        projection: {
          current: { ten_year: 0.007, thirty_year: 0.057, vascular_age: 34 },
          targets_met: { ten_year: 0.0065, thirty_year: 0.0536, vascular_age: 33 },
          levers_applied: [
            {
              key: "lipids",
              label: "Lipid-lowering to target",
              from: 127,
              to: 110.4,
              unit: "mg/dL non-HDL",
              detail: "…",
            },
          ],
        },
      },
    })
  );
  // 30-yr 5.7% → 5.4% and vascular age 34 → 33 are surfaced; the identical 10-yr is not.
  assert.match(html, /30-year risk from 5\.7% to 5\.4%/);
  assert.match(html, /vascular age from 34 to 33/);
  assert.doesNotMatch(html, /from 0\.7% to 0\.7%/);
  assert.doesNotMatch(html, /10-year risk from 0\.7% to 0\.7%/);
  // still renders the optimized path (there IS a real, visible gap)
  assert.match(html, /hrisk-viz-optimized/);
});

test("cardiovascular risk ribbon draws only the current path when no lever is applied (no fabricated gap)", () => {
  const risk = loadHealthRisk();
  const html = risk.renderCardiovascularRiskHtml(
    computedFixture({
      enhancers: [],
      prevent: {
        ...computedFixture().prevent,
        projection: {
          current: { ten_year: 0.072, thirty_year: 0.245, vascular_age: 39 },
          targets_met: { ten_year: 0.072, thirty_year: 0.245, vascular_age: 39 },
          levers_applied: [],
        },
      },
    })
  );
  assert.match(html, /hrisk-viz/);
  assert.match(html, /Your current PREVENT path/);
  assert.doesNotMatch(html, /hrisk-viz-optimized/);
  assert.doesNotMatch(html, /If you hit your targets/);
  assert.match(html, /No modifiable lever moves this read/);
});

test("cardiovascular risk renderer never shows vascular age alone even with no tension", () => {
  const risk = loadHealthRisk();
  const html = risk.renderCardiovascularRiskHtml(
    computedFixture({
      enhancers: [],
      prevent: { ...computedFixture().prevent, vascular_age: 50 }, // older than calendar age, no tension case
    })
  );

  assert.match(html, /hrisk-vage-num">50</);
  assert.doesNotMatch(html, /Your base numbers read favorable/);
  // still renders the enhancer section (empty-state note), never a bare headline
  assert.match(html, /No additional risk enhancers stood out from your labs/);
});

test("cardiovascular risk renderer surfaces a provisional read with assumptions and a Profile nudge", () => {
  const risk = loadHealthRisk();
  const fixture = computedFixture();
  fixture.model_status.prevent = "computed_provisional";
  fixture.prevent.provisional = true;
  fixture.prevent.confidence = "provisional";
  fixture.prevent.assumptions = [
    { input: "smoking", assumed: "non-smoker", reason: "Smoking status isn't captured yet <reason>" },
  ];
  const html = risk.renderCardiovascularRiskHtml(fixture);

  assert.match(html, /Provisional read/);
  assert.match(html, /hrisk-viz-provisional/);
  assert.match(html, /smoking/);
  assert.match(html, /non-smoker/);
  assert.match(html, /Smoking status isn't captured yet &lt;reason&gt;/);
  assert.match(html, /data-risk-sharpen/);
  assert.match(html, /sharpen this/);
});

test("cardiovascular risk renderer keeps the insufficient-inputs state calm, never an error tone", () => {
  const risk = loadHealthRisk();
  const html = risk.renderCardiovascularRiskHtml({
    model_status: {
      prevent: "insufficient_inputs",
      ascvd_pce: "not_computed",
      reason: "Missing inputs",
      next: "Add the missing labs",
    },
    inputs: {
      age: null,
      sex: null,
      bmi: null,
      body_fat_pct: null,
      body_fat_source: null,
      diabetes_by_a1c: null,
      markers: {},
      missing_inputs: ["smoking status <x>", "eGFR"],
    },
    prevent: null,
    enhancers: [],
    projections: [],
    frame: "Informational, not medical advice.",
  });

  assert.match(html, /Add these to see your heart-age read/);
  assert.match(html, /smoking status &lt;x&gt;/);
  assert.match(html, /eGFR/);
  assert.doesNotMatch(html, /hrisk-viz/);
  assert.doesNotMatch(html, /error/i);
  assert.doesNotMatch(html, /couldn't load/i);
});

test("cardiovascular risk renderer degrades to a calm empty state on missing data", () => {
  const risk = loadHealthRisk();
  assert.match(risk.renderCardiovascularRiskHtml(null), /Couldn't load your cardiovascular risk read right now/);
  assert.match(risk.renderCardiovascularRiskHtml(undefined), /Couldn't load your cardiovascular risk read right now/);
});
