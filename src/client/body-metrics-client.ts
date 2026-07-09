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
  sites: {
    key: string;
    label: string;
    hint?: string;
    range?: { min: number; max: number; typical_min: number | null; typical_max: number | null };
  }[];
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
  if (cm != null) {
    const value = Math.round((cm / 2.54) * 10) / 10;
    return value >= 35 && value <= 99 ? value : null;
  }
  const ft = bmNum(mount.querySelector("#bmHeightFt"));
  const inch = bmNum(mount.querySelector("#bmHeightIn"));
  if (ft == null && inch == null) return null;
  const value = (ft ?? 0) * 12 + (inch ?? 0);
  return value >= 35 && value <= 99 ? value : null;
}

type BmTapeValueIssue = { kind: "error" | "warning"; message: string };
function bmTapeValueIssue(
  value: number | null,
  label: string,
  unit: BmUnit,
  range: { min: number; max: number; typical_min: number | null; typical_max: number | null }
): BmTapeValueIssue | null {
  if (value == null) return null;
  if (value < range.min || value > range.max) {
    return { kind: "error", message: `${label} should be between ${range.min} and ${range.max} ${unit}.` };
  }
  if (
    range.typical_min != null && range.typical_min > 0 &&
    range.typical_max != null && range.typical_max > range.typical_min &&
    (value < range.typical_min || value > range.typical_max)
  ) {
    return { kind: "warning", message: `${label} looks unusual for your height. Recheck the tape.` };
  }
  return null;
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
  male: { neck_in: 15.5, shoulder_in: 46.2, chest_in: 42.2, waist_in: 35.8, hip_in: 40.5, thigh_in: 24, upper_arm_in: 13.8, forearm_in: 11.8, calf_in: 15.8 },
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

  // Vertical stations — real-adult anthropometry (ANSUR II, proportion-spec §1),
  // NOT the idealized Loomis 8-head column, because this croquis is drawn for the
  // ACTUAL user. The plate is fixed (crown y=CROWN, soles y=SOLE); only the widths
  // above respond to the tape. y(frac-from-floor) = SOLE − frac·STAT, so every
  // landmark sits at its measured fraction of stature. The old figure placed the
  // crotch at ≈0.38 of stature (child/homunculus legs); the anthropometric crotch
  // is 0.4817 — this is the load-bearing fix.
  const CROWN = 11.5;
  const SOLE = 224;
  const STAT = SOLE - CROWN; // drawn stature = 212.5px
  const yOf = (fracFloor: number) => SOLE - fracFloor * STAT;
  const yChin = CROWN + STAT / 7.5; // head height ≈ stature/7.5 (real read, not idealized-8)
  const yShoulder = yOf(0.8204); // acromion — 0.820, both sexes agree (§1, §4 r13)
  const yChest = yOf(female ? 0.7195 : 0.7352); // nipple line (§1)
  const yWaist = yOf(0.6016); // navel / natural waist — 0.602 (§1)
  const yElbow = yOf(0.6297); // hanging-arm elbow — 0.630, ≈ waist (§1 derived, §4 r3)
  const yHip = yOf(female ? 0.5191 : 0.513); // greater trochanter — widest hip (§1, §4 r1)
  const yCrotch = yOf(female ? 0.4804 : 0.4817); // pubic line / mid-figure (§1) — THE fix
  const yWrist = yOf(0.4826); // wrist ≈ crotch line (§4 r4, the most-validated alignment)
  const yFinger = yOf(0.367); // fingertips — just below mid-thigh (§1 derived, §4 r5)
  const yKnee = yOf(female ? 0.2757 : 0.2781); // mid-patella (§1)
  const yAnkle = yOf(0.045); // lateral malleolus ≈ 0.045 stature (§2 note — leg minimum)
  const yCalf = yKnee + (yAnkle - yKnee) * 0.33; // calf belly, upper third of the shank (§4 r7)

  // Leg placement: splay the two legs for a natural stance but never let a thigh
  // bulge past the trochanter — the hip stays the widest point (§4 r1).
  const legCx = Math.min(hipR * 0.45 + 2, hipR - thighR + 1.5);
  const thighCx = legCx;
  const kneeCx = legCx;
  const kneeW = Math.max(3.5, (thighR + calfR) * 0.3);
  const ankleW = Math.max(2.5, calfR * 0.45);
  const neckW = Math.min(neckR * 0.82, 8.2); // visibly narrower than the head (§4 r10)

  // Arm axis + the deltoid cap — defined BEFORE the outline so the torso shoulder
  // and the arm share ONE cap point. Arms hang on a slightly abducted axis (tilted
  // out just enough to clear the waist/hip so the waistline stays readable); the
  // clearance solve keys off armT(y) so it tracks the stations. Elbow, wrist and
  // fingertips sit on their anthro lines (§1): elbow ≈ waist, wrist ≈ crotch,
  // fingertips just below mid-thigh.
  const yDeltoid = yShoulder + 6; // arm pivot, just below the acromion
  const armT = (y: number) => (y - yDeltoid) / (yWrist - yDeltoid); // 0 at deltoid → 1 at wrist
  const ax0 = shR * 0.8; // shoulder pivot x
  const ax1 = Math.max(
    ax0 + (waistR + 1.5 + foreR * 0.85 - ax0) / armT(yWaist), // clears the waist
    ax0 + (hipR + 1.5 + foreR * 0.6 - ax0) / armT(yHip), // clears the hip
    ax0 + 6
  ); // wrist-line x
  const ax = (y: number) => ax0 + (ax1 - ax0) * armT(y);
  // The deltoid cap: ONE rounded shoulder point the torso outline AND the arm path
  // both pass through, sized to ENCLOSE the abducted arm so the cap is always the
  // widest shoulder point — never a narrow torso tab beside a wider arm (that gap
  // was the "pauldron"). A broad shoulder tape widens it further. It sits BELOW the
  // neck-base trap origin, so the shoulder line rounds down-and-over it, no horn.
  const capY = yShoulder + 8;
  const capX = Math.max(shR, ax(72) + armR) + 1;

  // The right-hand outline as (dx-from-centerline, y) stations: head → neck →
  // shoulder → chest → waist → hip → outer leg → foot → back up the inner leg.
  // The closed loop mirrors it through the crown and the crotch center. Human
  // landmarks over smoothness — a cranial ball with a defined jaw + chin, a
  // trapezius slope breaking at the deltoid cap, an armpit notch, and feet with a
  // heel + forefoot. Points densify near intentional corners (jaw, chin, foot) so
  // the Catmull-Rom smoothing keeps them.
  const side: Array<[number, number]> = [
    // Head — an OVAL WITH CHEEKS, not an inverted teardrop. Max breadth
    // (≈ 0.73 × head height, §4 r11) is HELD from the parietal down through ear
    // level (~mid-head) so the face carries full cheeks; the taper starts only
    // BELOW the ear and still carries ~68% of max at the gonion (~75% down); only
    // the final chin segment narrows to the soft terminus. Crown reads rounded,
    // never a point. Head height (crown→chin) is unchanged — this is width
    // redistribution: breadth ≈ 0.088 stature (§2, §4 r11), height ≈ stature/7.5.
    [5.4, 12.7], // crown dome (broad + high → rounded cranium, never a spike)
    [9.5, 15.0], // upper skull — widens quickly to dome the cranium
    [10.5, 18.6], // parietal
    [10.6, 22.8], // temple — max breadth (≈ 0.73 × head height)
    [10.3, 26.2], // ear / cheekbone — held near max through mid-head (full cheeks)
    [9.2, 29.8], // cheek — the taper begins here, below the ear
    [7.2, 33.0], // jaw angle / gonion (~75% down) — still ~68% of max breadth
    [5.4, 36.6], // jawline descending to the chin
    [3.8, yChin + 0.6], // chin — a soft rounded terminus (~0.35 head-width), never narrower than the neck
    [neckW * 0.96, yChin + 3.2], // under-jaw shadow flowing into the neck (gentle concave)
    [neckW, 46.8], // mid neck
    // Shoulders — one continuous line: the neck flares into the trapezius in a
    // smooth CONCAVE sweep (evenly spaced points → tangent flow, no corner), which
    // then rounds down-and-over the deltoid cap (capX, capY) sitting BELOW the neck
    // base. Nothing rises above the neck base (no horn); the torso passes through
    // the SAME cap as the arm, then dives under the deltoid toward the chest — the
    // arm continues the outer line down, no notch.
    [neckW + 2.7, 49.3], // neck base — flares into the trapezius (evenly spaced → no kink)
    [capX * 0.52, yShoulder + 2], // trapezius — concave sweep out of the neck
    [capX * 0.86, yShoulder + 5.4], // convex, rounding over the deltoid
    [capX, capY], // deltoid cap — widest, shared with the arm path
    [chestR * 1.06, capY + 6], // dives under the deltoid toward the chest (arm takes the outer line)
    [chestR, yChest], // chest / nipple line
    [(chestR + waistR) * 0.49, (yChest + yWaist) / 2], // lower ribs
    [waistR, yWaist], // natural waist
    [(waistR + hipR) * 0.5, (yWaist + yHip) / 2], // iliac flare
    [hipR, yHip], // greater trochanter — widest hip
    [Math.min(hipR * 0.99, thighCx + thighR), yHip + 7], // hip turning into the thigh
    [Math.min(hipR * 0.98, thighCx + thighR), (yCrotch + yKnee) / 2], // outer mid-thigh
    [kneeCx + kneeW, yKnee], // outer knee
    [kneeCx + calfR, yCalf], // outer calf peak
    [kneeCx + ankleW, yAnkle], // ankle — leg's true minimum (§4 r9)
    [kneeCx + ankleW + 3.4, yAnkle + 5.5], // ball of foot (widening)
    [kneeCx + ankleW + 7, SOLE - 1.5], // toe (rounded, foreshortened front view, §4 r12)
    [kneeCx - ankleW - 1, SOLE], // heel (inner-back, on the sole line)
    [kneeCx - ankleW * 0.7, yAnkle + 1.5], // inner ankle / achilles
    [kneeCx - calfR * 0.78, yCalf], // inner calf
    [kneeCx - kneeW * 0.82, yKnee], // inner knee
    [thighCx - thighR * 0.82, (yCrotch + yKnee) / 2 + 2], // inner thigh → crotch
  ];
  const corePath = bmLoopPath([
    [CX, CROWN],
    ...side.map(([dx, y]) => [CX + dx, y] as [number, number]),
    [CX, yCrotch],
    ...[...side].reverse().map(([dx, y]) => [CX - dx, y] as [number, number]),
  ]);
  // The arm outline. Its deltoid IS the shared cap point (capX, capY), so the arm
  // rises out from under the torso exactly at the cap and tapers down — the union
  // of torso + arm reads as one flowing shoulder→arm line, not a plate bolted on.
  const armSide: Array<[number, number]> = [
    [capX * 0.5, capY - 5], // inner-top, tucked under the torso (hidden)
    [capX, capY], // deltoid cap — the SAME point the torso outline passes through
    [ax(72) + armR * 0.8, 72], // upper arm (tapers in from the cap)
    [ax(yElbow) + armR * 0.72, yElbow], // outer elbow
    [ax(105) + foreR * 0.95, 105], // forearm
    [ax(116) + foreR * 0.6, 116], // lower forearm
    [ax(yWrist) + foreR * 0.55, yWrist], // wrist (narrowing)
    [ax(yWrist + 6) + foreR * 0.74, yWrist + 6], // knuckles — widest of the hand
    [ax(yWrist + 15) + foreR * 0.62, yWrist + 15], // fingers (held width, not a taper)
    [ax(yFinger) + foreR * 0.3, yFinger], // fingertip outer (rounded)
    [ax(yFinger + 0.5) - foreR * 0.06, yFinger + 0.5], // fingertip base of the round end
    [ax(yFinger - 1) - foreR * 0.36, yFinger - 1], // inner fingertip
    [ax(yWrist + 10) - foreR * 0.74, yWrist + 10], // thumb web (inner bump — a thumb hint)
    [ax(yWrist + 2) - foreR * 0.48, yWrist + 2], // inner wrist
    [ax(105) - foreR * 0.85, 105], // inner forearm
    [ax(yElbow) - armR * 0.7, yElbow], // inner elbow
    [ax(78) - armR * 0.8, 78], // inner upper arm
    [capX * 0.44, capY - 2], // armpit — tucked under the torso
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
    const yThigh = (yCrotch + yKnee) / 2;
    if (region === "waist") return e(CX, yWaist, waistR + 14, 26, "bmfig-clip-core");
    if (region === "chest") return e(CX, yChest, chestR + 12, 22, "bmfig-clip-core");
    if (region === "arms") return e(CX - ax(105), 105, armR + 10, 46, "bmfig-clip-arms") + e(CX + ax(105), 105, armR + 10, 46, "bmfig-clip-arms");
    if (region === "legs") return e(CX - thighCx, yThigh, thighR + 12, 52, "bmfig-clip-core") + e(CX + thighCx, yThigh, thighR + 12, 52, "bmfig-clip-core");
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
  const yThighMark = (yCrotch + yKnee) / 2;
  for (const w of winRegions) {
    if (w === "chest") marks += chevron(CX, yChest - 4);
    if (w === "arms") marks += chevron(CX - ax(74), 74) + chevron(CX + ax(74), 74);
    if (w === "legs") marks += chevron(CX - thighCx, yThighMark) + chevron(CX + thighCx, yThighMark);
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
      [CX + sign * (chestR + optR) * 0.48, yWaist - 10],
      [CX + sign * optR, yWaist],
      [CX + sign * (optR + hipR) * 0.5, yWaist + 11],
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
  add("chest_in", "R", yChest, chestR, "chest");
  add("waist_in", "R", yWaist, waistR, "waist");
  if (showOpt) cos.push({ side: "R", segY: yWaist + 6, x1: CX + optR + 2, name: "optimal", val: bmFmt(inp.unit === "cm" ? (optWaistIn as number) * 2.54 : (optWaistIn as number)), dir: "", sage: true });
  add("hip_in", "R", yHip, hipR, "hip");
  add("thigh_in", "R", (yCrotch + yKnee) / 2, thighCx + thighR, "thigh");
  add("calf_in", "R", yCalf, kneeCx + calfR, "calf");
  add("neck_in", "L", 45, neckW + 1, "neck");
  add("shoulder_in", "L", capY, capX + 1.5, "shoulder");
  add("upper_arm_in", "L", 78, ax(78) + armR, "arm");
  add("forearm_in", "L", 108, ax(108) + foreR, "forearm");

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
// A FIXED figure (the vendored CairnBodyFigure) whose measurement sites you tap to
// read in context. Clinical ratios get clinical cutoffs; shoulder/chest/arm ratios
// are tracking-only, never back-solved into target body-part measurements. When the
// library is absent the legacy tape-driven croquis (bodyFigureSvg, above) still
// draws — nothing regresses.

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

// Height as 5′11″ (inches) or 180 cm (metric) for the ratios/context header.
function bmHeightLabel(heightIn: number, unit: BmUnit): string {
  if (unit === "cm") return `${Math.round(heightIn * 2.54)} cm`;
  const ft = Math.floor(heightIn / 12);
  const rem = Math.round(heightIn - ft * 12);
  return `${ft}′${rem}″`;
}

interface BmStandModel {
  merged: BmMeasurement | null;
  female: boolean;
  heightIn: number | null;
  bodyFatPct: number | null;
  unit: BmUnit;
  focus: string | null;
}

function bmStandModel(data: BmSummary, unit: BmUnit): BmStandModel {
  const merged = mergeLatestSites(data.measurements, data.latest);
  const female = String(data.profile?.sex || "").toLowerCase() === "female";
  const heightIn = data.profile?.height_in ?? null;
  const bodyFat = data.indicators.find((i) => i.key === "bodyfat")?.value;
  const focus = data.comp ? deriveFigureRegions(data.comp, data.trends).focus : null;
  return {
    merged,
    female,
    heightIn,
    bodyFatPct: bodyFat != null && Number.isFinite(bodyFat) ? bodyFat : null,
    unit,
    focus,
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

function bmInches(value: number | null, unit: BmUnit): number | null {
  return value == null ? null : unit === "cm" ? value / 2.54 : value;
}

function bmRatio(n: number | null, d: number | null): number | null {
  return n != null && d != null && d > 0 ? Math.round((n / d) * 100) / 100 : null;
}

function bmRatioDisplay(value: number | null): string {
  return value == null ? "—" : value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

function bmWaistHeightTone(value: number | null): { text: string; tone: BmChipTone } {
  if (value == null) return { text: "needs height", tone: "muted" };
  if (value >= 0.6) return { text: "high", tone: "warn" };
  if (value >= 0.5) return { text: "above guide", tone: "warn" };
  return { text: "within guide", tone: "sage" };
}

function bmWaistHipTone(value: number | null, female: boolean): { text: string; tone: BmChipTone } {
  if (value == null) return { text: "needs hip", tone: "muted" };
  const limit = female ? 0.85 : 0.9;
  return value > limit ? { text: "above guide", tone: "warn" } : { text: "within guide", tone: "sage" };
}

function bmSiteContext(model: BmStandModel, key: BmSiteKey): { chip: { text: string; tone: BmChipTone }; metric: string; guide: string; why: string } {
  const cur = model.merged ? (model.merged[key] as number | null) : null;
  const curIn = bmInches(cur, model.unit);
  const waistIn = bmInches(model.merged ? (model.merged.waist_in as number | null) : null, model.unit);
  if (key === "waist_in") {
    const whtr = bmRatio(curIn, model.heightIn);
    const chip = bmWaistHeightTone(whtr);
    return {
      chip,
      metric: `waist/height ${bmRatioDisplay(whtr)}`,
      guide: "clinical guide: <0.50",
      why: "This is the evidence-backed tape read: waist-to-height screens central adiposity without converting it into target chest, shoulder, or arm measurements.",
    };
  }
  if (key === "hip_in" && waistIn != null) {
    const whr = bmRatio(waistIn, curIn);
    const chip = bmWaistHipTone(whr, model.female);
    return {
      chip,
      metric: `waist/hip ${bmRatioDisplay(whr)}`,
      guide: `clinical guide: <${model.female ? "0.85" : "0.90"}`,
      why: "Waist-to-hip is a central-fat context read. Hip circumference itself is not assigned a target.",
    };
  }
  return {
    chip: { text: "tracking only", tone: "muted" },
    metric: "circumference logged",
    guide: "no target measurement",
    why: "This site is useful for trend and proportion context, but Cairn no longer creates a target circumference from another body part.",
  };
}

// The elite Stand figure: fixed silhouette + selected-site glow + waist-height
// guide trace + tappable measurement callouts. Coordinates: the library figure is
// authored in a 0–260 space; a translate(80,0) group centers it in a 420-wide box,
// leaving label rails on both sides. Callouts are drawn in the outer box space.
// Neutral authored-plate baselines (inches) per sex — the figure bends toward
// the athlete's measured/baseline ratio at each site (the lib clamps the warp).
const BM_FIGURE_BASE: Record<"male" | "female", Partial<Record<BmSiteKey, number>>> = {
  male: { neck_in: 15.5, shoulder_in: 46.2, chest_in: 42.2, waist_in: 35.8, hip_in: 40.5, upper_arm_in: 13.8, forearm_in: 11.8, thigh_in: 24, calf_in: 15.8 },
  female: { neck_in: 12.5, shoulder_in: 39, chest_in: 35, waist_in: 28, hip_in: 38, upper_arm_in: 10.5, forearm_in: 9.5, thigh_in: 21.5, calf_in: 14.5 },
};
const bmClampRatio = (r: number): number => Math.min(1.14, Math.max(0.88, r));

// Lib-site-keyed measured/baseline ratios — the honest-figure input.
function bmFigureRatios(model: BmStandModel): Record<string, number> {
  const base = BM_FIGURE_BASE[model.female ? "female" : "male"];
  const out: Record<string, number> = {};
  for (const [libSite, key] of Object.entries(BM_STAND_SITE_OF)) {
    const b = base[key];
    const raw = model.merged ? (model.merged[key] as number | null) : null;
    const v = bmInches(raw != null && Number.isFinite(raw) ? raw : null, model.unit);
    if (b && v != null && v > 0) out[libSite] = v / b;
  }
  return out;
}

function bmStandFigureSvg(lib: CairnBodyFigureApi, model: BmStandModel, selected: BmSiteKey | null): string {
  const sexKey = model.female ? "female" : "male";
  // The silhouette is HONEST: each zone bends by the athlete's own tape ratio
  // (clamped in the lib), so a 33in waist on 40in hips reads as that body.
  const ratios = bmFigureRatios(model);
  const kindOf = (site: string): "torso" | "arm" => (lib.ARM_SITES.has(site) ? "arm" : "torso");
  const sil = lib.silhouette(sexKey, ratios);
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
  // Selected-site glow: only clinical central-adiposity ratios can warn. Other
  // tape sites stay neutral because they are trend/proportion context, not targets.
  const gradFor = (k: BmSiteKey): string => {
    const read = bmSiteContext(model, k);
    return read.chip.tone === "warn" ? "bmfig2-warn" : "bmfig2-sage";
  };
  let washes = "";
  let tape = "";
  if (selected) {
    const name = Object.keys(BM_STAND_SITE_OF).find((n) => BM_STAND_SITE_OF[n] === selected);
    const glows = name ? lib.GLOWS[name] : null;
    if (glows) {
      const grad = gradFor(selected);
      const clipOf = (c: string) => (c === "aR" ? "bmfig2-clip-aR" : c === "aL" ? "bmfig2-clip-aL" : "bmfig2-clip-t");
      const kind = name ? kindOf(name) : "torso";
      for (const [cx, cy, rx, ry, clip] of glows) {
        const [wcx] = lib.warpPoint([cx, cy], sexKey, ratios, clip === "t" ? "torso" : "arm");
        washes += `<g clip-path="url(#${clipOf(clip)})"><ellipse class="bm-pulse" cx="${bmR(wcx)}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${grad})"/></g>`;
      }
      // The tailor's tape: a fine band wrapped around the body at the selected
      // site — front arc solid, back arc faint dashed (the wrap-around). Its
      // center/width come from the site's own glow geometry, so the tape hugs
      // the waist at the waist and the arm at the arm. Measuring = the tape.
      const co = lib.CALLOUTS.find((c) => c.site === name);
      const anchor = co ? lib.warpPoint(co.pt, sexKey, ratios, kind) : null;
      const g = anchor
        ? [...glows].sort((a, b) => Math.abs(a[0] - anchor[0]) - Math.abs(b[0] - anchor[0]))[0]
        : glows[0];
      if (g) {
        const ty = anchor ? anchor[1] : g[1];
        const [tcx] = lib.warpPoint([g[0], ty], sexKey, ratios, g[4] === "t" ? "torso" : "arm");
        // Trunk sites hug the TRUE silhouette half-width at the anchor — warped
        // per sex AND per the measured ratio, so the tape length visibly tracks
        // the number it reports. Limb tapes ride the glow width the same way.
        const trunkHalf: Partial<Record<BmSiteKey, number>> = { neck_in: 17, chest_in: 58, waist_in: 42, hip_in: 52 };
        const authored = trunkHalf[selected];
        const siteRatio = bmClampRatio(name && ratios[name] ? ratios[name] : 1);
        const trx = authored != null
          ? authored * (model.female ? lib.kOf(ty) : 1) * siteRatio + 4
          : Math.max(12, g[2] * (model.female ? lib.kOf(ty) : 1) * siteRatio + 3);
        const tryy = Math.max(3.5, trx * 0.16);
        const L = `${bmR(tcx - trx)} ${bmR(ty)}`;
        const R = `${bmR(tcx + trx)} ${bmR(ty)}`;
        tape =
          `<path class="bm-tape-back" d="M ${L} A ${bmR(trx)} ${bmR(tryy)} 0 0 1 ${R}" fill="none" stroke="#b4552d" stroke-width="1.1" stroke-dasharray="2 3.4" opacity="0.32"/>` +
          `<path class="bm-tape" pathLength="100" d="M ${L} A ${bmR(trx)} ${bmR(tryy)} 0 0 0 ${R}" fill="none" stroke="#b4552d" stroke-width="1.7" stroke-linecap="round" opacity="0.92"/>` +
          `<circle cx="${bmR(tcx - trx)}" cy="${bmR(ty)}" r="1.5" fill="#b4552d" opacity="0.85"/>` +
          `<circle cx="${bmR(tcx + trx)}" cy="${bmR(ty)}" r="1.5" fill="#b4552d" opacity="0.85"/>`;
      }
    }
  }

  // The clinical waist-height chalk trace, only when the waist is measured and
  // above the waist/height 0.5 guide.
  const waistIn = inchOf("waist_in");
  const guideWaist = model.heightIn != null ? model.heightIn * 0.5 : null;
  let optTrace = "";
  if (waistIn != null && guideWaist != null && waistIn > guideWaist + 0.2) {
    const attrs = `fill="none" stroke="#5a6a4a" stroke-width="1.7" stroke-dasharray="4.5 3.5" stroke-linecap="round" opacity="0.9"`;
    const baseWaist = BM_FIGURE_BASE[sexKey].waist_in || guideWaist;
    const guideScale = guideWaist / baseWaist;
    optTrace = `<path d="${lib.waistTrace(sexKey, 1, guideScale)}" ${attrs}/><path d="${lib.waistTrace(sexKey, -1, guideScale)}" ${attrs}/>`;
  }

  // Surface anatomy, not a muscle chart. Definition fades with the tape body-fat
  // estimate: at ~20% the clavicles, pec envelope, patellae and calf planes read,
  // while abs remain under the surface; leaner bodies reveal a little more form.
  const bf = model.bodyFatPct;
  const definition = bf == null ? 0.48 : bf <= 12 ? 1 : bf <= 18 ? 0.68 : bf <= 24 ? 0.42 : bf <= 30 ? 0.26 : 0.16;
  const planeGroups = new Set(["shoulders", "chest", "quads", "calves"]);
  let surface = "";
  for (const m of lib.muscles(sexKey, "front", ratios)) {
    if (!planeGroups.has(m.group)) continue;
    const op = (m.group === "shoulders" ? 0.032 : m.group === "chest" ? 0.026 : 0.02) * definition;
    surface += `<path d="${m.d}" fill="#3f382c" fill-opacity="${op}" stroke="none" pointer-events="none"/>`;
  }
  const strokeD = (pts: Array<[number, number]>, kind: "torso" | "arm" = "torso") =>
    lib.openD(pts.map((p) => lib.warpPoint(p, sexKey, ratios, kind)));
  const stroke = (pts: Array<[number, number]>, kind: "torso" | "arm" = "torso", strength = 1) =>
    `<path d="${strokeD(pts, kind)}" fill="none" stroke="#75654f" stroke-width="0.95" stroke-linecap="round" stroke-linejoin="round" opacity="${bmR((0.1 + 0.19 * definition) * strength)}" pointer-events="none"/>`;
  const mirrorStroke = (pts: Array<[number, number]>, kind: "torso" | "arm" = "torso", strength = 1) => stroke(lib.mirrorPts(pts), kind, strength);
  const torsoLandmarks: Array<{ pts: Array<[number, number]>; strength?: number }> = [
    { pts: [[149, 81], [145, 88], [138, 94.5], [130, 97], [122, 94.5], [115, 88], [111, 81]], strength: 0.7 }, // jaw/chin plane
    { pts: [[158, 55], [158.5, 63], [156, 70]], strength: 0.45 }, { pts: [[102, 55], [101.5, 63], [104, 70]], strength: 0.45 }, // ears
    { pts: [[143, 101], [151, 115], [162, 121]], strength: 0.5 }, { pts: [[117, 101], [109, 115], [98, 121]], strength: 0.5 }, // sternocleidomastoid
    { pts: [[130, 120], [115, 122], [96, 127]] }, { pts: [[130, 120], [145, 122], [164, 127]] }, // clavicles
    { pts: [[130, 142], [130, 177]], strength: 0.45 }, // sternum
    { pts: [[130, 184], [151, 184], [174, 176]], strength: 0.9 }, { pts: [[130, 184], [109, 184], [86, 176]], strength: 0.9 }, // pec envelope
    { pts: [[112, 202], [109, 233], [116, 273]], strength: 0.25 }, { pts: [[148, 202], [151, 233], [144, 273]], strength: 0.25 }, // abdominal side planes
    { pts: [[130, 304], [146, 315], [160, 333]], strength: 0.45 }, { pts: [[130, 304], [114, 315], [100, 333]], strength: 0.45 }, // inguinal fold
    { pts: [[147, 345], [152, 401], [147, 460]], strength: 0.4 }, { pts: [[113, 345], [108, 401], [113, 460]], strength: 0.4 }, // thigh front plane
    { pts: [[139, 466], [154, 470], [170, 466]], strength: 0.9 }, { pts: [[121, 466], [106, 470], [90, 466]], strength: 0.9 }, // patella
    { pts: [[153, 486], [160, 513], [154, 551]], strength: 0.75 }, { pts: [[107, 486], [100, 513], [106, 551]], strength: 0.75 }, // calf belly
    { pts: [[162, 539], [157, 574], [158, 596]], strength: 0.55 }, { pts: [[98, 539], [103, 574], [102, 596]], strength: 0.55 }, // tibia/ankle
  ];
  const armLandmarks: Array<{ pts: Array<[number, number]>; strength?: number }> = [
    { pts: [[198, 170], [201, 203], [197, 236]], strength: 0.65 },
    { pts: [[190, 247], [196, 286], [194, 326]], strength: 0.55 },
  ];
  for (const { pts, strength } of torsoLandmarks) surface += stroke(pts, "torso", strength);
  for (const { pts, strength } of armLandmarks) surface += stroke(pts, "arm", strength) + mirrorStroke(pts, "arm", strength);
  const [navelX, navelY] = lib.warpPoint([130, 246], sexKey, ratios, "torso");
  surface += `<ellipse cx="${bmR(navelX)}" cy="${bmR(navelY)}" rx="1.7" ry="1.15" fill="#675743" opacity="${bmR(0.18 + definition * 0.2)}" pointer-events="none"/>`;
  const surfaceLayer = `<g class="bmfig2-surface">${surface}</g>`;

  // The atelier plate: the croquis reads as a shallow relief object, not a flat
  // icon — gradient modeling light from the upper left, a soft inner form
  // shadow along the lower-right contour (offset strokes clipped inside each
  // part), a sternum sheen, and a still-life ground shadow under the feet.
  const relief = (d: string, clip: string) =>
    `<g clip-path="url(#${clip})">` +
    `<g transform="translate(-1.7,-2.1)"><path d="${d}" fill="none" stroke="#fbf5e8" stroke-width="5" opacity="0.5" filter="url(#bmfig2-form)"/></g>` +
    `<g transform="translate(1.7,2.3)"><path d="${d}" fill="none" stroke="#87735a" stroke-width="5.5" opacity="0.2" filter="url(#bmfig2-form)"/></g>` +
    `</g>`;
  // Arms draw BEHIND the torso (they emerge at the armpit like the classic
  // croquis), each part's relief shading riding directly on its own fill.
  const group = `<g transform="translate(80,0)">
      <ellipse cx="130" cy="633" rx="84" ry="7.5" fill="#211d17" opacity="0.07" filter="url(#bmfig2-ground)"/>
      <path d="${sil.armL}" fill="url(#bmfig2-relief)" stroke="${col.standLine}" stroke-width="1.3"/>
      <path d="${sil.armR}" fill="url(#bmfig2-relief)" stroke="${col.standLine}" stroke-width="1.3"/>
      ${relief(sil.armL, "bmfig2-clip-aL")}${relief(sil.armR, "bmfig2-clip-aR")}
      <path d="${sil.torso}" fill="url(#bmfig2-relief)" stroke="${col.standLine}" stroke-width="1.3"/>
      ${relief(sil.torso, "bmfig2-clip-t")}
      <ellipse cx="130" cy="205" rx="30" ry="74" fill="url(#bmfig2-sheen)" clip-path="url(#bmfig2-clip-t)"/>
      ${surfaceLayer}
      ${washes}${optTrace}${tape}
    </g>`;

  // Callouts: leader line + dot from the body anchor out to a label rail, wrapped
  // in a finger-sized tap target that selects the site.
  type CO = { key: BmSiteKey; side: "L" | "R"; segY: number; ax: number; ay: number };
  const cos: CO[] = [];
  for (const c of lib.CALLOUTS) {
    const key = BM_STAND_SITE_OF[c.site];
    if (!key || !measured(key)) continue;
    const [wx, wy] = lib.warpPoint(c.pt, sexKey, ratios, kindOf(c.site));
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
      callouts += `<g class="bm-co2" data-site="${escAttr(c.key)}" role="button" tabindex="0" aria-label="Read your ${escAttr(BM_SITE_LABEL[c.key])} in context"${sel ? ` aria-current="true"` : ""} style="cursor:pointer"><rect x="${hitX}" y="${y - 10}" width="96" height="18" fill="transparent"/>${label}</g>`;
    }
  }

  const measuredList = cos.map((c) => `${BM_SITE_LABEL[c.key]} ${dispVal(c.key)}`).join(", ");
  const aria = measuredList
    ? `Your measurements on a body figure: ${measuredList} ${model.unit}. Tap a measurement to read its context.`
    : "A body figure — log a tape session and your measurements appear as tappable callouts.";
  const defs = `<defs>
      <radialGradient id="bmfig2-warn"><stop offset="0%" stop-color="#b4552d" stop-opacity="0.32"/><stop offset="62%" stop-color="#b4552d" stop-opacity="0.15"/><stop offset="100%" stop-color="#b4552d" stop-opacity="0"/></radialGradient>
      <radialGradient id="bmfig2-sage"><stop offset="0%" stop-color="#6e7f5c" stop-opacity="0.30"/><stop offset="62%" stop-color="#6e7f5c" stop-opacity="0.14"/><stop offset="100%" stop-color="#6e7f5c" stop-opacity="0"/></radialGradient>
      <radialGradient id="bmfig2-gold"><stop offset="0%" stop-color="#c9a86a" stop-opacity="0.40"/><stop offset="62%" stop-color="#c9a86a" stop-opacity="0.18"/><stop offset="100%" stop-color="#c9a86a" stop-opacity="0"/></radialGradient>
      <clipPath id="bmfig2-clip-t"><path d="${sil.torso}"/></clipPath>
      <clipPath id="bmfig2-clip-aR"><path d="${sil.armR}"/></clipPath>
      <clipPath id="bmfig2-clip-aL"><path d="${sil.armL}"/></clipPath>
      <linearGradient id="bmfig2-relief" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0%" stop-color="#f2ead8"/><stop offset="45%" stop-color="${col.standFill}"/><stop offset="100%" stop-color="#ddcfb2"/>
      </linearGradient>
      <radialGradient id="bmfig2-sheen"><stop offset="0%" stop-color="#fffdf8" stop-opacity="0.32"/><stop offset="100%" stop-color="#fffdf8" stop-opacity="0"/></radialGradient>
      <filter id="bmfig2-form" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.6"/></filter>
      <filter id="bmfig2-ground" x="-40%" y="-160%" width="180%" height="420%"><feGaussianBlur stdDeviation="3.4"/></filter>
    </defs>`;
  return `<svg class="bm-figure bm-figure2" viewBox="0 0 420 645" width="100%" role="img" aria-label="${escAttr(aria)}" style="display:block;max-width:440px;margin:0 auto;overflow:visible">${defs}${group}${callouts}</svg>`;
}

// The selected-site detail panel: clinical ratios where they exist; otherwise a
// tracking-only read. No site gets a target circumference derived from another.
function bmStandDetail(model: BmStandModel, selected: BmSiteKey | null, unit: BmUnit): string {
  const wrap = (inner: string) =>
    `<div class="bm-detail" style="margin-top:12px;background:#f8f3e8;border:1px solid #e7dfd2;border-radius:14px;padding:14px 16px 13px">${inner}</div>`;
  if (!selected) return wrap(`<div class="sess-line" style="color:var(--muted,#746c5c)">Tap a measurement on the figure to read its context.</div>`);
  const cur = model.merged ? (model.merged[selected] as number | null) : null;
  const name = bmCap(BM_SITE_LABEL[selected]);
  if (cur == null) {
    return wrap(`<div style="display:flex;align-items:baseline;gap:9px"><span style="font:600 16px ui-serif,Georgia,serif;color:#211d17">${escHtml(name)}</span>${bmChip("not taped", "muted")}</div>
      <div class="sess-line" style="color:var(--muted,#746c5c);margin-top:6px">Tape this site and it reads in context here.</div>`);
  }
  const read = bmSiteContext(model, selected);
  return wrap(`<div style="display:flex;align-items:baseline;gap:9px"><span style="font:600 16px ui-serif,Georgia,serif;color:#211d17">${escHtml(name)}</span>${bmChip(read.chip.text, read.chip.tone)}</div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:7px;flex-wrap:wrap"><span style="font:600 22px ui-serif,Georgia,serif;color:#211d17">${escHtml(bmFmt(cur))}</span><span style="font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#746c5c">${escHtml(unit)}</span><span style="font:italic 600 14px ui-serif,Georgia,serif;color:#5f6e4f">${escHtml(read.metric)}</span></div>
    <div style="font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#a99c82;margin-top:6px">${escHtml(read.guide)}</div>
    <div style="font:400 12.5px/1.55 ui-sans-serif,system-ui,sans-serif;color:#57503f;margin-top:9px">${escHtml(read.why)}</div>`);
}

// Ratio rows: clinical central-adiposity screens where evidence supports them,
// plus optional tracking-only physique ratios. Nothing here back-solves a target
// circumference for chest/shoulder/arm/hip/weight.
function bmStandRatioRows(model: BmStandModel, unit: BmUnit): string {
  const valIn = (key: BmSiteKey): number | null => bmInches(model.merged ? (model.merged[key] as number | null) : null, unit);
  const waist = valIn("waist_in");
  const hip = valIn("hip_in");
  const shoulder = valIn("shoulder_in");
  const chest = valIn("chest_in");
  const arm = valIn("upper_arm_in");
  const calf = valIn("calf_in");
  const rows: string[] = [];
  const rowHtml = (label: string, value: string, guide: string, chip: string) =>
    `<div style="display:flex;align-items:baseline;gap:10px;padding:7px 2px;border-bottom:1px solid #f2ecdf">
      <span style="flex:0 0 78px;font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.1em;color:#746c5c">${escHtml(label)}</span>
      <span style="font:560 14.5px ui-serif,Georgia,serif;color:#211d17">${escHtml(value)}</span>
      <span style="font:600 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#a99c82">${escHtml(guide)}</span>${chip}</div>`;
  if (waist != null && model.heightIn != null) {
    const v = bmRatio(waist, model.heightIn);
    const c = bmWaistHeightTone(v);
    rows.push(rowHtml("WAIST/HEIGHT", bmRatioDisplay(v), "clinical <0.50", bmChip(c.text, c.tone)));
  }
  if (waist != null && hip != null) {
    const v = bmRatio(waist, hip);
    const c = bmWaistHipTone(v, model.female);
    rows.push(rowHtml("WAIST/HIP", bmRatioDisplay(v), `clinical <${model.female ? "0.85" : "0.90"}`, bmChip(c.text, c.tone)));
  }
  const tracking = [
    ["SHOULDER/WAIST", bmRatio(shoulder, waist)],
    ["CHEST/WAIST", bmRatio(chest, waist)],
    ["ARM/CALF", bmRatio(arm, calf)],
  ] as const;
  for (const [label, value] of tracking) {
    if (value == null) continue;
    rows.push(rowHtml(label, bmRatioDisplay(value), "tracking only", bmChip("no target", "muted")));
  }
  if (!rows.length) return "";
  return `<div class="bm-ref" style="margin-top:16px">
      <div style="font:700 10px ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#746c5c">Ratios & context${model.heightIn != null ? ` · ${escHtml(bmHeightLabel(model.heightIn, unit))}` : ""}</div>
      <div style="margin-top:6px">${rows.join("")}</div>
      <div style="font:400 11.5px/1.55 ui-sans-serif,system-ui,sans-serif;color:#a99c82;margin-top:9px">Only waist-height and waist-hip use clinical risk guides. Shoulder/chest/arm ratios are trend context, not target measurements.</div>
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
    ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.82rem;margin-top:2px">Tap a measurement to read its context.</div>`
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
      <div class="bm-figure-slot" style="margin-top:8px"><div class="bm-figure-fallback">${figure}</div></div>
      ${detail}${focus}
      ${bmStandRatioRows(model, unit)}
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
// ⓘ affordance on each site label — tap (or focus the input) and an inline
// note opens right on that field, so the tape landmark is visible while typing.
function logForm(data: BmSummary, unit: BmUnit): string {
  const sites = data.sites || [];
  // Local calendar day (localISO from date-utils) — a UTC slice would prefill
  // tomorrow's date for an evening tape session west of Greenwich.
  const today = typeof localISO === "function" ? localISO() : new Date().toISOString().slice(0, 10);
  const inputs = sites
    .map((s) => {
      const hintId = `bmHint-${s.key}`;
      const feedbackId = `bmFeedback-${s.key}`;
      const fallback = unit === "cm"
        ? { min: 2.5, max: 254, typical_min: null, typical_max: null }
        : { min: 1, max: 100, typical_min: null, typical_max: null };
      const range = s.range || fallback;
      const info = s.hint
        ? `<button type="button" class="bm-info" data-site="${escAttr(s.key)}" data-label="${escAttr(s.label)}" aria-controls="${escAttr(hintId)}" aria-expanded="false" aria-label="How to measure: ${escAttr(s.label)}" title="How to measure ${escAttr(s.label)}" style="width:15px;height:15px;border-radius:50%;border:1px solid var(--muted,#746c5c);color:var(--muted,#746c5c);background:transparent;font-size:.6rem;line-height:1;font-style:italic;font-family:var(--font-display,Georgia,serif);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none">i</button>`
        : "";
      const hint = s.hint
        ? `<span id="${escAttr(hintId)}" class="bm-site-hint sess-line" data-site="${escAttr(s.key)}" role="note" hidden style="display:block;margin-top:6px;padding:7px 8px;border-radius:8px;background:var(--sage-bg,#eef0e6);color:var(--ink,#211d17);font-size:.76rem;line-height:1.35">${escHtml(s.hint)}</span>`
        : "";
      const described = `${s.hint ? `${hintId} ` : ""}${feedbackId}`;
      return `<label class="field bm-site-field" data-site-field="${escAttr(s.key)}" style="margin:0"><span style="display:inline-flex;align-items:center;gap:5px">${escHtml(s.label)}${info}</span><input class="form-input bm-site" data-site="${escAttr(s.key)}" data-label="${escAttr(s.label)}" data-typical-min="${escAttr(String(range.typical_min ?? ""))}" data-typical-max="${escAttr(String(range.typical_max ?? ""))}" type="number" inputmode="decimal" min="${escAttr(String(range.min))}" max="${escAttr(String(range.max))}" step="0.1" placeholder="${unit}" aria-describedby="${escAttr(described.trim())}" style="width:100%"><span id="${escAttr(feedbackId)}" class="bm-site-feedback sess-line" data-site-feedback="${escAttr(s.key)}" role="status" hidden style="display:block;margin-top:5px;font-size:.72rem;line-height:1.35"></span>${hint}</label>`;
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
        <div class="sess-line" style="color:var(--muted,#746c5c);margin:0 0 8px">Tape, relaxed, same time of day. Fill in what you measured — the rest stays blank. Tap i on any site for where the tape goes.</div>
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

  // ⓘ hints: tap toggles the field's inline note; focusing an input shows its
  // note too (so guidance appears right when you're about to type).
  let hintSite: string | null = null;
  const setExpanded = (site: string | null) => {
    mount.querySelectorAll(".bm-info").forEach((b) => {
      b.setAttribute("aria-expanded", String((b as HTMLElement).dataset.site === site));
    });
  };
  const setHintVisible = (site: string | null) => {
    mount.querySelectorAll(".bm-site-hint").forEach((box) => {
      const el = box as HTMLElement;
      el.hidden = el.dataset.site !== site;
    });
  };
  const showHint = (site: string) => {
    hintSite = site;
    setHintVisible(site);
    setExpanded(site);
  };
  const clearHint = () => {
    hintSite = null;
    setHintVisible(null);
    setExpanded(null);
  };
  mount.querySelectorAll(".bm-info").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = btn as HTMLElement;
      const site = el.dataset.site || "";
      if (hintSite === site) clearHint();
      else showHint(site);
    });
  });
  mount.querySelectorAll(".bm-site").forEach((input) => {
    input.addEventListener("focus", () => {
      const site = (input as HTMLElement).dataset.site || "";
      const btn = mount.querySelector(`.bm-info[data-site="${site}"]`) as HTMLElement | null;
      if (btn) showHint(site);
    });
  });

  // Site-specific hard limits stop impossible entries. Height-aware limits are
  // deliberately soft: they highlight an unusual value and require a second,
  // intentional Log tap, preserving an override path for uncommon real bodies.
  type BmInputIssue = { input: HTMLInputElement; kind: "error" | "warning"; message: string };
  let unusualConfirmed = false;
  const inputIssue = (input: HTMLInputElement): BmInputIssue | null => {
    const value = bmNum(input);
    const label = input.dataset.label || "Measurement";
    const min = Number(input.min);
    const max = Number(input.max);
    const typicalMin = Number(input.dataset.typicalMin);
    const typicalMax = Number(input.dataset.typicalMax);
    const issue = bmTapeValueIssue(value, label, unit, {
      min: Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY,
      max: Number.isFinite(max) ? max : Number.POSITIVE_INFINITY,
      typical_min: Number.isFinite(typicalMin) && typicalMin > 0 ? typicalMin : null,
      typical_max: Number.isFinite(typicalMax) && typicalMax > 0 ? typicalMax : null,
    });
    return issue ? { input, ...issue } : null;
  };
  const paintInputIssue = (input: HTMLInputElement): BmInputIssue | null => {
    const issue = inputIssue(input);
    const site = input.dataset.site || "";
    const box = mount.querySelector(`[data-site-feedback="${site}"]`) as HTMLElement | null;
    input.setAttribute("aria-invalid", String(issue?.kind === "error"));
    if (typeof input.setCustomValidity === "function") input.setCustomValidity(issue?.kind === "error" ? issue.message : "");
    if (box) {
      box.hidden = !issue;
      box.textContent = issue?.message || "";
      box.style.color = issue?.kind === "error" ? "var(--warn,#b3402e)" : "var(--gold-deep,#8a6d2e)";
    }
    return issue;
  };
  const allInputIssues = (): BmInputIssue[] => {
    const issues: BmInputIssue[] = [];
    mount.querySelectorAll(".bm-site").forEach((el) => {
      const issue = paintInputIssue(el as HTMLInputElement);
      if (issue) issues.push(issue);
    });
    return issues;
  };
  mount.querySelectorAll(".bm-site").forEach((el) => {
    const input = el as HTMLInputElement;
    input.addEventListener("input", () => {
      unusualConfirmed = false;
      paintInputIssue(input);
    });
    input.addEventListener("blur", () => paintInputIssue(input));
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

  // Elite Stand hero: tap a measurement to read it in context. Wired
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
      const issues = allInputIssues();
      const errors = issues.filter((i) => i.kind === "error");
      const warnings = issues.filter((i) => i.kind === "warning");
      if (errors.length) {
        errors[0].input.focus();
        toast(errors[0].message);
        return;
      }
      if (warnings.length && !unusualConfirmed) {
        unusualConfirmed = true;
        warnings[0].input.focus();
        toast("One value looks unusual. Recheck it, then tap Log session again to confirm.");
        return;
      }
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
        const result = await api("/body-metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as unknown as { ok?: boolean; error?: string; issues?: Array<{ site?: string; severity?: string; message?: string }> };
        if (result?.ok === false) {
          for (const issue of result.issues || []) {
            if (!issue.site) continue;
            const input = mount.querySelector(`.bm-site[data-site="${issue.site}"]`) as HTMLInputElement | null;
            const box = mount.querySelector(`[data-site-feedback="${issue.site}"]`) as HTMLElement | null;
            if (input) input.setAttribute("aria-invalid", String(issue.severity === "error"));
            if (box) {
              box.hidden = false;
              box.textContent = issue.message || "Check this value.";
              box.style.color = issue.severity === "error" ? "var(--warn,#b3402e)" : "var(--gold-deep,#8a6d2e)";
            }
          }
          toast(result.error || "Check the measurements before logging.");
          return;
        }
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
  bmStandModel, bmStandFigureSvg, bmSiteContext, bmResolveSelected,
  bmStandDetail, bmStandRatioRows, bmTapeValueIssue, compSection,
};
Object.assign(globalThis, { CairnBodyMetrics: CAIRN_BODY_METRICS, renderBodyMetrics });
if (typeof window !== "undefined") {
  (window as unknown as { CairnBodyMetrics: typeof CAIRN_BODY_METRICS }).CairnBodyMetrics = CAIRN_BODY_METRICS;
}
})();
