// @ts-check
// Body Metrics — a calm at-home measurements + indicators + trend view.
//
// Self-contained: renderBodyMetrics(mount) fetches /api/body-metrics and paints,
// top to bottom: a "Log a tape session" action card (always one tap from the top,
// open by default until the first session exists), the "Where you stand" hero —
// a fitting-sheet FIGURE: one continuous croquis silhouette whose outline widths
// are drawn from YOUR latest tape in true proportion to your height, a dashed
// sage trace of the optimal waistline for your height (waist ≤ half height)
// drawn inside the outline it's converging toward, and hairline callouts
// annotating each measured site with its value + the move since the last tape
// (falling back to the 6-month trend arrow). With two or more sessions the
// figure MORPHS on load from the previous session's proportions into today's —
// you watch the tape move (skipped under prefers-reduced-motion) — plus the
// deterministic heading + ONE focus lever; then "The numbers"
// (each indicator on its evidence-anchored zone bands with a "you are here" dot,
// a dashed "heading here at the current pace" marker and its plain-language read
// folded into the same row — words and position, never a score); then per-site
// sparkline trends. An in/cm unit toggle (default derived from the browser
// locale, persisted locally; storage stays inches server-side) and an optional
// "set your height" affordance (unlocks BMI/body-fat) round it out. Atelier-
// flavoured with existing classes + inline styles only, so it ships without a
// stylesheet change.

type BmTone = "ok" | "watch" | "warn" | "info";
type BmUnit = "in" | "cm";

interface BmMeasurement {
  id: number;
  date: string;
  waist_in: number | null;
  hip_in: number | null;
  chest_in: number | null;
  shoulder_in: number | null;
  neck_in: number | null;
  thigh_in: number | null;
  upper_arm_in: number | null;
  calf_in: number | null;
  forearm_in: number | null;
  note: string | null;
  source: string | null;
}
interface BmIndicator {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  zone: string | null;
  tone: BmTone;
  read: string;
  estimate?: boolean;
  needs?: string[];
}
interface BmTrend {
  key: string;
  label: string;
  unit: string;
  latest: number | null;
  n: number;
  points: number[];
  direction: "up" | "down" | "steady" | null;
  text: string;
}
interface BmBand {
  from: number;
  to: number;
  label: string;
  tone: BmTone;
}
interface BmScale {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  bands: BmBand[];
  optimal: { from: number; to: number };
  value: number | null;
  projected: number | null;
  horizon_weeks: number;
  estimate: boolean;
  read: string;
}
interface BmComp {
  scales: BmScale[];
  focus: { key: string; label: string; line: string } | null;
  heading: string | null;
}
interface BmSummary {
  latest: BmMeasurement | null;
  measurements: BmMeasurement[];
  indicators: BmIndicator[];
  trends: { window_days: number | null; sites: BmTrend[]; weight: BmTrend };
  profile: { height_in: number | null; sex: string; weight_lb: number | null; goal_weight_lb: number | null };
  needs_height: boolean;
  unit?: BmUnit;
  sites: { key: string; label: string; hint?: string }[];
  comp?: BmComp;
}

(() => {
// Fills (band segments) vs text (band words): gold is a fill, too light for
// text; sage needs its darker text token at small sizes (see docs/DESIGN.md).
const BM_TONE_COLOR: Record<BmTone, string> = {
  ok: "var(--sage, #6e7f5c)",
  watch: "var(--gold, #c9a86a)",
  warn: "var(--warn, #b3402e)",
  info: "var(--muted, #746c5c)",
};
const BM_TONE_TEXT: Record<BmTone, string> = {
  ok: "var(--sage-text, #5f6e4f)",
  watch: "var(--gold-deep, #8a6d2e)",
  warn: "var(--warn, #b3402e)",
  info: "var(--muted, #746c5c)",
};

const BM_UNIT_KEY = "cairn-bm-unit";

// The saved unit, else derived from the browser locale — only the US, Liberia
// and Myanmar tape in inches; everyone else gets centimeters.
function bmUnitPref(): BmUnit {
  try {
    const saved = localStorage.getItem(BM_UNIT_KEY);
    if (saved === "in" || saved === "cm") return saved;
  } catch {
    /* private mode */
  }
  const region = ((navigator.language || "").split("-")[1] || "").toUpperCase();
  return region && !["US", "LR", "MM"].includes(region) ? "cm" : "in";
}

function bmSetUnitPref(unit: BmUnit): void {
  try {
    localStorage.setItem(BM_UNIT_KEY, unit);
  } catch {
    /* private mode */
  }
}

function bmNum(el: Element | null): number | null {
  if (!el) return null;
  const raw = (el as HTMLInputElement).value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Height entry → total inches. In-mode: feet + inches; cm-mode: one cm field.
function bmHeightInches(mount: HTMLElement): number | null {
  const cm = bmNum(mount.querySelector("#bmHeightCm"));
  if (cm != null) return Math.round((cm / 2.54) * 10) / 10;
  const ft = bmNum(mount.querySelector("#bmHeightFt"));
  const inch = bmNum(mount.querySelector("#bmHeightIn"));
  if (ft == null && inch == null) return null;
  return (ft ?? 0) * 12 + (inch ?? 0);
}

// --- the fitting-sheet figure ---------------------------------------------------
// One continuous croquis silhouette — the confident single line of a fashion
// fitting sheet, not a jointed mannequin. The outline is a smooth closed path
// through per-station half-widths (neck, shoulder, chest, waist, hip, thigh,
// knee, calf, ankle), every one computed from the athlete's latest tape and
// scaled so the whole figure keeps true proportion to their height; the arms
// hang as their own tapered paths just off the torso so the waistline stays
// readable. The optimal waist for that height (waist-to-height ≤ 0.5) is traced
// as a dashed sage waistline inside the silhouette, each measured site gets a
// hairline callout with its value + the move since the last tape, and focus /
// win washes are clipped INSIDE the body line. Illustration hexes (like
// art.js), not theme vars — SVG paint attrs don't reliably resolve var().

type BmSiteKey =
  | "neck_in" | "shoulder_in" | "chest_in" | "waist_in" | "hip_in"
  | "thigh_in" | "upper_arm_in" | "forearm_in" | "calf_in";

// Croquis fallbacks (inches) for sites not yet taped — the figure always draws.
const BM_FIG_DEFAULT: Record<"male" | "female", Record<BmSiteKey, number>> = {
  male: { neck_in: 15, shoulder_in: 45, chest_in: 39, waist_in: 33, hip_in: 37.5, thigh_in: 21.5, upper_arm_in: 12.5, forearm_in: 11, calf_in: 14.5 },
  female: { neck_in: 12.5, shoulder_in: 39, chest_in: 35, waist_in: 28, hip_in: 38, thigh_in: 21.5, upper_arm_in: 10.5, forearm_in: 9.5, calf_in: 13.5 },
};

const BM_FIG_INK = "#211d17";
const BM_FIG_MUTED = "#746c5c";
const BM_FIG_ACCENT = "#b4552d";
const BM_FIG_SAGE_DEEP = "#5a6a4a";
const BM_FIG_LINE = "#c4b89d";

const BM_SITE_KEYS: BmSiteKey[] = ["neck_in", "shoulder_in", "chest_in", "waist_in", "hip_in", "thigh_in", "upper_arm_in", "forearm_in", "calf_in"];

const bmR = (n: number): number => Math.round(n * 10) / 10;

// Catmull-Rom → cubic Bézier through a CLOSED loop of points: the one smoothing
// pass that turns the station half-widths into a confident continuous line.
function bmLoopPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  let d = `M${bmR(pts[0][0])} ${bmR(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += ` C${bmR(p1[0] + (p2[0] - p0[0]) / 6)} ${bmR(p1[1] + (p2[1] - p0[1]) / 6)} ${bmR(p2[0] - (p3[0] - p1[0]) / 6)} ${bmR(p2[1] - (p3[1] - p1[1]) / 6)} ${bmR(p2[0])} ${bmR(p2[1])}`;
  }
  return `${d} Z`;
}

// Same smoothing, open-ended (the optimal-waistline ghost trace).
function bmOpenPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  const at = (i: number) => pts[Math.min(n - 1, Math.max(0, i))];
  let d = `M${bmR(pts[0][0])} ${bmR(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    d += ` C${bmR(p1[0] + (p2[0] - p0[0]) / 6)} ${bmR(p1[1] + (p2[1] - p0[1]) / 6)} ${bmR(p2[0] - (p3[0] - p1[0]) / 6)} ${bmR(p2[1] - (p3[1] - p1[1]) / 6)} ${bmR(p2[0])} ${bmR(p2[1])}`;
  }
  return d;
}

interface BmFigureInput {
  latest: BmMeasurement | null;
  heightIn: number | null;
  sex: string;
  unit: BmUnit;
  focus: string | null; // region: waist | null
  wins: string[]; // regions: arms | legs | chest
  dirs: Record<string, "up" | "down" | "steady" | null>;
  deltas?: Record<string, number | null>; // per-site move since the previous tape, display unit
}

// A tape session fills in only what was measured — so the figure reads each
// site's LATEST KNOWN value across sessions, not just the newest row, and a
// quick waist-only re-tape never blanks last month's chest. The API lists
// measurements chronologically (for charting), so sort newest-first here rather
// than lean on payload order.
function mergeLatestSites(measurements: BmMeasurement[] | undefined, latest: BmMeasurement | null): BmMeasurement | null {
  const rows = (measurements && measurements.length ? [...measurements] : latest ? [latest] : []).sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  if (!rows.length) return null;
  const merged = { ...rows[0] };
  for (const k of BM_SITE_KEYS) {
    if (merged[k] != null) continue;
    for (const r of rows) {
      if (r[k] != null) {
        merged[k] = r[k];
        break;
      }
    }
  }
  return merged;
}

// The fitting sheet one session ago: drop the newest session and merge the
// rest — the "then" frame the figure morphs from, and what the per-site deltas
// read against. Null until a second session exists.
function mergePreviousSites(measurements: BmMeasurement[] | undefined, latest: BmMeasurement | null): BmMeasurement | null {
  const rows = (measurements && measurements.length ? [...measurements] : latest ? [latest] : []).sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  if (rows.length < 2) return null;
  return mergeLatestSites(rows.slice(1), null);
}

function bmFmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function bodyFigureSvg(inp: BmFigureInput): string {
  const female = String(inp.sex || "").toLowerCase() === "female";
  const D = BM_FIG_DEFAULT[female ? "female" : "male"];
  const hIn = Math.min(90, Math.max(48, inp.heightIn ?? (female ? 64 : 69)));
  const s = 210 / hIn; // px per inch — the drawn body height is constant

  // Latest tape in inches (payload values arrive in the display unit).
  const inVal = (k: BmSiteKey): number | null => {
    const raw = inp.latest ? (inp.latest[k] as number | null) : null;
    if (raw == null || !Number.isFinite(raw)) return null;
    return inp.unit === "cm" ? raw / 2.54 : raw;
  };
  const circ = (k: BmSiteKey) => inVal(k) ?? D[k];
  const measured = (k: BmSiteKey) => inVal(k) != null;
  const dispVal = (k: BmSiteKey): string => bmFmt((inp.latest?.[k] as number | null) ?? 0);

  // Circumference → frontal half-width. Torso cross-sections are elliptical
  // (wider than deep), limbs near-circular; clamps keep a typo'd tape humane.
  const torsoRx = (c: number) => Math.min(52, Math.max(8, (c / 5.4) * s));
  const shoulderRx = (c: number) => Math.min(56, Math.max(10, (c / 5.1) * s));
  const limbRx = (c: number) => Math.min(24, Math.max(3.5, (c / 6) * s));
  const neckRx = (c: number) => Math.min(16, Math.max(3.5, (c / 6.3) * s));

  const CX = 170;
  const chestR = torsoRx(circ("chest_in"));
  const waistR = torsoRx(circ("waist_in"));
  const hipR = torsoRx(circ("hip_in"));
  const shR = shoulderRx(circ("shoulder_in"));
  const neckR = neckRx(circ("neck_in"));
  const armR = limbRx(circ("upper_arm_in"));
  const foreR = limbRx(circ("forearm_in"));
  const thighR = limbRx(circ("thigh_in"));
  const calfR = limbRx(circ("calf_in"));

  const thighCx = Math.max(hipR * 0.52, thighR * 0.9) + 0.5;
  const kneeCx = hipR * 0.45 + 2;
  const kneeW = Math.max(3.5, (thighR + calfR) * 0.3);
  const ankleW = Math.max(2.5, calfR * 0.45);
  const neckW = Math.min(neckR * 0.82, 8.2); // visibly narrower than the head

  // The right-hand outline, head → neck → shoulder → chest → waist → hip →
  // outer leg → foot → back up the inner leg (dx offsets from the centerline);
  // the closed loop mirrors it through the head-top and crotch center points.
  // Human landmarks matter more than smoothness here: a defined chin and a
  // narrow under-jaw neck, a trapezius slope breaking at the acromion, an
  // armpit, and feet that read as feet.
  const side: Array<[number, number]> = [
    [3.6, 12.2], // crown
    [8.4, 15.5], // temple
    [9.6, 23], // head widest
    [8.5, 30.5], // cheek
    [5.4, 36.5], // jaw
    [3.1, 39.4], // chin corner
    [neckW, 42.5], // under-jaw neck
    [neckW * 1.04, 50], // neck base
    [neckW + 3.2, 53.2], // trapezius rise
    [shR * 0.86, 57.5], // trap → acromion
    [shR, 62], // shoulder point
    [chestR * 1.01, 69.5], // armpit
    [chestR, 76], // chest widest
    [(chestR + waistR) * 0.49, 90],
    [waistR, 106], // natural waist
    [(waistR + hipR) * 0.5, 119],
    [hipR, 131], // hip widest
    [hipR * 0.97, 138],
    [thighCx + thighR, 155], // outer thigh
    [kneeCx + kneeW, 186], // outer knee
    [kneeCx + calfR, 199], // calf
    [kneeCx + ankleW, 215], // ankle
    [kneeCx + ankleW + 6.5, 222], // toe
    [kneeCx - ankleW - 1.5, 224], // heel
    [kneeCx - calfR * 0.8, 199], // inner calf
    [kneeCx - kneeW * 0.85, 186], // inner knee
    [thighCx - thighR * 0.85, 157], // inner thigh
  ];
  const corePath = bmLoopPath([
    [CX, 11.5],
    ...side.map(([dx, y]) => [CX + dx, y] as [number, number]),
    [CX, 143],
    ...[...side].reverse().map(([dx, y]) => [CX - dx, y] as [number, number]),
  ]);
  // Arms hang FROM THE SHOULDER along a slightly abducted axis — tilted out
  // just enough that the forearm clears the waist and hip with a small gap, so
  // the waistline stays readable without the arms reading as bolted on.
  const ax0 = shR * 0.8; // shoulder pivot x
  const ax1 = Math.max(
    ax0 + (waistR + 1.5 + foreR * 0.85 - ax0) / 0.649, // clears the waist (y≈106)
    ax0 + (hipR + 1.5 + foreR * 0.6 - ax0) / 0.986, // clears the hip (y≈131)
    ax0 + 6
  ); // wrist-line x
  const ax = (y: number) => ax0 + (ax1 - ax0) * ((y - 58) / 74);
  const armSide: Array<[number, number]> = [
    [shR * 0.55, 55], // tucked under the trap (covered by the torso)
    [ax(66) + armR * 1.05, 67], // deltoid
    [ax(80) + armR * 0.9, 80],
    [ax(97) + armR * 0.72, 97], // outer elbow
    [ax(110) + foreR * 0.95, 110], // forearm
    [ax(126) + foreR * 0.55, 126], // wrist
    [ax(138) + foreR * 0.5, 138], // palm
    [ax(146) + 1.5, 146], // fingertips
    [ax(140) - foreR * 0.5, 141],
    [ax(127) - foreR * 0.5, 128], // inner wrist
    [ax(110) - foreR * 0.85, 110], // inner forearm
    [ax(98) - armR * 0.7, 98], // inner elbow
    [ax(78) - armR * 0.8, 78], // inner upper arm
    [ax(66) - armR * 0.6, 64], // armpit
  ];
  const armPath = (sign: 1 | -1) => bmLoopPath(armSide.map(([dx, y]) => [CX + sign * dx, y] as [number, number]));
  // Arms first, torso over them: the core path's fill hides the arm strokes at
  // the shoulder junction, so the silhouette reads as one figure.
  const body = `<path d="${armPath(-1)}" fill="url(#bmfig-base)"/><path d="${armPath(1)}" fill="url(#bmfig-base)"/><path d="${corePath}" fill="url(#bmfig-base)"/>`;

  // ONE glow: a soft radial field (bright center fading to nothing) over the
  // FOCUS region only, clipped inside the silhouette so the light never spills
  // past the body line — torso glows clip to the core, arm glows to the arms.
  // Winning regions get quiet chevrons instead of light; glowing several
  // regions at once turned the whole figure into a smudge and buried the one
  // story that matters. The glow breathes via the CSS .bm-pulse animation
  // (stilled under reduced motion).
  const washFor = (region: string, grad: string): string => {
    const e = (cx: number, cy: number, rx: number, ry: number, clip: string) =>
      `<g clip-path="url(#${clip})"><ellipse class="bm-pulse" cx="${bmR(cx)}" cy="${cy}" rx="${bmR(rx)}" ry="${ry}" fill="url(#${grad})"/></g>`;
    if (region === "waist") return e(CX, 106, waistR + 14, 26, "bmfig-clip-core");
    if (region === "chest") return e(CX, 72, chestR + 12, 24, "bmfig-clip-core");
    if (region === "arms") return e(CX - ax(98), 98, armR + 10, 50, "bmfig-clip-arms") + e(CX + ax(98), 98, armR + 10, 50, "bmfig-clip-arms");
    if (region === "legs") return e(CX - thighCx, 186, thighR + 12, 56, "bmfig-clip-core") + e(CX + thighCx, 186, thighR + 12, 56, "bmfig-clip-core");
    return "";
  };
  const glowStops = (hex: string, peak: number) =>
    `<stop offset="0%" stop-color="${hex}" stop-opacity="${peak}"/><stop offset="65%" stop-color="${hex}" stop-opacity="${bmR(peak * 0.55 * 100) / 100}"/><stop offset="100%" stop-color="${hex}" stop-opacity="0"/>`;
  let glowDefs = "";
  let tintLayer = "";
  if (inp.focus) {
    glowDefs += `<radialGradient id="bmfig-glow-a">${glowStops(BM_FIG_ACCENT, 0.38)}</radialGradient>`;
    tintLayer += washFor(inp.focus, "bmfig-glow-a");
  }
  const winRegions = (inp.wins || []).filter((w) => w !== inp.focus);

  // One chevron per winning region's primary mass (chest / upper arms / thighs) —
  // marking every station turned the figure into noise.
  let marks = "";
  const chevron = (cx: number, y: number) =>
    `<path d="M${bmR(cx - 4)} ${bmR(y + 5)} L${bmR(cx)} ${bmR(y)} L${bmR(cx + 4)} ${bmR(y + 5)}" fill="none" stroke="${BM_FIG_SAGE_DEEP}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
  for (const w of winRegions) {
    if (w === "chest") marks += chevron(CX, 68);
    if (w === "arms") marks += chevron(CX - ax(72), 72) + chevron(CX + ax(72), 72);
    if (w === "legs") marks += chevron(CX - thighCx, 150) + chevron(CX + thighCx, 150);
  }

  // The optimal-waistline ghost: a dashed sage indent traced INSIDE the outline
  // at the width the waist is heading toward, drawn only when the measured
  // waist sits above the band (a leaner-than-optimal waist needs no target
  // drawn over it). Same blend stations as the silhouette, so the two lines
  // read as one converging on the other.
  const waistIn = inVal("waist_in");
  const optWaistIn = inp.heightIn != null ? 0.5 * Math.min(90, Math.max(48, inp.heightIn)) : null;
  const showOpt = waistIn != null && optWaistIn != null && waistIn > optWaistIn + 0.2;
  const optR = optWaistIn != null ? torsoRx(optWaistIn) : 0;
  let optTrace = "";
  if (showOpt) {
    const tracePts = (sign: 1 | -1): Array<[number, number]> => [
      [CX + sign * (chestR + optR) * 0.48, 88],
      [CX + sign * optR, 106],
      [CX + sign * (optR + hipR) * 0.5, 118],
    ];
    const traceAttrs = `fill="none" stroke="${BM_FIG_SAGE_DEEP}" stroke-width="1.5" stroke-dasharray="4 3" stroke-linecap="round" opacity="0.95"`;
    optTrace = `<path d="${bmOpenPath(tracePts(1))}" ${traceAttrs}/><path d="${bmOpenPath(tracePts(-1))}" ${traceAttrs}/>`;
  }

  // Hairline callouts: measured sites only, values in the display unit, plus
  // the move since the previous tape (falling back to the ~6-month trend
  // arrow). Right rail = torso + legs, left rail = neck/shoulder/arms; a
  // spacing pass keeps labels from colliding.
  type Callout = { side: "L" | "R"; segY: number; x1: number; name: string; val: string; dir: string; d?: number | null; site?: BmSiteKey; accent?: boolean; sage?: boolean };
  // Only moving sites get an arrow — a "steady →" glyph next to a leader line
  // reads as pointing at the figure.
  const arrow = (k: string) => {
    const d = inp.dirs ? inp.dirs[k] : null;
    return d === "down" ? "↓" : d === "up" ? "↑" : "";
  };
  const deltaFor = (k: BmSiteKey): number | null => {
    const d = inp.deltas ? inp.deltas[k] : null;
    return d != null && Number.isFinite(d) ? d : null;
  };
  const cos: Callout[] = [];
  const add = (k: BmSiteKey, side: "L" | "R", segY: number, edge: number, name: string) => {
    if (!measured(k)) return;
    cos.push({ side, segY, x1: side === "R" ? CX + edge + 3 : CX - edge - 3, name, val: dispVal(k), dir: arrow(k), d: deltaFor(k), site: k, accent: k === "waist_in" && inp.focus === "waist" });
  };
  add("chest_in", "R", 71, chestR, "chest");
  add("waist_in", "R", 106, waistR, "waist");
  if (showOpt) cos.push({ side: "R", segY: 112, x1: CX + optR + 2, name: "optimal", val: bmFmt(inp.unit === "cm" ? (optWaistIn as number) * 2.54 : (optWaistIn as number)), dir: "", sage: true });
  add("hip_in", "R", 131, hipR, "hip");
  add("thigh_in", "R", 159, thighCx + thighR, "thigh");
  add("calf_in", "R", 205, kneeCx + calfR, "calf");
  add("neck_in", "L", 46, neckW + 1, "neck");
  add("shoulder_in", "L", 60, shR + 1.5, "shoulder");
  add("upper_arm_in", "L", 76, ax(76) + armR, "arm");
  add("forearm_in", "L", 114, ax(114) + foreR, "forearm");

  // A move since the last tape reads as "↓1.5" next to the value; without one,
  // the 6-month trend arrow stands in. Thresholds keep tape noise quiet.
  const moveThresh = inp.unit === "cm" ? 0.5 : 0.2;
  let callouts = "";
  for (const side of ["L", "R"] as const) {
    const rail = cos.filter((c) => c.side === side).sort((a, b) => a.segY - b.segY);
    let prevY = 6;
    for (const c of rail) {
      const y = Math.min(232, Math.max(prevY + 14, c.segY));
      prevY = y;
      const tx = side === "R" ? 254 : 86;
      const lineEnd = side === "R" ? tx - 4 : tx + 4;
      const color = c.accent ? BM_FIG_ACCENT : c.sage ? BM_FIG_SAGE_DEEP : BM_FIG_INK;
      const nameColor = c.accent ? BM_FIG_ACCENT : c.sage ? BM_FIG_SAGE_DEEP : BM_FIG_MUTED;
      const tail = c.d != null && Math.abs(c.d) >= moveThresh
        ? `<tspan dx="3" font-size="8.5" fill="${BM_FIG_MUTED}">${c.d < 0 ? "↓" : "↑"}${escHtml(bmFmt(Math.abs(c.d)))}</tspan>`
        : c.dir
          ? `<tspan dx="2" font-size="9.5" fill="${BM_FIG_MUTED}">${escHtml(c.dir)}</tspan>`
          : "";
      callouts += `<line x1="${c.x1}" y1="${c.segY}" x2="${lineEnd}" y2="${y - 3}" stroke="${BM_FIG_LINE}" stroke-width="1" stroke-dasharray="1.5 2.5"/>`;
      const label = `<text x="${tx}" y="${y}" text-anchor="${side === "R" ? "start" : "end"}" font-family="ui-sans-serif, system-ui, sans-serif"><tspan font-size="8.2" letter-spacing="0.08em" fill="${nameColor}"${c.sage ? ` font-style="italic"` : ""}>${escHtml(c.name.toUpperCase())}</tspan><tspan dx="4" font-size="11.5" font-weight="600" font-family="ui-serif, Georgia, serif" fill="${color}">${escHtml(c.val)}</tspan>${tail}</text>`;
      // Measured-site callouts tap through to that site's trend row; the
      // transparent rect gives the small SVG text a finger-sized hit area.
      callouts += c.site
        ? `<g class="bm-co" data-site="${escAttr(c.site)}" role="button" tabindex="0" aria-label="See the ${escAttr(c.name)} trend" style="cursor:pointer"><rect x="${side === "R" ? tx - 2 : tx - 88}" y="${y - 11}" width="90" height="15" fill="transparent"/>${label}</g>`
        : label;
    }
  }

  const measuredList = cos.filter((c) => !c.sage).map((c) => `${c.name} ${c.val}`).join(", ");
  const aria = measuredList
    ? `Your body drawn from the tape: ${measuredList} ${inp.unit}${showOpt ? `; the dashed line traces the optimal waist for your height, about ${bmFmt(inp.unit === "cm" ? (optWaistIn as number) * 2.54 : (optWaistIn as number))} ${inp.unit}` : ""}.`
    : "A body figure — log a tape session and it redraws to your measurements.";

  return `<svg class="bm-figure" viewBox="0 0 340 240" width="100%" role="img" aria-label="${escAttr(aria)}" style="display:block;max-width:420px;margin:0 auto">
    <defs>
      <linearGradient id="bmfig-base" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e7ddcb"/><stop offset="100%" stop-color="#dbcfb8"/></linearGradient>
      <clipPath id="bmfig-clip-core"><path d="${corePath}"/></clipPath>
      <clipPath id="bmfig-clip-arms"><path d="${armPath(-1)}"/><path d="${armPath(1)}"/></clipPath>
      ${glowDefs}
    </defs>
    <g stroke="${BM_FIG_LINE}" stroke-width="1.1">${body}</g>
    ${tintLayer}${optTrace}${marks}${callouts}
  </svg>`;
}

// Map the deterministic focus lever + per-site trends onto body regions: a
// central-fat lever points at the waist; a muscle site growing while the waist
// holds reads as a win in that region (recomposition, not just gaining
// everywhere).
function deriveFigureRegions(comp: BmComp, trends: BmSummary["trends"] | undefined): { focus: string | null; wins: string[] } {
  const fk = comp.focus?.key;
  const focus = fk === "whtr" || fk === "whr" || fk === "bodyfat" ? "waist" : null;
  const sites = trends?.sites || [];
  const dir = (k: string) => sites.find((s) => s.key === k)?.direction || null;
  const wins: string[] = [];
  if (dir("waist_in") !== "up") {
    if (dir("upper_arm_in") === "up" || dir("forearm_in") === "up") wins.push("arms");
    if (dir("thigh_in") === "up" || dir("calf_in") === "up") wins.push("legs");
    if (dir("chest_in") === "up" || dir("shoulder_in") === "up") wins.push("chest");
  }
  return { focus, wins };
}

// --- where you stand: the hero card ---------------------------------------------
// Everything the figure needs, computed once — compSection paints the final
// frame with it, and wire() reuses it to run the then→now morph.
interface BmFigureModel {
  merged: BmMeasurement | null;
  prev: BmMeasurement | null;
  deltas: Record<string, number | null>;
  base: Omit<BmFigureInput, "latest" | "deltas">;
}
function figureModel(data: BmSummary, unit: BmUnit): BmFigureModel {
  const { focus, wins } = data.comp ? deriveFigureRegions(data.comp, data.trends) : { focus: null, wins: [] as string[] };
  const dirs: Record<string, "up" | "down" | "steady" | null> = {};
  for (const t of data.trends?.sites || []) dirs[t.key] = t.direction;
  const merged = mergeLatestSites(data.measurements, data.latest);
  const prev = mergePreviousSites(data.measurements, data.latest);
  const deltas: Record<string, number | null> = {};
  for (const k of BM_SITE_KEYS) {
    const a = prev ? (prev[k] as number | null) : null;
    const b = merged ? (merged[k] as number | null) : null;
    deltas[k] = a != null && b != null ? Math.round((b - a) * 10) / 10 : null;
  }
  return {
    merged,
    prev,
    deltas,
    base: { heightIn: data.profile?.height_in ?? null, sex: data.profile?.sex || "male", unit, focus, wins, dirs },
  };
}

// ================= the elite Stand hero (design option 2b) =======================
// A FIXED reference figure (the vendored CairnBodyFigure) whose measurement sites
// you tap to read against a reference physique scaled to YOUR height — the waist
// ≤ half-height chalk trace, a per-site "where you stand vs reference" detail
// panel, and the reference-physique rows. When the library is absent the legacy
// tape-driven croquis (bodyFigureSvg, above) still draws — nothing regresses.

// The vendored figure lib (public/cairn-body-figure.js). Guarded like art().
function bmFigureLib(): CairnBodyFigureApi | null {
  try {
    return (window as unknown as { CairnBodyFigure?: CairnBodyFigureApi }).CairnBodyFigure || null;
  } catch {
    return null;
  }
}

// Which measurement site is being read (module state so a tap survives a repaint).
let bmSelectedSite: BmSiteKey | null = null;

// Library callout site name -> our tape key, and each key's short label.
const BM_STAND_SITE_OF: Record<string, BmSiteKey> = {
  neck: "neck_in", shoulder: "shoulder_in", arm: "upper_arm_in", forearm: "forearm_in",
  chest: "chest_in", waist: "waist_in", hip: "hip_in", thigh: "thigh_in", calf: "calf_in",
};
const BM_SITE_LABEL: Record<BmSiteKey, string> = {
  neck_in: "neck", shoulder_in: "shoulder", chest_in: "chest", waist_in: "waist", hip_in: "hip",
  thigh_in: "thigh", upper_arm_in: "arm", forearm_in: "forearm", calf_in: "calf",
};

function bmCap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// Height as 5′11″ (inches) or 180 cm (metric) for the reference-physique header.
function bmHeightLabel(heightIn: number, unit: BmUnit): string {
  if (unit === "cm") return `${Math.round(heightIn * 2.54)} cm`;
  const ft = Math.floor(heightIn / 12);
  const rem = Math.round(heightIn - ft * 12);
  return `${ft}′${rem}″`;
}

// Evidence-lite reference physique (inches), scaled to height — presented as
// references, not mandates. waist ≤ half height; shoulder ≈ 1.4–1.6× reference
// waist; chest ≈ 1.35×; arm ≈ calf; the rest from athletic proportion. Sex-aware.
function bmReferencePhysique(heightIn: number, female: boolean, calfIn: number | null): Record<BmSiteKey, number> {
  const h = Math.min(90, Math.max(48, heightIn));
  const waist = (female ? 0.47 : 0.5) * h;
  const shoulder = (female ? 1.4 : 1.5) * waist;
  const chest = (female ? 1.28 : 1.35) * waist;
  const hip = (female ? 1.28 : 1.12) * waist;
  const arm = calfIn != null && calfIn > 0 ? calfIn : (female ? 0.3 : 0.34) * waist;
  const forearm = (female ? 0.8 : 0.82) * arm;
  const thigh = (female ? 0.62 : 0.58) * waist;
  const calf = calfIn != null && calfIn > 0 ? calfIn : arm;
  return { neck_in: arm, shoulder_in: shoulder, chest_in: chest, waist_in: waist, hip_in: hip, thigh_in: thigh, upper_arm_in: arm, forearm_in: forearm, calf_in: calf };
}

// Reference weight (lb) from FFMI at a lean body-fat — a target, not a mandate.
function bmReferenceWeightLb(heightIn: number, female: boolean): number {
  const hM = Math.min(90, Math.max(48, heightIn)) * 0.0254;
  const ffmi = female ? 18.5 : 21.5;
  const bf = female ? 0.235 : 0.135;
  const kg = (ffmi * hM * hM) / (1 - bf);
  return Math.round(kg * 2.20462);
}

interface BmStandModel {
  merged: BmMeasurement | null;
  female: boolean;
  heightIn: number | null;
  unit: BmUnit;
  focus: string | null;
  reference: Record<BmSiteKey, number> | null;
  refWeightLb: number | null;
  weightLb: number | null;
}

function bmStandModel(data: BmSummary, unit: BmUnit): BmStandModel {
  const merged = mergeLatestSites(data.measurements, data.latest);
  const female = String(data.profile?.sex || "").toLowerCase() === "female";
  const heightIn = data.profile?.height_in ?? null;
  const focus = data.comp ? deriveFigureRegions(data.comp, data.trends).focus : null;
  const calfRaw = merged && merged.calf_in != null ? (merged.calf_in as number) : null;
  const calfIn = calfRaw != null ? (unit === "cm" ? calfRaw / 2.54 : calfRaw) : null;
  return {
    merged,
    female,
    heightIn,
    unit,
    focus,
    reference: heightIn != null ? bmReferencePhysique(heightIn, female, calfIn) : null,
    refWeightLb: heightIn != null ? bmReferenceWeightLb(heightIn, female) : null,
    weightLb: data.profile?.weight_lb ?? null,
  };
}

// The first site to read: a held selection (still measured), else the deterministic
// focus, else the first measured site top-to-bottom.
function bmResolveSelected(model: BmStandModel): BmSiteKey | null {
  const measured = (k: BmSiteKey) => !!model.merged && (model.merged[k] as number | null) != null;
  if (bmSelectedSite && measured(bmSelectedSite)) return bmSelectedSite;
  if (model.focus === "waist" && measured("waist_in")) return "waist_in";
  const order: BmSiteKey[] = ["chest_in", "waist_in", "shoulder_in", "upper_arm_in", "hip_in", "thigh_in", "calf_in", "neck_in", "forearm_in"];
  for (const k of order) if (measured(k)) return k;
  return null;
}

type BmRefDir = "under" | "over" | "at";
const BM_SITE_WHY: Record<string, Record<BmRefDir, string>> = {
  waist_in: {
    over: "A waist nearer half your height is the biggest single lever on how lean you read.",
    under: "Leaner than the reference waist for your height — right where you want it.",
    at: "At the reference waist for your height.",
  },
  chest_in: {
    under: "Room to build — a chest near 1.35× your reference waist reads powerful.",
    over: "Strong — chest at or beyond its reference proportion.",
    at: "At its reference proportion for your frame.",
  },
  shoulder_in: {
    under: "Width to gain — broad shoulders (~1.5× your reference waist) define the V-taper.",
    over: "Broad — shoulders at or beyond their reference width.",
    at: "At their reference width for your frame.",
  },
  upper_arm_in: {
    under: "Room to build — arms track your calf; they grow together.",
    over: "Arms at or beyond their reference (about your calf).",
    at: "At their reference — about your calf.",
  },
  hip_in: {
    over: "Hips a touch over the athletic reference; trimming the waist usually pulls this in too.",
    under: "In proportion with your frame.",
    at: "In proportion with your frame.",
  },
};
function bmSiteWhy(key: BmSiteKey, dir: BmRefDir): string {
  const m = BM_SITE_WHY[key];
  if (m) return m[dir];
  return dir === "under"
    ? "Room to build toward its reference for your frame."
    : dir === "over"
      ? "At or beyond its reference proportion."
      : "At its reference proportion for your frame.";
}

type BmChipTone = "sage" | "warn" | "gold" | "muted";
function bmChip(text: string, tone: BmChipTone): string {
  const map: Record<BmChipTone, string> = {
    sage: "background:#e7ecdd;color:#5f6e4f",
    warn: "background:#f3e0d8;color:#a3402a",
    gold: "background:#efe6d0;color:#8a6d2e",
    muted: "background:#efe7d8;color:#746c5c",
  };
  return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font:600 9.5px ui-sans-serif,system-ui,sans-serif;letter-spacing:.03em;${map[tone]}">${escHtml(text)}</span>`;
}

// Read a site's measured value (inches) against its reference (inches): the chip
// tone + word, and a plain-language why. Lower is better for waist/hip; higher for
// the muscle sites. A neutral ±6% band reads "at reference".
function bmSiteRead(key: BmSiteKey, vIn: number, rIn: number): { dir: BmRefDir; chip: { text: string; tone: BmChipTone }; why: string } {
  const dev = rIn > 0 ? (vIn - rIn) / rIn : 0;
  const lowerBetter = key === "waist_in" || key === "hip_in";
  let dir: BmRefDir;
  let tone: BmChipTone;
  let text: string;
  if (Math.abs(dev) <= 0.06) {
    dir = "at";
    tone = "sage";
    text = "at reference";
  } else if (dev > 0) {
    dir = "over";
    tone = lowerBetter ? "warn" : "sage";
    text = "over reference";
  } else {
    dir = "under";
    tone = lowerBetter ? "sage" : "gold";
    text = "under reference";
  }
  return { dir, chip: { text, tone }, why: bmSiteWhy(key, dir) };
}

// The elite Stand figure: fixed silhouette + selected-site glow + reference-waist
// chalk trace + tappable measurement callouts. Coordinates: the library figure is
// authored in a 0–260 space; a translate(80,0) group centers it in a 420-wide box,
// leaving label rails on both sides. Callouts are drawn in the outer box space.
function bmStandFigureSvg(lib: CairnBodyFigureApi, model: BmStandModel, selected: BmSiteKey | null): string {
  const sexKey = model.female ? "female" : "male";
  const sil = lib.silhouette(sexKey);
  const col = lib.COLORS;
  const merged = model.merged;
  const rawVal = (k: BmSiteKey): number | null => {
    const raw = merged ? (merged[k] as number | null) : null;
    return raw != null && Number.isFinite(raw) ? raw : null;
  };
  const measured = (k: BmSiteKey) => rawVal(k) != null;
  const inchOf = (k: BmSiteKey): number | null => {
    const v = rawVal(k);
    return v == null ? null : model.unit === "cm" ? v / 2.54 : v;
  };
  const dispVal = (k: BmSiteKey): string => bmFmt(rawVal(k) as number);
  const ref = model.reference;

  // Selected-site glow, tinted by whether the value sits the unhelpful way off
  // reference (waist over → terracotta; a muscle under → gold; otherwise sage).
  const gradFor = (k: BmSiteKey): string => {
    const vi = inchOf(k);
    const r = ref ? ref[k] : null;
    if (vi == null || r == null) return "bmfig2-sage";
    const lowerBetter = k === "waist_in" || k === "hip_in";
    if (lowerBetter) return vi > r * 1.02 ? "bmfig2-warn" : "bmfig2-sage";
    return vi < r * 0.97 ? "bmfig2-gold" : "bmfig2-sage";
  };
  let washes = "";
  if (selected) {
    const name = Object.keys(BM_STAND_SITE_OF).find((n) => BM_STAND_SITE_OF[n] === selected);
    const glows = name ? lib.GLOWS[name] : null;
    if (glows) {
      const grad = gradFor(selected);
      const clipOf = (c: string) => (c === "aR" ? "bmfig2-clip-aR" : c === "aL" ? "bmfig2-clip-aL" : "bmfig2-clip-t");
      for (const [cx, cy, rx, ry, clip] of glows) {
        washes += `<g clip-path="url(#${clipOf(clip)})"><ellipse class="bm-pulse" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${grad})"/></g>`;
      }
    }
  }

  // The reference-waist chalk trace, only when the waist is measured and above it.
  const waistIn = inchOf("waist_in");
  const refWaist = ref ? ref.waist_in : null;
  let optTrace = "";
  if (waistIn != null && refWaist != null && waistIn > refWaist + 0.2) {
    const attrs = `fill="none" stroke="#5a6a4a" stroke-width="1.7" stroke-dasharray="4.5 3.5" stroke-linecap="round" opacity="0.9"`;
    optTrace = `<path d="${lib.waistTrace(sexKey, 1)}" ${attrs}/><path d="${lib.waistTrace(sexKey, -1)}" ${attrs}/>`;
  }

  const group = `<g transform="translate(80,0)">
      <path d="${sil.armL}" fill="${col.standFill}" stroke="${col.standLine}" stroke-width="1.3"/>
      <path d="${sil.armR}" fill="${col.standFill}" stroke="${col.standLine}" stroke-width="1.3"/>
      <path d="${sil.torso}" fill="${col.standFill}" stroke="${col.standLine}" stroke-width="1.3"/>
      ${washes}${optTrace}
    </g>`;

  // Callouts: leader line + dot from the body anchor out to a label rail, wrapped
  // in a finger-sized tap target that selects the site.
  type CO = { key: BmSiteKey; side: "L" | "R"; segY: number; ax: number; ay: number };
  const cos: CO[] = [];
  for (const c of lib.CALLOUTS) {
    const key = BM_STAND_SITE_OF[c.site];
    if (!key || !measured(key)) continue;
    const [wx, wy] = lib.warpPoint(c.pt, sexKey);
    cos.push({ key, side: c.side, segY: c.y, ax: 80 + wx, ay: wy });
  }
  let callouts = "";
  for (const side of ["L", "R"] as const) {
    const rail = cos.filter((c) => c.side === side).sort((a, b) => a.segY - b.segY);
    let prevY = 40;
    for (const c of rail) {
      const y = Math.min(628, Math.max(prevY + 30, c.segY));
      prevY = y;
      const tx = side === "R" ? 348 : 72;
      const lineEnd = side === "R" ? tx - 5 : tx + 5;
      const sel = c.key === selected;
      const anchor = side === "R" ? "start" : "end";
      callouts += `<line x1="${bmR(c.ax)}" y1="${bmR(c.ay)}" x2="${lineEnd}" y2="${y}" stroke="${sel ? "#c98b5e" : "#c4b89d"}" stroke-width="1.3" stroke-dasharray="1.5 4" stroke-linecap="round"/>`;
      callouts += `<circle cx="${bmR(c.ax)}" cy="${bmR(c.ay)}" r="2" fill="${sel ? "#b4552d" : "#c4b89d"}"/>`;
      const label = `<text x="${tx}" y="${y + 3.5}" text-anchor="${anchor}" font-family="ui-sans-serif, system-ui, sans-serif"><tspan font-size="8.5" letter-spacing="0.1em" fill="${sel ? "#b4552d" : "#a99c82"}">${escHtml(BM_SITE_LABEL[c.key].toUpperCase())}</tspan><tspan dx="5" font-size="13" font-weight="600" font-family="ui-serif, Georgia, serif" fill="${sel ? "#b4552d" : "#211d17"}">${escHtml(dispVal(c.key))}</tspan></text>`;
      const hitX = side === "R" ? tx - 4 : tx - 92;
      callouts += `<g class="bm-co2" data-site="${escAttr(c.key)}" role="button" tabindex="0" aria-label="Read your ${escAttr(BM_SITE_LABEL[c.key])} against its reference"${sel ? ` aria-current="true"` : ""} style="cursor:pointer"><rect x="${hitX}" y="${y - 10}" width="96" height="18" fill="transparent"/>${label}</g>`;
    }
  }

  const measuredList = cos.map((c) => `${BM_SITE_LABEL[c.key]} ${dispVal(c.key)}`).join(", ");
  const aria = measuredList
    ? `Your measurements on a reference figure: ${measuredList} ${model.unit}. Tap a measurement to read it against your reference.`
    : "A reference body figure — log a tape session and your measurements appear as tappable callouts.";
  const defs = `<defs>
      <radialGradient id="bmfig2-warn"><stop offset="0%" stop-color="#b4552d" stop-opacity="0.32"/><stop offset="62%" stop-color="#b4552d" stop-opacity="0.15"/><stop offset="100%" stop-color="#b4552d" stop-opacity="0"/></radialGradient>
      <radialGradient id="bmfig2-sage"><stop offset="0%" stop-color="#6e7f5c" stop-opacity="0.30"/><stop offset="62%" stop-color="#6e7f5c" stop-opacity="0.14"/><stop offset="100%" stop-color="#6e7f5c" stop-opacity="0"/></radialGradient>
      <radialGradient id="bmfig2-gold"><stop offset="0%" stop-color="#c9a86a" stop-opacity="0.40"/><stop offset="62%" stop-color="#c9a86a" stop-opacity="0.18"/><stop offset="100%" stop-color="#c9a86a" stop-opacity="0"/></radialGradient>
      <clipPath id="bmfig2-clip-t"><path d="${sil.torso}"/></clipPath>
      <clipPath id="bmfig2-clip-aR"><path d="${sil.armR}"/></clipPath>
      <clipPath id="bmfig2-clip-aL"><path d="${sil.armL}"/></clipPath>
    </defs>`;
  return `<svg class="bm-figure bm-figure2" viewBox="0 0 420 645" width="100%" role="img" aria-label="${escAttr(aria)}" style="display:block;max-width:440px;margin:0 auto;overflow:visible">${defs}${group}${callouts}</svg>`;
}

// The selected-site detail panel: your value vs its reference, an under/reference/
// over position bar, and a plain-language read.
function bmStandDetail(model: BmStandModel, selected: BmSiteKey | null, unit: BmUnit): string {
  const wrap = (inner: string) =>
    `<div class="bm-detail" style="margin-top:12px;background:#f8f3e8;border:1px solid #e7dfd2;border-radius:14px;padding:14px 16px 13px">${inner}</div>`;
  if (!selected) return wrap(`<div class="sess-line" style="color:var(--muted,#746c5c)">Tap a measurement on the figure to read it against your reference.</div>`);
  const cur = model.merged ? (model.merged[selected] as number | null) : null;
  const name = bmCap(BM_SITE_LABEL[selected]);
  if (cur == null) {
    return wrap(`<div style="display:flex;align-items:baseline;gap:9px"><span style="font:600 16px ui-serif,Georgia,serif;color:#211d17">${escHtml(name)}</span>${bmChip("not taped", "muted")}</div>
      <div class="sess-line" style="color:var(--muted,#746c5c);margin-top:6px">Tape this site and it reads against its reference here.</div>`);
  }
  const rIn = model.reference ? model.reference[selected] : null;
  const curIn = unit === "cm" ? cur / 2.54 : cur;
  const read = rIn != null ? bmSiteRead(selected, curIn, rIn) : null;
  const refDisp = rIn != null ? bmFmt(unit === "cm" ? rIn * 2.54 : rIn) : null;
  const dev = rIn != null && rIn > 0 ? (curIn - rIn) / rIn : 0;
  const pct = bmR(Math.min(97, Math.max(3, 50 + dev * 240)));
  const chip = read ? bmChip(read.chip.text, read.chip.tone) : bmChip("logged", "muted");
  const bar = rIn != null
    ? `<div style="position:relative;height:6px;border-radius:3px;background:#efe7d8;margin:12px 0 4px"><span style="position:absolute;left:36%;width:28%;top:0;bottom:0;background:#dfe4d2;border-radius:3px"></span><span style="position:absolute;top:-2px;left:${pct}%;width:10px;height:10px;border-radius:50%;background:#211d17;transform:translateX(-50%);box-shadow:0 0 0 2px #fffdf8"></span></div>
      <div style="display:flex;justify-content:space-between;font:600 9px ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;color:#a99c82"><span>UNDER</span><span>REFERENCE</span><span>OVER</span></div>`
    : "";
  const refCol = refDisp != null
    ? `<span style="font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#746c5c">${escHtml(unit)} · reference</span><span style="font:italic 600 16px ui-serif,Georgia,serif;color:#5f6e4f">${escHtml(refDisp)}</span>`
    : `<span style="font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#746c5c">${escHtml(unit)}</span>`;
  return wrap(`<div style="display:flex;align-items:baseline;gap:9px"><span style="font:600 16px ui-serif,Georgia,serif;color:#211d17">${escHtml(name)}</span>${chip}</div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:7px"><span style="font:600 22px ui-serif,Georgia,serif;color:#211d17">${escHtml(bmFmt(cur))}</span>${refCol}</div>
    ${bar}
    ${read ? `<div style="font:400 12.5px/1.55 ui-sans-serif,system-ui,sans-serif;color:#57503f;margin-top:9px">${escHtml(read.why)}</div>` : ""}`);
}

// Reference-physique rows: current → target, scaled to height. References, not
// mandates. Silent until height is known (the height form prompts for it).
function bmStandRefRows(model: BmStandModel, unit: BmUnit): string {
  const ref = model.reference;
  if (!ref || model.heightIn == null) return "";
  const conv = (inch: number) => (unit === "cm" ? inch * 2.54 : inch);
  const rowHtml = (label: string, cur: string, tgt: string, chip: string) =>
    `<div style="display:flex;align-items:baseline;gap:10px;padding:7px 2px;border-bottom:1px solid #f2ecdf">
      <span style="flex:0 0 78px;font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;color:#746c5c">${escHtml(label)}</span>
      <span style="font:560 14.5px ui-serif,Georgia,serif;color:#211d17">${escHtml(cur)}</span>
      <span style="color:#c0b6a0;font-size:12px">→</span>
      <span style="font:italic 600 14.5px ui-serif,Georgia,serif;color:#5f6e4f">${escHtml(tgt)}</span>${chip}</div>`;
  const siteRow = (key: BmSiteKey, label: string): string => {
    const tgtIn = ref[key];
    const cur = model.merged ? (model.merged[key] as number | null) : null;
    const curIn = cur != null ? (unit === "cm" ? cur / 2.54 : cur) : null;
    const chip = curIn != null ? (() => { const r = bmSiteRead(key, curIn, tgtIn); return bmChip(r.chip.text, r.chip.tone); })() : "";
    return rowHtml(label, cur != null ? bmFmt(cur) : "—", bmFmt(conv(tgtIn)), chip);
  };
  const rows = [
    siteRow("shoulder_in", "SHOULDER"),
    siteRow("chest_in", "CHEST"),
    siteRow("waist_in", "WAIST"),
    siteRow("hip_in", "HIP"),
    siteRow("upper_arm_in", "ARM"),
  ];
  if (model.refWeightLb != null) {
    const w = model.weightLb;
    const dev = w != null ? (w - model.refWeightLb) / model.refWeightLb : null;
    const chip = dev == null
      ? ""
      : Math.abs(dev) <= 0.04
        ? bmChip("at reference", "sage")
        : dev > 0
          ? bmChip("over", "warn")
          : bmChip("under", "gold");
    rows.push(rowHtml("WEIGHT", w != null ? `${bmFmt(w)}` : "—", `${model.refWeightLb} lb`, chip));
  }
  const bfNote = model.female ? "FFMI 18–19 at 22–25% body fat" : "FFMI 21–22 at 12–15% body fat";
  return `<div class="bm-ref" style="margin-top:16px">
      <div style="font:700 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#746c5c">Reference physique · ${escHtml(bmHeightLabel(model.heightIn, unit))}</div>
      <div style="margin-top:6px">${rows.join("")}</div>
      <div style="font:400 11.5px/1.55 ui-sans-serif,system-ui,sans-serif;color:#a99c82;margin-top:9px">References, not mandates — waist ≤ half height, shoulder ≈ 1.4–1.6× reference waist, arm ≈ calf, weight from ${bfNote}.</div>
    </div>`;
}

function compSection(data: BmSummary, unit: BmUnit): string {
  const comp = data.comp;
  if (!comp) return "";
  const model = bmStandModel(data, unit);
  const selected = bmResolveSelected(model);
  const lib = bmFigureLib();
  const figure = lib
    ? bmStandFigureSvg(lib, model, selected)
    : bodyFigureSvg({ latest: model.merged, deltas: {}, heightIn: model.heightIn, sex: model.female ? "female" : "male", unit, focus: model.focus, wins: [], dirs: {} });
  const sub = data.latest
    ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.82rem;margin-top:2px">Tap a measurement to read it against your reference.</div>`
    : `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.82rem;margin-top:2px">Log your first tape session above and the figure fills in with your numbers.</div>`;
  const heading = comp.heading
    ? `<div class="sess-line bm-heading" style="color:var(--ink-2,#57503f);margin-top:10px">${escHtml(comp.heading)}</div>`
    : "";
  const focus = comp.focus
    ? `<div class="bm-focus" style="border-left:3px solid var(--accent,#b4552d);background:var(--accent-wash,rgba(180,85,45,.1));border-radius:8px;padding:10px 12px;margin-top:12px">
        <div style="font-weight:600;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--accent,#b4552d);margin-bottom:3px">Where to point it</div>
        <div class="sess-line">${escHtml(comp.focus.line)}</div>
      </div>`
    : "";
  const detail = data.latest ? bmStandDetail(model, selected, unit) : "";
  return `<div class="sess bm-comp reveal" style="padding:16px 14px;margin-bottom:12px">
      <div class="bm-sechead" style="font-weight:600;margin-bottom:2px">Where you stand</div>
      ${sub}${heading}
      <div class="bm-figure-slot" style="margin-top:8px">${figure}</div>
      ${detail}${focus}
      ${bmStandRefRows(model, unit)}
    </div>`;
}

// Re-render just the Stand hero from cached data (a selection tap must not blow
// away the log form's in-progress inputs), then re-wire its callout taps.
function bmRepaintStandHero(mount: HTMLElement, data: BmSummary, unit: BmUnit): void {
  const card = mount.querySelector(".bm-comp");
  if (!card) return;
  const holder = document.createElement("div");
  holder.innerHTML = compSection(data, unit);
  const fresh = holder.firstElementChild as HTMLElement | null;
  if (!fresh) return;
  fresh.classList.remove("reveal"); // a re-select shouldn't replay the entrance
  card.replaceWith(fresh);
  bmWireStandHero(mount, data, unit);
}

// Tap/enter a callout on the elite figure → select that site and repaint the hero.
function bmWireStandHero(mount: HTMLElement, data: BmSummary, unit: BmUnit): void {
  const card = mount.querySelector(".bm-comp");
  if (!card) return;
  const coOf = (e: Event): HTMLElement | null => {
    const t = e.target as Element | null;
    return t && typeof t.closest === "function" ? (t.closest(".bm-co2") as HTMLElement | null) : null;
  };
  const select = (site: string) => {
    if (!(BM_SITE_KEYS as readonly string[]).includes(site)) return;
    bmSelectedSite = site as BmSiteKey;
    bmRepaintStandHero(mount, data, unit);
    const el = mount.querySelector(`.bm-co2[data-site="${site}"]`) as HTMLElement | null;
    if (el && typeof el.focus === "function") el.focus();
  };
  card.addEventListener("click", (e) => {
    const g = coOf(e);
    if (g) select(g.dataset.site || "");
  });
  card.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key !== "Enter" && key !== " ") return;
    const g = coOf(e);
    if (g) {
      e.preventDefault();
      select(g.dataset.site || "");
    }
  });
}

// --- the numbers: zone bars with the reads folded in ----------------------------
// Each indicator drawn on its plain-language bands: the optimal band reads
// stronger, a solid dot marks today, a dashed hollow dot marks where the current
// pace lands in ~12 weeks. Words and position, never a score.
function zoneBarSvg(s: BmScale): string {
  const W = 300;
  const H = 26;
  const PAD = 8;
  const barY = 6;
  const barH = 8;
  const span = s.max - s.min || 1;
  const x = (v: number) => PAD + ((Math.min(s.max, Math.max(s.min, v)) - s.min) / span) * (W - PAD * 2);
  const segs = s.bands
    .map((b) => {
      const color = BM_TONE_COLOR[b.tone] || BM_TONE_COLOR.info;
      const isOpt = b.from >= s.optimal.from && b.to <= s.optimal.to;
      return `<rect x="${x(b.from)}" y="${barY}" width="${Math.max(1, x(b.to) - x(b.from))}" height="${barH}" rx="2" fill="${color}" opacity="${isOpt ? "0.55" : "0.22"}"/>`;
    })
    .join("");
  const optMid = x((s.optimal.from + s.optimal.to) / 2);
  const optLabel = `<text x="${optMid}" y="${barY + barH + 11}" text-anchor="middle" font-size="9" fill="${BM_TONE_TEXT.ok}" font-weight="600">optimal</text>`;
  let proj = "";
  if (s.projected != null && s.value != null && Math.abs(s.projected - s.value) > span / 100) {
    const x1 = x(s.value);
    const x2 = x(s.projected);
    proj = `<line x1="${x1}" y1="${barY + barH / 2}" x2="${x2}" y2="${barY + barH / 2}" stroke="var(--ink,#211d17)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.55"/>
      <circle cx="${x2}" cy="${barY + barH / 2}" r="4" fill="var(--card,#fffdf8)" stroke="var(--ink,#211d17)" stroke-width="1.4" stroke-dasharray="2 2"/>`;
  }
  const cur = s.value != null ? `<circle cx="${x(s.value)}" cy="${barY + barH / 2}" r="4.5" fill="var(--ink,#211d17)"/>` : "";
  const aria = `${s.label}: ${s.value != null ? `${s.value}${s.unit || ""}` : "not measured"}${s.projected != null ? `, heading to about ${s.projected}${s.unit || ""} in ${s.horizon_weeks} weeks at the current pace` : ""}`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${escAttr(aria)}" style="display:block">${segs}${optLabel}${proj}${cur}</svg>`;
}

function zoneRow(s: BmScale, ind: BmIndicator | undefined, i: number): string {
  const divider = i > 0 ? "border-top:1px solid var(--line,#e7dfd2);" : "";
  const est = s.estimate ? `<span style="color:var(--muted,#746c5c);font-size:.72rem"> · estimate</span>` : "";
  if (s.value == null) {
    const read = ind?.read || "";
    return `<div class="bm-zone-row" style="${divider}padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-weight:600;color:var(--muted,#746c5c)">${escHtml(s.label)}${est}</span>
        <span style="color:var(--muted,#746c5c)">—</span>
      </div>
      ${read ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.8rem;margin-top:2px">${escHtml(read)}</div>` : ""}
    </div>`;
  }
  const band = s.bands.find((b) => (s.value as number) >= b.from && (s.value as number) < b.to) || s.bands[s.bands.length - 1];
  const color = BM_TONE_TEXT[band?.tone || "info"];
  return `<div class="bm-zone-row" style="${divider}padding:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-weight:600">${escHtml(s.label)}${est}</span>
        <span style="display:inline-flex;align-items:baseline;gap:7px"><span style="font-family:var(--font-display, ui-serif, Georgia, serif);font-size:1.05rem;font-weight:620">${escHtml(String(s.value))}${escHtml(s.unit || "")}</span><span style="color:${color};font-size:.78rem;font-weight:600">${escHtml(band?.label || "")}</span></span>
      </div>
      ${zoneBarSvg(s)}
      ${s.read ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.8rem;margin-top:4px">${escHtml(s.read)}</div>` : ""}
    </div>`;
}

function numbersSection(data: BmSummary): string {
  const comp = data.comp;
  if (!comp || !comp.scales.length) return "";
  const byKey: Record<string, BmIndicator> = Object.fromEntries((data.indicators || []).map((i) => [i.key, i]));
  const rows = comp.scales.map((s, i) => zoneRow(s, byKey[s.key], i)).join("");
  const hasProjection = comp.scales.some((s) => s.value != null && s.projected != null);
  const legend = `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.74rem;margin-top:2px">● now${hasProjection ? ` · ◌ in ~12 weeks at your current pace` : ""}</div>`;
  return `<div class="sess bm-nums reveal" style="padding:12px;margin-bottom:12px">
      <div class="bm-sechead" style="font-weight:600;margin-bottom:2px">The numbers</div>
      ${rows}${legend}
    </div>`;
}

function heightForm(profile: BmSummary["profile"], unit: BmUnit): string {
  const inches = profile.height_in;
  const known = inches != null;
  const intro = `<div style="font-weight:600;margin-bottom:6px">${known ? "Height" : "Set your height"}</div>
      <div class="sess-line" style="color:var(--muted,#746c5c);margin-bottom:8px">${known ? "Used for BMI, waist-to-height and the body-fat estimate." : "BMI, waist-to-height and body-fat need your height."}</div>`;
  if (unit === "cm") {
    const cm = inches != null ? Math.round(inches * 2.54) : "";
    return `<div class="sess bm-height reveal" style="padding:12px">
      ${intro}
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Centimeters</span><input id="bmHeightCm" class="form-input" type="number" inputmode="decimal" min="90" max="250" step="0.5" value="${escAttr(String(cm))}" style="width:7rem"></label>
        <button id="bmHeightSave" class="chip" type="button">Save height</button>
      </div>
    </div>`;
  }
  const ft = inches != null ? Math.floor(inches / 12) : "";
  const rem = inches != null ? Math.round((inches - Math.floor(inches / 12) * 12) * 10) / 10 : "";
  return `<div class="sess bm-height reveal" style="padding:12px">
      ${intro}
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="field" style="margin:0"><span>Feet</span><input id="bmHeightFt" class="form-input" type="number" inputmode="numeric" min="3" max="8" value="${escAttr(String(ft))}" style="width:5rem"></label>
        <label class="field" style="margin:0"><span>Inches</span><input id="bmHeightIn" class="form-input" type="number" inputmode="decimal" min="0" max="11.9" step="0.5" value="${escAttr(String(rem))}" style="width:5rem"></label>
        <button id="bmHeightSave" class="chip" type="button">Save height</button>
      </div>
    </div>`;
}

// --- log a tape session: the top action card -------------------------------------
// One tap from the top of the view (the monthly loop is glance → tape → log, so
// entry never lives below the fold). Collapsed it reads as a single action row
// with "last taped …"; open by default until the first session exists. The small
// ⓘ affordance on each site label — tap (or focus the input) and the shared hint
// line under the intro shows how to place the tape for that site.
function logForm(data: BmSummary, unit: BmUnit): string {
  const sites = data.sites || [];
  // Local calendar day (localISO from date-utils) — a UTC slice would prefill
  // tomorrow's date for an evening tape session west of Greenwich.
  const today = typeof localISO === "function" ? localISO() : new Date().toISOString().slice(0, 10);
  const max = unit === "cm" ? 254 : 100;
  const inputs = sites
    .map((s) => {
      const info = s.hint
        ? `<button type="button" class="bm-info" data-site="${escAttr(s.key)}" data-label="${escAttr(s.label)}" data-hint="${escAttr(s.hint)}" aria-expanded="false" aria-label="How to measure: ${escAttr(s.label)}" style="width:15px;height:15px;border-radius:50%;border:1px solid var(--muted,#746c5c);color:var(--muted,#746c5c);background:transparent;font-size:.6rem;line-height:1;font-style:italic;font-family:var(--font-display,Georgia,serif);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none">i</button>`
        : "";
      return `<label class="field" style="margin:0"><span style="display:inline-flex;align-items:center;gap:5px">${escHtml(s.label)}${info}</span><input class="form-input bm-site" data-site="${escAttr(s.key)}" type="number" inputmode="decimal" min="1" max="${max}" step="0.1" placeholder="${unit}" style="width:100%"></label>`;
    })
    .join("");
  const last = data.latest?.date && typeof relAge === "function"
    ? `<span style="color:var(--muted,#746c5c);font-size:.78rem;font-weight:400">last taped ${escHtml(relAge(data.latest.date))}</span>`
    : "";
  return `<details class="sess bm-log reveal"${data.latest ? "" : " open"} style="padding:0;overflow:hidden">
      <summary style="list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:13px 14px;cursor:pointer">
        <span style="display:inline-flex;align-items:center;gap:8px;font-weight:600;color:var(--accent,#b4552d)"><span aria-hidden="true" style="font-size:1.05rem;line-height:1">＋</span>Log a tape session</span>
        ${last}
      </summary>
      <div style="padding:0 14px 14px">
        <div class="sess-line" style="color:var(--muted,#746c5c);margin:0 0 8px">Tape, relaxed, same time of day. Fill in what you measured — the rest stays blank. Tap ⓘ on any site for where the tape goes.</div>
        <div id="bmSiteHint" class="sess-line" role="status" aria-live="polite" hidden style="margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--sage-bg,#eef0e6);color:var(--ink,#211d17)"></div>
        <div class="bm-site-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr));gap:8px">${inputs}</div>
        <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap">
          <label class="field" style="margin:0"><span>Date</span><input id="bmDate" class="form-input" type="date" value="${escAttr(today)}"></label>
          <label class="field" style="margin:0;flex:1;min-width:9rem"><span>Note</span><input id="bmNote" class="form-input" type="text" placeholder="optional" style="width:100%"></label>
          <button id="bmLogSave" class="chip" type="button">Log session</button>
        </div>
      </div>
    </details>`;
}

function goalMovement(weight: BmTrend, profile: BmSummary["profile"]): string {
  if (profile.goal_weight_lb == null || weight.latest == null) return "";
  const remaining = Math.round((weight.latest - profile.goal_weight_lb) * 10) / 10;
  if (Math.abs(remaining) < 0.5) return `<span class="bm-goal" style="color:var(--sage-text,#5f6e4f)"> · at your goal weight</span>`;
  const dir = remaining > 0 ? "to lose" : "to gain";
  return `<span class="bm-goal" style="color:var(--muted,#746c5c)"> · ${escHtml(String(Math.abs(remaining)))} lb ${dir} to goal</span>`;
}

function trendRow(t: BmTrend, extra = ""): string {
  const spark = t.points.length >= 2 ? `<span class="bm-trend-spark">${sparklineSvg(t.points)}</span>` : "";
  const latest = t.latest != null ? `${escHtml(String(t.latest))} ${escHtml(t.unit)}` : "—";
  const arrow = t.direction === "down" ? "↓" : t.direction === "up" ? "↑" : t.direction === "steady" ? "→" : "";
  return `<div class="sess-line bm-trend-row" data-trend="${escAttr(t.key)}" style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span class="bm-trend-label" style="min-width:6rem;font-weight:600">${escHtml(t.label)}</span>
      <span class="bm-trend-latest" style="min-width:5rem;color:var(--muted,#746c5c)">${latest} ${escHtml(arrow)}</span>
      ${spark}
      <span class="bm-trend-text" style="flex:1;color:var(--muted,#746c5c)">${escHtml(t.text)}${extra}</span>
    </div>`;
}

function unitToggle(unit: BmUnit): string {
  const btn = (u: BmUnit) =>
    `<button type="button" class="chip bm-unit-btn" data-unit="${u}" aria-pressed="${u === unit}" style="padding:2px 10px;font-size:.74rem${
      u === unit ? ";background:var(--ink,#211d17);color:var(--card,#fffdf8);border-color:var(--ink,#211d17)" : ""
    }">${u}</button>`;
  return `<div class="bm-unit" role="group" aria-label="Measurement units" style="display:flex;gap:4px">${btn("in")}${btn("cm")}</div>`;
}

function summaryHtml(data: BmSummary, unit: BmUnit): string {
  const trendSites = data.trends.sites.filter((s) => s.n >= 1).map((s) => trendRow(s)).join("");
  const weightRow = data.trends.weight.n >= 1 ? trendRow(data.trends.weight, goalMovement(data.trends.weight, data.profile)) : "";
  const trends = trendSites || weightRow
    ? `<div class="sess bm-trends reveal" style="padding:12px;margin-bottom:12px">
        <div class="bm-sechead" style="font-weight:600;margin-bottom:4px">Trends</div>
        ${weightRow}${trendSites}
      </div>`
    : "";
  return `<div class="bm-root">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="bm-eyebrow" style="text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--muted,#746c5c)">Body</div>
        ${unitToggle(unit)}
      </div>
      ${data.needs_height ? heightForm(data.profile, unit) : ""}
      ${logForm(data, unit)}
      ${compSection(data, unit)}
      ${numbersSection(data)}
      ${trends}
      ${!data.needs_height ? heightForm(data.profile, unit) : ""}
    </div>`;
}

async function loadAndRender(mount: HTMLElement): Promise<void> {
  const unit = bmUnitPref();
  // Query the unit explicitly (server treats any non-"cm" value, incl. absent, as
  // inches) so the path reads as the covered "/body-metrics", not a phantom :param.
  const data = (await api(`/body-metrics?unit=${unit === "cm" ? "cm" : "in"}`)) as unknown as BmSummary;
  mount.innerHTML = summaryHtml(data, unit);
  wire(mount, unit, data);
}

function wire(mount: HTMLElement, unit: BmUnit, data?: BmSummary): void {
  mount.querySelectorAll(".bm-unit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = (btn as HTMLElement).dataset.unit === "cm" ? "cm" : "in";
      if (next === unit) return;
      bmSetUnitPref(next);
      loadAndRender(mount).catch(() => toast("Could not switch units."));
    });
  });

  // ⓘ hints: tap toggles the shared hint line; focusing an input shows its site's
  // hint too (so guidance appears right when you're about to type).
  const hintBox = mount.querySelector("#bmSiteHint") as HTMLElement | null;
  let hintSite: string | null = null;
  const setExpanded = (site: string | null) => {
    mount.querySelectorAll(".bm-info").forEach((b) => {
      b.setAttribute("aria-expanded", String((b as HTMLElement).dataset.site === site));
    });
  };
  const showHint = (site: string, label: string, hint: string) => {
    if (!hintBox) return;
    hintSite = site;
    hintBox.hidden = false;
    hintBox.textContent = `${label} — ${hint}`;
    setExpanded(site);
  };
  const clearHint = () => {
    if (!hintBox) return;
    hintSite = null;
    hintBox.hidden = true;
    hintBox.textContent = "";
    setExpanded(null);
  };
  mount.querySelectorAll(".bm-info").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = btn as HTMLElement;
      const site = el.dataset.site || "";
      if (hintSite === site) clearHint();
      else showHint(site, el.dataset.label || "", el.dataset.hint || "");
    });
  });
  mount.querySelectorAll(".bm-site").forEach((input) => {
    input.addEventListener("focus", () => {
      const site = (input as HTMLElement).dataset.site || "";
      const btn = mount.querySelector(`.bm-info[data-site="${site}"]`) as HTMLElement | null;
      if (btn) showHint(site, btn.dataset.label || "", btn.dataset.hint || "");
    });
  });

  // Figure callouts → that site's trend row (scroll + a brief sage flash).
  // Delegated from the mount because the morph re-renders the figure's DOM.
  const jumpToTrend = (site: string) => {
    const row = mount.querySelector(`.bm-trend-row[data-trend="${site}"]`) as HTMLElement | null;
    if (!row) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    row.style.transition = "background-color .5s ease";
    row.style.borderRadius = "8px";
    row.style.backgroundColor = "var(--sage-bg, #eef0e6)";
    setTimeout(() => {
      row.style.backgroundColor = "transparent";
    }, 1100);
  };
  const calloutOf = (e: Event): HTMLElement | null => {
    const t = e.target as Element | null;
    return t && typeof t.closest === "function" ? (t.closest(".bm-co") as HTMLElement | null) : null;
  };
  mount.addEventListener("click", (e) => {
    const g = calloutOf(e);
    if (g) jumpToTrend(g.dataset.site || "");
  });
  mount.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key !== "Enter" && key !== " ") return;
    const g = calloutOf(e);
    if (g) {
      e.preventDefault();
      jumpToTrend(g.dataset.site || "");
    }
  });

  // Elite Stand hero: tap a measurement to read it against its reference. Wired
  // on the cached data so a re-select never refetches or resets the log form.
  if (data) bmWireStandHero(mount, data, unit);

  // The then→now morph (LEGACY figure only — the elite fixed figure doesn't
  // morph): with two or more tape sessions the legacy croquis first draws at the
  // PREVIOUS session's proportions and eases into today's over ~1.2s, values
  // counting along the way. Skipped under prefers-reduced-motion, and skipped
  // entirely when the elite library drew the fixed figure instead.
  const slot = mount.querySelector(".bm-figure-slot") as HTMLElement | null;
  if (slot && data && !bmFigureLib()) {
    const m = figureModel(data, unit);
    const from = m.prev;
    const to = m.merged;
    const moving = from && to
      ? BM_SITE_KEYS.filter((k) => {
          const a = from[k] as number | null;
          const b = to[k] as number | null;
          return a != null && b != null && Math.abs(b - a) >= 0.05;
        })
      : [];
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (from && to && moving.length && !reduce && typeof requestAnimationFrame === "function") {
      const finalHtml = slot.innerHTML;
      const dur = 1200;
      let start: number | null = null;
      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const frame = (ts: number) => {
        if (!slot.isConnected) return; // tab switched mid-morph
        if (start == null) start = ts;
        const t = Math.min(1, (ts - start) / dur);
        if (t >= 1) {
          slot.innerHTML = finalHtml;
          return;
        }
        const k = ease(t);
        const interp = { ...to };
        for (const key of moving) interp[key] = (from[key] as number) + ((to[key] as number) - (from[key] as number)) * k;
        slot.innerHTML = bodyFigureSvg({ ...m.base, latest: interp, dirs: {} });
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
  }

  const heightBtn = mount.querySelector("#bmHeightSave");
  if (heightBtn) {
    heightBtn.addEventListener("click", async () => {
      const inches = bmHeightInches(mount);
      if (inches == null) {
        toast("Enter your height first.");
        return;
      }
      try {
        await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ height_in: inches }) });
        toast("Height saved.");
        await loadAndRender(mount);
      } catch {
        toast("Could not save height.");
      }
    });
  }

  const logBtn = mount.querySelector("#bmLogSave");
  if (logBtn) {
    logBtn.addEventListener("click", async () => {
      const body: Record<string, unknown> = {};
      mount.querySelectorAll(".bm-site").forEach((el) => {
        const site = (el as HTMLInputElement).dataset.site;
        const value = bmNum(el);
        if (site && value != null) body[site] = value;
      });
      if (!Object.keys(body).length) {
        toast("Fill in at least one measurement.");
        return;
      }
      body.unit = unit; // values are typed in the display unit; the server stores inches
      const dateEl = mount.querySelector("#bmDate") as HTMLInputElement | null;
      const noteEl = mount.querySelector("#bmNote") as HTMLInputElement | null;
      if (dateEl?.value) body.date = dateEl.value;
      if (noteEl?.value.trim()) body.note = noteEl.value.trim();
      try {
        await api("/body-metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast("Measurements logged.");
        await loadAndRender(mount);
      } catch {
        toast("Could not log measurements.");
      }
    });
  }
}

function renderBodyMetrics(mount: HTMLElement | null): void {
  if (!mount) return;
  mount.innerHTML = `<div class="bm-loading sess-line" style="color:var(--muted,#746c5c);padding:12px">Reading your measurements…</div>`;
  loadAndRender(mount).catch(() => {
    mount.innerHTML = `<div class="bm-error sess-line" style="color:var(--muted,#746c5c);padding:12px">Couldn't load body metrics right now.</div>`;
  });
}

const CAIRN_BODY_METRICS = {
  renderBodyMetrics, deriveFigureRegions, bodyFigureSvg, mergeLatestSites, mergePreviousSites,
  bmReferencePhysique, bmReferenceWeightLb, bmStandModel, bmStandFigureSvg, bmSiteRead, bmResolveSelected,
  bmStandDetail, bmStandRefRows, compSection,
};
Object.assign(globalThis, { CairnBodyMetrics: CAIRN_BODY_METRICS, renderBodyMetrics });
if (typeof window !== "undefined") {
  (window as unknown as { CairnBodyMetrics: typeof CAIRN_BODY_METRICS }).CairnBodyMetrics = CAIRN_BODY_METRICS;
}
})();
