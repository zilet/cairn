// The Body "where you stand" figure: deterministic region derivation (which body
// area is tinted) + the fitting-sheet SVG — one continuous croquis silhouette
// whose outline widths are drawn from the latest tape, a dashed sage trace of
// the optimal waistline for the athlete's height, hairline callouts for each
// measured site carrying the move since the previous tape, and the previous-
// session merge that feeds the then→now morph. No scores, escaped aria, and it
// never emits NaN geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadBodyMetrics() {
  const ctx = {
    console, Date, Math, Number, Object, String, JSON, Array,
    escHtml: (v) => String(v ?? ""),
    escAttr: (v) => String(v ?? "").replaceAll('"', "&quot;"),
    localISO: () => "2026-07-02",
    relAge: () => "2 weeks ago",
    sparklineSvg: () => "",
    toast: () => {},
    api: () => Promise.resolve({}),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(join(root, "public/js/body-metrics-client.js"), "utf8"), ctx);
  return ctx.CairnBodyMetrics;
}

const trends = (dirs) => ({
  window_days: 180,
  sites: Object.entries(dirs).map(([key, direction]) => ({ key, direction })),
  weight: { key: "weight", direction: null },
});

const latest = (over = {}) => ({
  id: 1, date: "2026-06-20",
  waist_in: null, hip_in: null, chest_in: null, shoulder_in: null, neck_in: null,
  thigh_in: null, upper_arm_in: null, calf_in: null, forearm_in: null,
  note: null, source: null, ...over,
});

const fig = (bm, over = {}) =>
  bm.bodyFigureSvg({
    latest: null, heightIn: 69, sex: "male", unit: "in", focus: null, wins: [], dirs: {}, ...over,
  });

test("deriveFigureRegions maps the central-fat lever to the waist", () => {
  const bm = loadBodyMetrics();
  for (const key of ["whtr", "whr", "bodyfat"]) {
    assert.equal(bm.deriveFigureRegions({ focus: { key } }, undefined).focus, "waist", `${key} → waist`);
  }
  // BMI is whole-body, not a waist region; no lever tint.
  assert.equal(bm.deriveFigureRegions({ focus: { key: "bmi" } }, undefined).focus, null);
  assert.equal(bm.deriveFigureRegions({ focus: null }, undefined).focus, null);
});

test("a muscle site growing while the waist holds reads as a win; a rising waist suppresses it", () => {
  const bm = loadBodyMetrics();
  // Recomposition: arms + thighs up, waist down → arms + legs win.
  const recomp = bm.deriveFigureRegions(
    { focus: { key: "whtr" } },
    trends({ waist_in: "down", upper_arm_in: "up", thigh_in: "up" })
  );
  assert.equal(recomp.focus, "waist");
  assert.equal([...recomp.wins].sort().join(","), "arms,legs");

  // Gaining everywhere (waist ALSO up) is not "winning" — no sage.
  const bulk = bm.deriveFigureRegions(
    { focus: null },
    trends({ waist_in: "up", upper_arm_in: "up", thigh_in: "up" })
  );
  assert.equal(bulk.wins.length, 0);

  // Chest/shoulder growth maps to the chest region.
  const upper = bm.deriveFigureRegions({ focus: null }, trends({ shoulder_in: "up" }));
  assert.equal([...upper.wins].join(","), "chest");
});

test("mergeLatestSites reads each site's latest known value across sessions", () => {
  const bm = loadBodyMetrics();
  // The API lists sessions chronologically (oldest first, for charting); a quick
  // waist-only re-tape must not blank last month's chest.
  const rows = [
    latest({ id: 1, date: "2026-05-01", chest_in: 41, hip_in: 40 }),
    latest({ id: 2, date: "2026-06-01", waist_in: 39, chest_in: 42, thigh_in: 23 }),
    latest({ id: 3, date: "2026-07-01", waist_in: 38 }),
  ];
  const merged = bm.mergeLatestSites(rows, rows[2]);
  assert.equal(merged.waist_in, 38, "newest waist wins");
  assert.equal(merged.chest_in, 42, "chest falls back to the last session that taped it");
  assert.equal(merged.hip_in, 40, "hip reaches back two sessions");
  assert.equal(merged.date, "2026-07-01", "row identity stays the newest session");
  assert.equal(bm.mergeLatestSites([], null), null);
});

test("mergePreviousSites reads the sheet one session ago (and needs two sessions)", () => {
  const bm = loadBodyMetrics();
  const rows = [
    latest({ id: 1, date: "2026-05-01", chest_in: 41, waist_in: 40 }),
    latest({ id: 2, date: "2026-06-01", waist_in: 39, thigh_in: 23 }),
    latest({ id: 3, date: "2026-07-01", waist_in: 38 }),
  ];
  const prev = bm.mergePreviousSites(rows, rows[2]);
  assert.equal(prev.waist_in, 39, "previous = the merge with the newest session dropped");
  assert.equal(prev.chest_in, 41, "older sites still reach back");
  assert.equal(prev.thigh_in, 23);
  assert.equal(bm.mergePreviousSites([rows[0]], rows[0]), null, "one session has no 'then' frame");
  assert.equal(bm.mergePreviousSites([], null), null);
});

test("the silhouette is one continuous path — no ellipse stack — and it clips its washes", () => {
  const bm = loadBodyMetrics();
  const neutral = fig(bm);
  assert.doesNotMatch(neutral, /<ellipse/, "body geometry is smooth paths, not ellipses");
  assert.match(neutral, /<clipPath id="bmfig-clip-core">/, "silhouette doubles as the glow clip");
  const focused = fig(bm, { latest: latest({ waist_in: 38 }), focus: "waist" });
  assert.match(focused, /<g clip-path="url\(#bmfig-clip-core\)">/, "torso glows stay inside the body line");
  assert.match(focused, /<radialGradient id="bmfig-glow-a">/, "the focus wash is a soft glow, not a flat slab");
  assert.match(focused, /class="bm-pulse"/, "the focus wash breathes");
  assert.doesNotMatch(fig(bm, { latest: latest({ waist_in: 38 }) }), /bm-pulse/, "no focus, no pulse");
});

test("a move since the last tape rides the callout; tape noise stays quiet", () => {
  const bm = loadBodyMetrics();
  const moved = fig(bm, { latest: latest({ waist_in: 38 }), deltas: { waist_in: -1.5 }, dirs: { waist_in: "down" } });
  assert.match(moved, />↓1\.5<\/tspan>/, "delta renders as arrow + magnitude");
  const quiet = fig(bm, { latest: latest({ waist_in: 38 }), deltas: { waist_in: -0.1 }, dirs: { waist_in: "down" } });
  assert.match(quiet, />↓<\/tspan>/, "sub-threshold delta falls back to the trend arrow");
  assert.doesNotMatch(quiet, />↓0\.1</);
});

test("the mannequin draws from the tape: measured sites get callouts, unmeasured stay silent", () => {
  const bm = loadBodyMetrics();
  const svg = fig(bm, { latest: latest({ waist_in: 38, chest_in: 42, thigh_in: 23 }), dirs: { waist_in: "down" } });
  assert.match(svg, /<svg[^>]*class="bm-figure"/);
  for (const [name, val] of [["WAIST", "38"], ["CHEST", "42"], ["THIGH", "23"]]) {
    assert.match(svg, new RegExp(`>${name}</tspan>`), `${name} callout present`);
    assert.match(svg, new RegExp(`>${val}</tspan>`), `${name} value present`);
  }
  assert.match(svg, />↓<\/tspan>/, "waist trend arrow rides the callout");
  assert.doesNotMatch(svg, />HIP</, "untaped site gets no callout");
  assert.doesNotMatch(svg, /NaN/, "geometry never leaks NaN");
  // Callouts are tap-through affordances to the site's trend row.
  assert.match(svg, /class="bm-co" data-site="waist_in" role="button" tabindex="0"/, "callout is keyboard-reachable");
  assert.match(svg, /aria-label="See the waist trend"/);
});

test("the dashed optimal-waist trace appears only above the band", () => {
  const bm = loadBodyMetrics();
  // 38 in waist at 69 in height (0.55) → above optimal, trace + label drawn.
  const above = fig(bm, { latest: latest({ waist_in: 38 }) });
  assert.match(above, /stroke-dasharray="4 3"/, "dashed trace drawn");
  assert.match(above, />OPTIMAL<\/tspan>/, "optimal callout labeled");
  assert.match(above, />34\.5<\/tspan>/, "optimal waist = half the 69 in height");
  assert.doesNotMatch(above, /data-site="optimal/, "the optimal marker is not a tap target");
  // 31 in waist (0.45) sits inside the band → no target drawn over a lean waist.
  const lean = fig(bm, { latest: latest({ waist_in: 31 }) });
  assert.doesNotMatch(lean, /stroke-dasharray="4 3"/);
  assert.doesNotMatch(lean, />OPTIMAL</);
});

test("cm payloads scale geometry in inches but display cm values", () => {
  const bm = loadBodyMetrics();
  // 96.5 cm waist (38 in) at 69 in height → above optimal, value shown as taped.
  const svg = fig(bm, { unit: "cm", latest: latest({ waist_in: 96.5 }) });
  assert.match(svg, />96\.5<\/tspan>/, "callout shows the cm value");
  assert.match(svg, /stroke-dasharray="4 3"/, "band math ran in inches");
  assert.match(svg, />87\.6<\/tspan>/, "optimal waist rendered in cm (34.5 in)");
  assert.doesNotMatch(svg, /NaN/);
});

test("focus tints terracotta, wins mark sage, neutral stays quiet, and no score leaks", () => {
  const bm = loadBodyMetrics();
  const svg = fig(bm, { latest: latest({ waist_in: 38, upper_arm_in: 14 }), focus: "waist", wins: ["arms"] });
  assert.match(svg, /#b4552d/, "focus tint uses the terracotta accent");
  assert.match(svg, /#5a6a4a/, "win chevron uses deep sage");
  assert.match(svg, /aria-label="[^"]*waist[^"]*"/i);
  // Neutral, no measurements: base mannequin only — no focus/win colors, no callouts.
  const neutral = fig(bm);
  assert.doesNotMatch(neutral, /#b4552d|#5a6a4a/);
  assert.doesNotMatch(neutral, /<text/, "default croquis carries no annotations");
  assert.doesNotMatch(neutral, /NaN/);
  assert.doesNotMatch(svg, /\b\d{1,3}\s*\/\s*100\b/, "no x/100 grade");
});
