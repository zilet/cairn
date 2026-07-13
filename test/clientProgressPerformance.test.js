import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPerformanceClient() {
  const context = { Object, String };
  context.window = context;
  context._progFocusCard = "";
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-reads.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-performance-client.js"), "utf8"), context);
  return context;
}

function samplePerformance() {
  return {
    hero: { headline: "Capacity <now>", sub: "Strength and engine <read>" },
    momentum: { chips: [{ dir: "good", text: "Bench up <5>" }, { dir: "flat", text: "Run steady" }] },
    sex: "male",
    capacities: [
      {
        tone: "strong",
        percentile: 120,
        label: "Squat <lower>",
        level: "Advanced <level>",
        exercise: "Back squat <bar>",
        est_1rm: 315,
        to_next: { lb: "20 <bad>", level: "Elite <next>" },
      },
    ],
    endurance: { headline: "VO2 <good>", vo2max: 48, tone: "watch" },
    lever: { headline: "Pulling balance <focus>", why: "Rows lag <why>", target: "2 pull days <target>" },
    imbalances: [{ severity: "watch", title: "Push/pull <gap>", why: "Press leads pull <reason>" }],
    tests_due: [{ exercise: "Deadlift <test>", why: "Stale heavy set <old>" }],
    variety: { note: "Rotate one angle <soon>", suggestions: ["Incline DB <press>", "Cable row"] },
    balance_note: "Sleep is holding <line>",
  };
}

test("progress performance renders standing safely", () => {
  const context = loadPerformanceClient();
  const perf = context.CairnProgressPerformance;
  const html = perf.performanceHtml(samplePerformance());

  assert.match(html, /Capacity &lt;now&gt;/);
  assert.match(html, /Strength and engine &lt;read&gt;/);
  assert.match(html, /pperf-chip-good/);
  assert.match(html, /pperf-chip-neutral/);
  assert.match(html, /Squat &lt;lower&gt;/);
  // The strength-standards level word now rides the shared level chip (the
  // reading-grammar replacement for the retired percentile fill bar).
  assert.match(html, /class="level-chip"/);
  assert.match(html, /Advanced &lt;level&gt;/);
  assert.match(html, /Back squat &lt;bar&gt;/);
  // Population-relative GEOMETRY is banned (VISION.md Amendment 2) — no width/left
  // percentile bar or mark survives; the number lives on only as prose below.
  assert.doesNotMatch(html, /style="width:|style="left:|pcap-bar|pcap-fill|pcap-mark/);
  assert.match(html, /stronger than 99% of men your age/);
  assert.match(html, /\+20 &lt;bad&gt; lb → Elite &lt;next&gt;/);
  assert.match(html, /VO2 &lt;good&gt;/);
  assert.match(html, /Pulling balance &lt;focus&gt;/);
  assert.match(html, /Push\/pull &lt;gap&gt;/);
  assert.match(html, /Deadlift &lt;test&gt;/);
  assert.match(html, /Incline DB &lt;press&gt;/);
  assert.match(html, /Sleep is holding &lt;line&gt;/);
  assert.doesNotMatch(html, /<now>|<read>|<lower>|<level>|<bar>|<bad>|<next>|<good>|<focus>|<gap>|<test>|<press>|<line>/);
});

test("progress performance exposes clamp and lever suppression", () => {
  const context = loadPerformanceClient();
  const perf = context.CairnProgressPerformance;

  assert.equal(perf.pctClamp(-12), 2);
  assert.equal(perf.pctClamp(101), 99);
  assert.equal(perf.pctClamp("not a number"), 0);

  const html = perf.performanceHtml(samplePerformance(), { suppressLever: true });
  assert.doesNotMatch(html, /pperf-lever-head/);
  assert.doesNotMatch(html, /Pulling balance/);
});

test("progress performance loader hydrates the target slot", async () => {
  const context = loadPerformanceClient();
  const slot = { innerHTML: "" };
  context.view = {
    querySelector(selector) {
      return selector === "#progPerfSlot" ? slot : null;
    },
  };
  context.api = async () => samplePerformance();

  await context.CairnProgressPerformance.loadPerformance();

  assert.match(slot.innerHTML, /Capacity &lt;now&gt;/);
  assert.match(slot.innerHTML, /Pulling balance &lt;focus&gt;/);
});
