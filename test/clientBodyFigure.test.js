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

// ---- the elite figure (design 2a/2b): loads the vendored library alongside the
// Stand client so window.CairnBodyFigure is present and the elite path is taken.
function loadElite() {
  const ctx = {
    console, Date, Math, Number, Object, String, JSON, Array,
    escHtml: (v) => String(v ?? ""),
    escAttr: (v) => String(v ?? "").replaceAll('"', "&quot;"),
    localISO: () => "2026-07-02", relAge: () => "2 weeks ago",
    sparklineSvg: () => "", toast: () => {}, api: () => Promise.resolve({}),
    matchMedia: () => ({ matches: false }),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(join(root, "public/cairn-body-figure.js"), "utf8"), ctx);
  vm.runInNewContext(readFileSync(join(root, "public/js/body-metrics-client.js"), "utf8"), ctx);
  return { bm: ctx.CairnBodyMetrics, F: ctx.CairnBodyFigure };
}

const mkData = (sites, profileOver = {}) => ({
  latest: latest(sites),
  measurements: [latest(sites)],
  indicators: [],
  trends: { window_days: 180, sites: [], weight: { key: "weight", direction: null } },
  needs_height: false,
  sites: [],
  measurement_issues: [],
  profile: { height_in: 71, sex: "male", weight_lb: 190, goal_weight_lb: 178, ...profileOver },
  comp: { scales: [], focus: null, heading: null },
});

test("the vendored library renders the Train figure with tappable, breathing muscles", () => {
  const { F } = loadElite();
  const svg = F.figureSvg("front", { chest: "due", quads: "due", back: "ok" }, { pulseDue: true, dataAttrs: true });
  assert.match(svg, /viewBox="0 0 260 640"/, "one authored coordinate system");
  assert.match(svg, /data-group="chest"/, "toned muscles carry data-group for taps");
  assert.match(svg, /class="cbf-pulse"/, "only due muscles breathe");
  assert.doesNotMatch(svg, /data-group="back"/, "a back-only group never toned on the front");
  assert.doesNotMatch(svg, /NaN/);
  const stand = F.figureSvg("front", {}, { stand: true });
  assert.doesNotMatch(stand, /data-group=/, "the plain stand silhouette carries no muscle overlays");
  assert.doesNotMatch(stand, /cbf-pulse/);
});

test("ratio rows stay clinical; the reference physique renders as its own references-not-mandates section", () => {
  const { bm } = loadElite();
  const model = bm.bmStandModel(mkData({ waist_in: 40, hip_in: 42, shoulder_in: 44, chest_in: 41, upper_arm_in: 14, calf_in: 15 }), "in");
  const rows = bm.bmStandRatioRows(model, "in");
  assert.match(rows, /Ratios &amp; context|Ratios & context/);
  assert.match(rows, /WAIST\/HEIGHT/);
  assert.match(rows, /clinical &lt;0\.50|clinical <0\.50/);
  assert.doesNotMatch(rows, /SHOULDER\/WAIST/, "tracking ratios yield to the reference rows when height is known");
  assert.doesNotMatch(rows, /Reference physique/);
  const refRows = bm.bmReferenceRows(model, "in");
  assert.match(refRows, /Reference physique · 5′11″/);
  assert.match(refRows, /SHOULDER/);
  assert.match(refRows, /→/, "each measured site reads current → reference");
  assert.match(refRows, /References, not mandates/);
  assert.doesNotMatch(refRows, /WEIGHT/);
  assert.doesNotMatch(refRows, /\b\d{1,3}\s*\/\s*100\b/, "no x/100 grade");
});

test("site context warns only on clinical central-adiposity; other sites read against the reference", () => {
  const { bm } = loadElite();
  const model = bm.bmStandModel(mkData({ waist_in: 40, hip_in: 42, chest_in: 41 }), "in");
  assert.equal(bm.bmSiteContext(model, "waist_in").chip.tone, "warn", "a high waist-height ratio is a warn");
  assert.equal(bm.bmSiteContext(model, "hip_in").chip.tone, "warn", "a high waist-hip ratio is a warn");
  const chest = bm.bmSiteContext(model, "chest_in");
  assert.equal(chest.chip.text, "below reference", "a muscle site under the reference is a calm watch, never a warn");
  assert.equal(chest.chip.tone, "gold");
  assert.match(chest.guide, /reference for your height/);
  assert.match(chest.why, /not a target/);
  // Without a height there is no reference — the site falls back to tracking-only.
  const noHeight = bm.bmStandModel(mkData({ chest_in: 41 }, { height_in: null }), "in");
  assert.equal(bm.bmSiteContext(noHeight, "chest_in").chip.text, "tracking only");
});

test("the elite Stand figure: measured silhouette over the reference ghost, tap targets, no score leaks", () => {
  const { bm, F } = loadElite();
  const model = bm.bmStandModel(mkData({ waist_in: 40, chest_in: 42, thigh_in: 23 }), "in");
  const svg = bm.bmStandFigureSvg(F, model, "waist_in");
  assert.match(svg, /class="bm-figure bm-figure2"/);
  assert.match(svg, /class="bm-co2" data-site="waist_in" role="button" tabindex="0"/, "callout is keyboard-reachable");
  assert.match(svg, /data-site="chest_in"/);
  assert.doesNotMatch(svg, /data-site="hip_in"/, "an untaped site gets no callout");
  assert.match(svg, /url\(#bmfig2-warn\)/, "a high waist-height ratio glows terracotta when selected");
  assert.match(svg, /stroke-dasharray="5 4"/, "the reference physique draws as a dashed ghost");
  assert.match(svg, /stroke-dasharray="4.5 3.5"/, "the clinical waist chalk trace draws above the guide");
  assert.match(svg, /dashed outline is the reference physique/, "the ghost is announced to assistive tech");
  assert.doesNotMatch(svg, /data-group=/, "the Stand plate is not the tappable muscle map");
  assert.doesNotMatch(svg, /NaN/);
  assert.doesNotMatch(svg, /\b\d{1,3}\s*\/\s*100\b/, "no x/100 grade");
  const lean = bm.bmStandFigureSvg(F, bm.bmStandModel(mkData({ waist_in: 33 }), "in"), "waist_in");
  assert.doesNotMatch(lean, /stroke-dasharray="4.5 3.5"/, "a lean waist draws no chalk trace");
  // Without a height the figure still draws, but no reference is implied.
  const noHeight = bm.bmStandFigureSvg(F, bm.bmStandModel(mkData({ waist_in: 40 }, { height_in: null }), "in"), "waist_in");
  assert.doesNotMatch(noHeight, /stroke-dasharray="5 4"/, "no ghost from a stand-in height");
  assert.doesNotMatch(noHeight, /NaN/);
});

test("the measured model is honest: reference tape reproduces the reference figure, a real tape reshapes it", () => {
  const { F } = loadElite();
  const ref = F.referenceTape("male", 70);
  assert.equal(ref.waist, Math.round(70 * 0.46 * 2) / 2, "reference waist is just under half height");
  assert.ok(Math.abs(ref.arm - ref.calf) <= 0.5, "classical balance: arm ≈ calf");
  const sil = F.silhouette("male");
  const atRef = F.measuredSilhouette("male", ref, 70);
  assert.equal(atRef.torso, sil.torso, "a full reference tape is pixel-identical to the authored figure");
  assert.equal(atRef.armR, sil.armR);
  // A partial tape only bends the measured zones; unmeasured sites hold reference.
  const bigWaist = F.measuredSilhouette("male", { waist: ref.waist * 1.25 }, 70);
  assert.ok(bigWaist.scales.waist > 1.05, "a wider waist widens the waist zone");
  assert.equal(bigWaist.scales.chest, 1, "an unmeasured chest stays at reference");
  assert.ok(bigWaist.scales.waist < 1.5, "tanh compression keeps extreme tapes plausible");
  assert.doesNotMatch(bigWaist.torso, /NaN/);
  // Female comes from the same paths via the per-zone warp.
  assert.notEqual(F.silhouette("female").torso, sil.torso);
  assert.doesNotMatch(F.measuredSilhouette("female", { hip: 44 }, 64).torso, /NaN/);
});

test("the Stand figure holds suspect tape sites neutral until re-taped", () => {
  const { bm, F } = loadElite();
  const data = mkData({ hip_in: 41, thigh_in: 15, calf_in: 11, waist_in: 38 });
  data.measurement_issues = [
    { site: "thigh_in", severity: "warning", message: "Thigh looks unusual for your height." },
    { site: "calf_in", severity: "warning", message: "Calf looks unusual next to hips." },
  ];
  const model = bm.bmStandModel(data, "in");
  assert.deepEqual([...model.flaggedSites].sort(), ["calf_in", "thigh_in"]);
  assert.equal(bm.bmSiteContext(model, "thigh_in").chip.text, "recheck tape");
  const svg = bm.bmStandFigureSvg(F, model, "thigh_in");
  assert.match(svg, /RECHECK/);
  assert.match(svg, /bmfig2-gold/, "a selected suspect site uses the calm gold wash");
  assert.match(bm.compSection(data, "in"), /figure is holding those areas neutral/i);
});

test("the tape log form prefills latest-known sites and leaves never-measured sites blank", () => {
  const { bm } = loadElite();
  const data = mkData({ waist_in: 35.8 });
  data.measurements = [
    latest({ id: 1, date: "2026-05-20", chest_in: 42.2 }),
    data.latest,
  ];
  data.sites = [
    { key: "waist_in", label: "Waist", hint: "At the navel, relaxed.", range: { min: 15, max: 70, typical_min: 24, typical_max: 46 } },
    { key: "chest_in", label: "Chest", hint: "At nipple line.", range: { min: 20, max: 80, typical_min: 30, typical_max: 55 } },
    { key: "hip_in", label: "Hips", hint: "At the widest point.", range: { min: 20, max: 80, typical_min: 30, typical_max: 58 } },
  ];
  const form = bm.logForm(data, "in");
  assert.match(form, /class="bm-step" data-site="waist_in" data-dir="-1"/, "each site gets − / + steppers");
  assert.match(form, /class="bm-step" data-site="waist_in" data-dir="1"/);
  assert.match(form, /data-site="waist_in"[^>]*data-prefill="35.8"[^>]*value="35.8"/, "the actual input, not just the stepper seed, carries the latest waist");
  assert.match(form, /data-site="chest_in"[^>]*value="42.2"/, "an older chest carries forward when the newest session measured only waist");
  assert.match(form, /data-site="hip_in"[^>]*data-prefill=""[^>]*value=""/, "a site with no measurement remains empty");
  assert.match(form, /last measurements are prefilled/i, "the form explains its carry-forward behavior");
  assert.match(form, /ref 32/, "the height-derived reference rides the row in italic");
  assert.match(form, /never a mandate/i);
  // The placement hint must START hidden — the hidden attribute alone loses to
  // an inline display:block (the every-hint-open regression), so the markup
  // carries display:none explicitly.
  assert.match(form, /class="bm-site-hint[^"]*"[^>]*hidden[^>]*display:none/, "hints hide until the ⓘ is tapped");
  assert.match(form, /class="bm-site-hint[^"]*"[^>]*position:absolute/, "the hint is a popover — opening it never reflows the grid");
  assert.doesNotMatch(form, /class="bm-site-hint[^"]*"[^>]*display:block/);
  // Without a height there is no reference column, and the form still draws.
  const noHeight = bm.logForm({ ...data, profile: { ...data.profile, height_in: null } }, "in");
  assert.doesNotMatch(noHeight, /ref \d/);
  assert.match(noHeight, /class="bm-step"/);
});

test("tape input checks distinguish impossible values from unusual-but-confirmable values", () => {
  const bm = loadBodyMetrics();
  const range = { min: 12, max: 45, typical_min: 16.8, typical_max: 35 };
  assert.equal(bm.bmTapeValueIssue(24, "Thigh", "in", range), null);
  assert.equal(bm.bmTapeValueIssue(15, "Thigh", "in", range).kind, "warning");
  assert.match(bm.bmTapeValueIssue(15, "Thigh", "in", range).message, /unusual for your height/i);
  assert.equal(bm.bmTapeValueIssue(100, "Thigh", "in", range).kind, "error");
  assert.match(bm.bmTapeValueIssue(100, "Thigh", "in", range).message, /between 12 and 45 in/i);
});

test("compSection uses the elite figure when the library is present, the legacy croquis when not", () => {
  const data = mkData({ waist_in: 38, chest_in: 43 });
  const { bm: elite } = loadElite();
  const heroElite = elite.compSection(data, "in");
  assert.match(heroElite, /bm-figure2/, "elite measured figure");
  assert.match(heroElite, /Ratios &amp; context|Ratios & context/, "clinical ratio rows render");
  assert.match(heroElite, /Reference physique/, "the reference rows render beneath");
  assert.match(heroElite, /References, not mandates/);
  assert.match(heroElite, /the reference for your height/, "the ghost legend explains the dashes");
  const legacy = loadBodyMetrics(); // this context has no CairnBodyFigure
  const heroLegacy = legacy.compSection(data, "in");
  assert.doesNotMatch(heroLegacy, /bm-figure2/, "falls back to the tape-driven croquis");
  assert.match(heroLegacy, /class="bm-figure"/, "the legacy figure still draws — nothing regresses");
});

test("ratio rows carry no score and never emit derived target measurements", () => {
  const { bm } = loadElite();
  const noHeight = bm.bmStandRatioRows(bm.bmStandModel(mkData({ shoulder_in: 44, waist_in: 38 }, { height_in: null }), "in"), "in");
  assert.match(noHeight, /SHOULDER\/WAIST/, "tracking-only ratios cover the no-height case");
  assert.equal(bm.bmReferenceRows(bm.bmStandModel(mkData({ waist_in: 38 }, { height_in: null }), "in"), "in"), "", "no reference rows without a height");
  const withHeight = bm.bmStandRatioRows(bm.bmStandModel(mkData({ waist_in: 38, hip_in: 42, chest_in: 41 }), "in"), "in");
  assert.match(withHeight, /Ratios &amp; context|Ratios & context/);
  assert.doesNotMatch(withHeight, /Reference physique/);
  assert.doesNotMatch(withHeight, /→/);
  assert.doesNotMatch(withHeight, /WEIGHT/);
  assert.doesNotMatch(withHeight, /\b\d{1,3}\s*\/\s*100\b/);
});
