// The Progress capability lead's words (src/client/progress-capability-client.ts): plain
// words for every state, a muscle named as a label, and context that never contradicts
// the verdict it sits beside.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadClient() {
  const context = { Object, String, Number, Array, stagger: (i) => `--i:${i}` };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-capability-client.js"), "utf8"), context);
  return context.CairnProgressCapability;
}

const unit = (over) => ({
  key: "triceps:pushdown",
  label: "Pushdown",
  kind: "region",
  compound: false,
  in_plan: true,
  verdict: "holding",
  qualifiers: [],
  hard_sets_trend: null,
  line: "Your pushdown strength is holding steady.",
  contributors: [],
  ...over,
});

test("verdict words are plain: too early to tell, never a raw state name", () => {
  const cap = loadClient();
  assert.equal(cap.capVerdictWord("not_enough"), "too early to tell");
  assert.equal(cap.capVerdictWord("slipping"), "easing");
  assert.equal(cap.capVerdictWord("progressing"), "climbing");
  const html = cap.capabilityHtml({
    available: true,
    date: "2026-11-24",
    overall: null,
    units: [
      unit({ verdict: "not_enough", line: "Not enough comparable sessions yet to read your pushdown strength." }),
    ],
    muscles: [],
  });
  assert.match(html, /too early to tell/);
  assert.doesNotMatch(html, /not_enough|not enough yet/);
});

test("the cut is said as holding only beside a unit that holds", () => {
  const cap = loadClient();
  assert.equal(cap.capQualifierWord("cut", "holding"), "holding through the cut");
  assert.equal(cap.capQualifierWord("cut", "slipping"), "during the cut");
  const html = cap.capabilityHtml({
    available: true,
    date: "2026-11-24",
    overall: null,
    units: [
      unit({
        verdict: "slipping",
        qualifiers: ["cut"],
        line: "Your pushdown strength has eased a little during the cut.",
      }),
    ],
    muscles: [],
  });
  assert.doesNotMatch(html, /holding through the cut/);
  assert.match(html, /during the cut/);
});

test("muscles read as labels, and a lift the read cannot judge yet says so", () => {
  const cap = loadClient();
  const html = cap.capabilityHtml({
    available: true,
    date: "2026-11-24",
    overall: null,
    units: [
      unit({
        contributors: [
          {
            exercise: "Rope Pushdown",
            exercise_id: 1,
            in_plan: true,
            last_trained: null,
            exposures: 4,
            direction: "holding",
            transfer: "own",
          },
          {
            exercise: "Bar Pushdown",
            exercise_id: 2,
            in_plan: false,
            last_trained: null,
            exposures: 1,
            direction: "not_enough",
            transfer: "none",
          },
        ],
      }),
    ],
    muscles: [
      {
        group: "rear delts",
        verdict: "holding",
        weekly_hard_sets: 6,
        band: "productive",
        volume_trend: null,
        units: [],
        line: "Your rear delts are holding steady.",
      },
    ],
  });
  assert.match(html, /<span class="pcap-unit-name">Rear delts<\/span>/);
  const bar = html.split("Bar Pushdown")[1];
  assert.match(bar, /not on the plan now · too early to tell/);
  assert.doesNotMatch(html.split("Bar Pushdown")[0].split("Rope Pushdown")[1], /too early to tell/);
});
