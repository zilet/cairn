import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUDGET_FLOOR,
  BUDGET_MARGIN,
  budgetFromMeasurements,
  budgetedOutputs,
  ceilingFor,
  DEFAULT_EAGER_BUDGET,
  eagerTotals,
  evaluateBudget,
  evaluateEagerBudget,
  eagerScriptsFromIndex,
  formatDelta,
  unbudgetedEagerScripts,
} from "../scripts/check-bundle-budget.mjs";
import { BUNDLES } from "../scripts/build-client.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const measured = [
  { output: "public/js/bundle-a.js", lazy: null, raw: 100_000, brotli: 20_000 },
  { output: "public/js/bundle-b.js", lazy: "b", raw: 50_000, brotli: 9_000 },
];

test("a budget sits max(2 KB, 5%) above the measured size, rounded up to a whole KiB", () => {
  assert.equal(BUDGET_FLOOR, 2048);
  // Big: the 5% wins.
  assert.equal(ceilingFor(100_000), Math.ceil((100_000 + 100_000 * BUDGET_MARGIN) / 1024) * 1024);
  assert.ok(ceilingFor(100_000) >= 100_000 * 1.05);
  assert.ok(ceilingFor(100_000) <= 100_000 * 1.05 + 1024);
  // Small: the 2 KB floor wins, so a few hundred bytes of growth never trips the gate.
  assert.ok(ceilingFor(5_000) >= 5_000 + 2048);
  assert.ok(ceilingFor(5_000) <= 5_000 + 2048 + 1024);
  assert.equal(ceilingFor(1024, 0, 0), 1024);
  const budget = budgetFromMeasurements(measured);
  assert.equal(budget.margin, BUDGET_MARGIN);
  assert.match(budget.note, /max\(2 KB, 5%\)/, "the rule is written in the file");
  // The eager totals are measured too: a is the only eager script here.
  assert.equal(budget.eager.js.brotli, ceilingFor(20_000));
  assert.deepEqual(budget.bundles["public/js/bundle-a.js"].measured, { raw: 100_000, brotli: 20_000 });
  assert.equal(budget.bundles["public/js/bundle-b.js"].lazy, "b");
  assert.equal(budget.bundles["public/js/bundle-a.js"].lazy, undefined);
});

test("bundles within budget pass; the budget just set always passes", () => {
  const { failures, rows } = evaluateBudget(measured, budgetFromMeasurements(measured));
  assert.deepEqual(failures, []);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.over.length === 0));
});

test("growing past either ceiling fails and names the delta", () => {
  const budget = budgetFromMeasurements(measured);
  const limit = budget.bundles["public/js/bundle-a.js"].budget.brotli;
  const grown = [{ ...measured[0], brotli: limit + 2048 }, measured[1]];
  const { failures, rows } = evaluateBudget(grown, budget);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /bundle-a\.js brotli .* is \+2\.0 KB over its .* budget/);
  assert.match(failures[0], /since the budget was set/);
  assert.deepEqual(rows[0].over, ["brotli"]);

  const rawGrown = [measured[0], { ...measured[1], raw: 90_000 }];
  const raw = evaluateBudget(rawGrown, budget);
  assert.equal(raw.failures.length, 1);
  assert.match(raw.failures[0], /bundle-b\.js raw/);
});

test("a bundle with no budget, or a budget for a bundle that is gone, fails", () => {
  const budget = budgetFromMeasurements([measured[0]]);
  const added = evaluateBudget(measured, budget);
  assert.equal(added.failures.length, 1);
  assert.match(added.failures[0], /bundle-b\.js has no budget .*--update/);

  const stale = evaluateBudget([measured[0]], budgetFromMeasurements(measured));
  assert.equal(stale.failures.length, 1);
  assert.match(stale.failures[0], /bundle-b\.js has a budget but is no longer a bundle/);
});

test("deltas read signed", () => {
  assert.equal(formatDelta(0), "±0");
  assert.equal(formatDelta(2048), "+2.0 KB");
  assert.equal(formatDelta(-512), "-512 B");
});

test("the checked-in budget covers exactly the BUNDLES manifest plus the stylesheet and the lazy sheets, and runs in verify", async () => {
  const { BUNDLES } = await import("../scripts/build-client.mjs");
  const budget = JSON.parse(read("scripts/bundle-budget.json"));
  const covered = budgetedOutputs(BUNDLES);
  assert.ok(covered.some((asset) => asset.output === "public/styles.css"), "the render-blocking CSS is budgeted");
  assert.deepEqual(Object.keys(budget.bundles).sort(), covered.map((bundle) => bundle.output).sort());
  for (const bundle of covered) {
    const entry = budget.bundles[bundle.output];
    assert.equal(entry.lazy ?? null, bundle.lazy ?? null, `${bundle.output} lazy flag matches the manifest`);
    for (const kind of ["raw", "brotli"]) {
      assert.ok(
        entry.budget[kind] >= entry.measured[kind],
        `${bundle.output} ${kind} budget is at or above its measured size`
      );
    }
  }
  assert.match(read("scripts/run-verify.mjs"), /node",\s*"scripts\/check-bundle-budget\.mjs"/);
});

test("the eager totals sum what the first open downloads, and fail past their fixed ceilings", () => {
  const files = [
    { output: "public/js/bundle-a.js", lazy: null, raw: 100_000, brotli: 150_000 },
    { output: "public/js/bundle-b.js", lazy: "b", raw: 50_000, brotli: 90_000 },
    { output: "public/js/bundle-c.js", lazy: null, raw: 10_000, brotli: 40_000 },
    { output: "public/styles.css", lazy: null, raw: 400_000, brotli: 60_000 },
  ];
  const totals = eagerTotals(files);
  assert.equal(totals.js.brotli, 190_000, "a lazy bundle is not part of the first open");
  assert.equal(totals.styles.brotli, 60_000);

  const budget = budgetFromMeasurements(files, BUDGET_MARGIN, { js: { brotli: 200 * 1024 }, styles: { brotli: 70 * 1024 } });
  assert.deepEqual(budget.eager, { js: { brotli: 200 * 1024 }, styles: { brotli: 70 * 1024 } });
  assert.deepEqual(evaluateEagerBudget(files, budget).failures, []);

  const grown = [{ ...files[0], brotli: 170_000 }, ...files.slice(1)];
  const over = evaluateEagerBudget(grown, budget).failures;
  assert.equal(over.length, 1);
  assert.match(over[0], /eager js total .* over its 200\.0 KB budget/);

  assert.match(evaluateEagerBudget(files, { bundles: {} }).failures[0], /eager js has no brotli budget/);
});

test("the checked-in eager ceilings hold the first open to the per-screen load-time targets", () => {
  const budget = JSON.parse(read("scripts/bundle-budget.json"));
  assert.ok(budget.eager.js.brotli <= DEFAULT_EAGER_BUDGET.js.brotli, "eager JS stays at or under 220 KB brotli");
  assert.ok(budget.eager.styles.brotli <= DEFAULT_EAGER_BUDGET.styles.brotli, "the stylesheet stays at or under 70 KB brotli");
  assert.ok(DEFAULT_EAGER_BUDGET.js.brotli <= 220 * 1024);
  assert.ok(budget.eager.styles.brotli <= 85 * 1024, "the stylesheet stays at or under 85 KB brotli");
});

test("the eager JS total counts every script index.html loads, not only the bundles", () => {
  const html = `<script src="/art.js" defer></script>
    <script src="/js/bundle-01-core.js?v=1" defer></script>
    <script>inline()</script>
    <script src="https://cdn.example/x.js"></script>`;
  assert.deepEqual(eagerScriptsFromIndex(html), ["public/art.js", "public/js/bundle-01-core.js"]);
  const onlyBundles = [{ output: "public/js/bundle-01-core.js", lazy: null, raw: 1, brotli: 1 }];
  const missing = unbudgetedEagerScripts(html, onlyBundles);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /public\/art\.js eagerly but the eager JS total does not count it/);
  // A LAZY bundle loaded eagerly would be undercounted too.
  assert.equal(unbudgetedEagerScripts(html, [{ ...onlyBundles[0], lazy: "x" }, { output: "public/art.js", lazy: null }]).length, 1);

  // The real index.html: every eager script is measured as eager.
  const real = budgetedOutputs(BUNDLES).map((b) => ({ output: b.output, lazy: b.lazy ?? null }));
  assert.deepEqual(unbudgetedEagerScripts(read("public/index.html"), real), []);
  const listed = eagerScriptsFromIndex(read("public/index.html"));
  assert.ok(listed.includes("public/art.js") && listed.includes("public/cairn-body-figure.js"));
});
