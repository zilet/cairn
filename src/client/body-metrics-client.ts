// @ts-check
// Body Metrics — a calm at-home measurements + indicators + trend view.
//
// Self-contained: renderBodyMetrics(mount) fetches /api/body-metrics and paints,
// top to bottom: a "Log a tape session" action card (always one tap from the top,
// open by default until the first session exists), the "Where you stand" hero —
// a fitting-sheet FIGURE: an atelier mannequin built from ellipses whose widths
// are drawn from YOUR latest tape in true proportion to your height, a dashed
// sage ellipse tracing the optimal waist for your height (waist ≤ half height),
// and hairline callouts annotating each measured site with its value + trend
// arrow — plus the deterministic heading + ONE focus lever; then "The numbers"
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
// An atelier mannequin: head, thorax, waist, pelvis and limbs as separate
// ellipses (ball joints at the shoulders and knees), the classic wooden drawing
// figure — except every segment's width is computed from the athlete's latest
// tape, scaled so the whole figure keeps true proportion to their height. The
// optimal waist for that height (waist-to-height ≤ 0.5) is traced as a dashed
// sage ellipse over the waist piece, and each measured site gets a hairline
// callout with its current value and trend arrow. Illustration hexes (like
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
const BM_FIG_SAGE = "#6e7f5c";
const BM_FIG_SAGE_DEEP = "#5a6a4a";
const BM_FIG_LINE = "#c4b89d";

interface BmFigureInput {
  latest: BmMeasurement | null;
  heightIn: number | null;
  sex: string;
  unit: BmUnit;
  focus: string | null; // region: waist | null
  wins: string[]; // regions: arms | legs | chest
  dirs: Record<string, "up" | "down" | "steady" | null>;
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
  const keys: BmSiteKey[] = ["neck_in", "shoulder_in", "chest_in", "waist_in", "hip_in", "thigh_in", "upper_arm_in", "forearm_in", "calf_in"];
  for (const k of keys) {
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

  const armCx = Math.max(chestR, waistR, hipR) + armR + 2;
  const thighCx = Math.max(hipR * 0.52, thighR * 0.9) + 0.5;
  const kneeCx = hipR * 0.45 + 2;

  type Seg = { cx: number; cy: number; rx: number; ry: number; rot?: number; region?: string };
  const mirror = (t: Omit<Seg, "cx"> & { dx: number }): Seg[] => [
    { ...t, cx: CX - t.dx, rot: t.rot ? -t.rot : 0 },
    { ...t, cx: CX + t.dx },
  ];

  const thorax: Seg = { cx: CX, cy: 71, rx: chestR, ry: 22, region: "chest" };
  const waistSeg: Seg = { cx: CX, cy: 106, rx: waistR, ry: 12, region: "waist" };
  const pelvis: Seg = { cx: CX, cy: 131, rx: hipR, ry: 12.5 };
  const arms = mirror({ dx: armCx, cy: 76, rx: armR, ry: 21, rot: 6, region: "arms" });
  const forearms = mirror({ dx: armCx + 3, cy: 114, rx: foreR, ry: 18, rot: 9, region: "arms" });
  const thighs = mirror({ dx: thighCx, cy: 159, rx: thighR, ry: 25, region: "legs" });
  const calves = mirror({ dx: kneeCx, cy: 205, rx: calfR, ry: 16, region: "legs" });

  const ell = (g: Seg, attrs = `fill="url(#bmfig-base)"`) => {
    const tr = g.rot ? ` transform="rotate(${g.rot} ${g.cx} ${g.cy})"` : "";
    return `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}"${tr} ${attrs}/>`;
  };
  const ball = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#bmfig-base)"/>`;

  // Back-to-front: limbs behind, torso stack, joints and head on top.
  let body = "";
  for (const g of [...forearms, ...arms]) body += ell(g);
  body += ball(CX - armCx - 5.5, 135, 4.5) + ball(CX + armCx + 5.5, 135, 4.5); // hands
  for (const g of [...thighs, ...calves]) body += ell(g);
  body += `<ellipse cx="${CX - kneeCx - 3}" cy="226" rx="8" ry="3.2" fill="url(#bmfig-base)"/><ellipse cx="${CX + kneeCx + 3}" cy="226" rx="8" ry="3.2" fill="url(#bmfig-base)"/>`; // feet
  body += ball(CX - kneeCx, 187, 4) + ball(CX + kneeCx, 187, 4); // knees
  body += ell(pelvis) + ell(waistSeg) + ell(thorax);
  body += `<ellipse cx="${CX}" cy="46" rx="${neckR}" ry="6" fill="url(#bmfig-base)"/>`;
  body += `<ellipse cx="${CX}" cy="25" rx="9.5" ry="13" fill="url(#bmfig-base)"/>`;
  body += ball(CX - shR * 0.82, 54, 5) + ball(CX + shR * 0.82, 54, 5); // shoulder balls

  // Focus / winning tints over the base pieces (same shapes, soft washes).
  const regionSegs: Record<string, Seg[]> = {
    waist: [waistSeg],
    chest: [thorax],
    arms: [...arms, ...forearms],
    legs: [...thighs, ...calves],
  };
  // One chevron per region's primary piece only (thorax / upper arms / thighs) —
  // marking every segment turned the mannequin into noise.
  const regionMarks: Record<string, Seg[]> = { chest: [thorax], arms, legs: thighs };
  let tints = "";
  let marks = "";
  if (inp.focus) for (const g of regionSegs[inp.focus] || []) tints += ell(g, `fill="${BM_FIG_ACCENT}" opacity="0.15"`);
  for (const w of inp.wins || []) {
    if (w === inp.focus) continue;
    for (const g of regionSegs[w] || []) tints += ell(g, `fill="${BM_FIG_SAGE}" opacity="0.09"`);
    for (const g of regionMarks[w] || []) {
      const y = g.cy - g.ry * 0.45;
      marks += `<path d="M${g.cx - 4} ${y + 5} L${g.cx} ${y} L${g.cx + 4} ${y + 5}" fill="none" stroke="${BM_FIG_SAGE_DEEP}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
    }
  }

  // The optimal-waist trace: dashed sage ellipse at waist height, drawn only
  // when the measured waist sits above the band (a leaner-than-optimal waist
  // needs no target drawn over it).
  const waistIn = inVal("waist_in");
  const optWaistIn = inp.heightIn != null ? 0.5 * Math.min(90, Math.max(48, inp.heightIn)) : null;
  const showOpt = waistIn != null && optWaistIn != null && waistIn > optWaistIn + 0.2;
  const optR = optWaistIn != null ? torsoRx(optWaistIn) : 0;
  const optTrace = showOpt
    ? `<ellipse cx="${CX}" cy="106" rx="${optR}" ry="12.6" fill="none" stroke="${BM_FIG_SAGE}" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.9"/>`
    : "";

  // Hairline callouts: measured sites only, values in the display unit, trend
  // arrows from the ~6-month tape trend. Right rail = torso + legs, left rail
  // = neck/shoulder/arms; a spacing pass keeps labels from colliding.
  type Callout = { side: "L" | "R"; segY: number; x1: number; name: string; val: string; dir: string; site?: BmSiteKey; accent?: boolean; sage?: boolean };
  // Only moving sites get an arrow — a "steady →" glyph next to a leader line
  // reads as pointing at the figure.
  const arrow = (k: string) => {
    const d = inp.dirs ? inp.dirs[k] : null;
    return d === "down" ? "↓" : d === "up" ? "↑" : "";
  };
  const cos: Callout[] = [];
  const add = (k: BmSiteKey, side: "L" | "R", segY: number, edge: number, name: string) => {
    if (!measured(k)) return;
    cos.push({ side, segY, x1: side === "R" ? CX + edge + 3 : CX - edge - 3, name, val: dispVal(k), dir: arrow(k), site: k, accent: k === "waist_in" && inp.focus === "waist" });
  };
  add("chest_in", "R", 71, chestR, "chest");
  add("waist_in", "R", 106, waistR, "waist");
  if (showOpt) cos.push({ side: "R", segY: 112, x1: CX + optR + 2, name: "optimal", val: bmFmt(inp.unit === "cm" ? (optWaistIn as number) * 2.54 : (optWaistIn as number)), dir: "", sage: true });
  add("hip_in", "R", 131, hipR, "hip");
  add("thigh_in", "R", 159, thighCx + thighR, "thigh");
  add("calf_in", "R", 205, kneeCx + calfR, "calf");
  add("neck_in", "L", 46, neckR, "neck");
  add("shoulder_in", "L", 54, shR * 0.82 + 5, "shoulder");
  add("upper_arm_in", "L", 76, armCx + armR, "arm");
  add("forearm_in", "L", 114, armCx + 3 + foreR, "forearm");

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
      callouts += `<line x1="${c.x1}" y1="${c.segY}" x2="${lineEnd}" y2="${y - 3}" stroke="${BM_FIG_LINE}" stroke-width="1" stroke-dasharray="1.5 2.5"/>`;
      const label = `<text x="${tx}" y="${y}" text-anchor="${side === "R" ? "start" : "end"}" font-family="ui-sans-serif, system-ui, sans-serif"><tspan font-size="8.2" letter-spacing="0.08em" fill="${nameColor}"${c.sage ? ` font-style="italic"` : ""}>${escHtml(c.name.toUpperCase())}</tspan><tspan dx="4" font-size="11.5" font-weight="600" font-family="ui-serif, Georgia, serif" fill="${color}">${escHtml(c.val)}</tspan>${c.dir ? `<tspan dx="2" font-size="9.5" fill="${BM_FIG_MUTED}">${escHtml(c.dir)}</tspan>` : ""}</text>`;
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
    <defs><linearGradient id="bmfig-base" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e7ddcb"/><stop offset="100%" stop-color="#dbcfb8"/></linearGradient></defs>
    <g stroke="${BM_FIG_LINE}" stroke-width="1.1">${body}</g>
    ${tints}${optTrace}${marks}${callouts}
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
function compSection(data: BmSummary, unit: BmUnit): string {
  const comp = data.comp;
  if (!comp) return "";
  const { focus: figFocus, wins } = deriveFigureRegions(comp, data.trends);
  const dirs: Record<string, "up" | "down" | "steady" | null> = {};
  for (const t of data.trends?.sites || []) dirs[t.key] = t.direction;
  const merged = mergeLatestSites(data.measurements, data.latest);
  const figure = bodyFigureSvg({
    latest: merged,
    heightIn: data.profile?.height_in ?? null,
    sex: data.profile?.sex || "male",
    unit,
    focus: figFocus,
    wins,
    dirs,
  });
  // Mention the dashed trace only when the figure actually draws it (waist
  // measured, height known, and the waist sits above the optimal band).
  const waistIn = merged?.waist_in != null ? (unit === "cm" ? (merged.waist_in as number) / 2.54 : (merged.waist_in as number)) : null;
  const optDrawn = waistIn != null && data.profile?.height_in != null && waistIn > 0.5 * data.profile.height_in + 0.2;
  const legendBits: string[] = [`tape · ${unit === "cm" ? "centimeters" : "inches"}`];
  if (optDrawn) legendBits.push(`<span style="color:var(--sage-text,#5f6e4f)">┄ the optimal waist for your height</span>`);
  const legend = data.latest
    ? `<div class="sess-line" style="color:var(--muted,#746c5c);font-size:.74rem;text-align:center;margin-top:6px">${legendBits.join(" · ")}</div>`
    : `<div class="sess-line" style="color:var(--muted,#746c5c);text-align:center;margin-top:6px">Log your first tape session above and the figure redraws to your measurements.</div>`;
  const heading = comp.heading
    ? `<div class="sess-line bm-heading" style="color:var(--ink-2,#57503f);margin-top:12px">${escHtml(comp.heading)}</div>`
    : "";
  const focus = comp.focus
    ? `<div class="bm-focus" style="border-left:3px solid var(--accent,#b4552d);background:var(--accent-wash,rgba(180,85,45,.1));border-radius:8px;padding:10px 12px;margin-top:10px">
        <div style="font-weight:600;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--accent,#b4552d);margin-bottom:3px">Where to point it</div>
        <div class="sess-line">${escHtml(comp.focus.line)}</div>
      </div>`
    : "";
  return `<div class="sess bm-comp reveal" style="padding:14px 12px;margin-bottom:12px">
      <div class="bm-sechead" style="font-weight:600;margin-bottom:8px">Where you stand</div>
      ${figure}
      ${legend}${heading}${focus}
    </div>`;
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
  wire(mount, unit);
}

function wire(mount: HTMLElement, unit: BmUnit): void {
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
  mount.querySelectorAll(".bm-co").forEach((g) => {
    const site = (g as HTMLElement).dataset.site || "";
    g.addEventListener("click", () => jumpToTrend(site));
    g.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        jumpToTrend(site);
      }
    });
  });

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

const CAIRN_BODY_METRICS = { renderBodyMetrics, deriveFigureRegions, bodyFigureSvg, mergeLatestSites };
Object.assign(globalThis, { CairnBodyMetrics: CAIRN_BODY_METRICS, renderBodyMetrics });
if (typeof window !== "undefined") {
  (window as unknown as { CairnBodyMetrics: typeof CAIRN_BODY_METRICS }).CairnBodyMetrics = CAIRN_BODY_METRICS;
}
})();
