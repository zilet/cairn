// @ts-check
// ---------- Progress: the Train overview (the training home) ----------
// The landing view of the Train tab: one glanceable, whole-picture read of the
// week's training — how the week is going, which muscle groups are due /
// productive / running high / recovering (the front+back muscle map), where the
// conductor says to focus, the handful of week-by-week moves the engine noticed,
// and the latest sessions. Every number here is honest logging data (sets,
// sessions, pounds moved) — never a grade; bands stay plain words per the
// constitution. Deterministic reads paint instantly (sessionStorage snapshot +
// revalidate); the agentic layer only ever suggests.

type TovBalanceGroup = { group?: unknown; sets?: unknown; band?: unknown; last_trained?: unknown; status?: unknown };
type TovTrajectoryGroup = { group?: unknown; label?: unknown; verdict?: unknown; trend?: unknown; note?: unknown };
type TovLoadGroup = { group?: unknown; days_ago?: unknown; heavy?: unknown; activity?: unknown; detail?: unknown };
type TovAdjustment = { kind?: unknown; title?: unknown; why?: unknown };
type TovFocusItem = { domain?: unknown; title?: unknown; why?: unknown; move?: unknown };
type TovData = {
  stats: Record<string, unknown> | null;
  balance: Record<string, unknown> | null;
  trajectory: Record<string, unknown> | null;
  focus: Record<string, unknown> | null;
  load: Record<string, unknown> | null;
  adjustments: unknown[] | null;
  sessions: unknown[] | null;
  journey: import("../contracts/client-api.js").ClientJourneyRead | null;
  journeyMilestones: import("../contracts/client-api.js").ClientJourneyMilestone[] | null;
};

// SVG paint attrs don't reliably resolve CSS var() — hardcoded Atelier hexes,
// same convention as the Body figure (body-metrics-client.ts).
const TOV_FIG_LINE = "#c4b89d";
const TOV_FIG_BASE = "#eae0cd";
const TOV_TONE_FILL: Record<string, { fill: string; op: number }> = {
  due: { fill: "#b4552d", op: 0.32 },      // terracotta — under its productive range / not trained lately
  ok: { fill: "#6e7f5c", op: 0.34 },       // sage — in the productive band
  high: { fill: "#c9a86a", op: 0.5 },      // gold — running above the productive band
  recover: { fill: "#57503f", op: 0.18 },  // soft graphite — a real dose landed in the last day; resting is right
};

// Front/back muscle zones as ellipse packs over a shared base silhouette.
// [cx, cy, rx, ry, rotate?] — mirrored pairs listed explicitly.
type TovZone = ReadonlyArray<readonly number[]>;
const TOV_FRONT_ZONES: Record<string, TovZone> = {
  shoulders: [[47, 54, 8, 6.5], [103, 54, 8, 6.5]],
  chest: [[64, 62, 10.5, 7.5], [86, 62, 10.5, 7.5]],
  biceps: [[45, 72, 6, 11, 12], [105, 72, 6, 11, -12]],
  forearms: [[38, 106, 5, 13, 14], [112, 106, 5, 13, -14]],
  core: [[75, 92, 12, 15]],
  quads: [[63, 146, 9.5, 22], [87, 146, 9.5, 22]],
};
const TOV_BACK_ZONES: Record<string, TovZone> = {
  "rear delts": [[47, 54, 7.5, 6], [103, 54, 7.5, 6]],
  back: [[75, 54, 14, 9], [63, 78, 9.5, 14], [87, 78, 9.5, 14]],
  triceps: [[45, 74, 6, 11, 12], [105, 74, 6, 11, -12]],
  glutes: [[66, 116, 9.5, 8.5], [84, 116, 9.5, 8.5]],
  hamstrings: [[63, 150, 9.5, 20], [87, 150, 9.5, 20]],
  calves: [[60, 196, 6, 14], [90, 196, 6, 14]],
};
// Row order when nothing demands attention — a steady anatomical scan.
const TOV_GROUP_ORDER = [
  "chest", "back", "shoulders", "rear delts", "biceps", "triceps", "forearms",
  "core", "quads", "hamstrings", "glutes", "calves",
];

let tovData: TovData | null = null;
let tovToken = 0;
const TOV_SNAP_KEY = "cairn.train.v1";
// Above this, skip the localStorage copy — a pathological payload shouldn't hog
// a disproportionate share of the ~5MB quota shared with every other persisted
// key (the sessionStorage copy below has no such ceiling; it's tab-scoped).
const TOV_SNAP_MAX_BYTES = 200_000;

function tovSaveSnapshot(data: TovData): void {
  let json: string;
  try { json = JSON.stringify(data); } catch { return; }
  try { sessionStorage.setItem(TOV_SNAP_KEY, json); } catch { /* quota — skip */ }
  // Unlike the plain SWR cache (which deliberately keeps health-prefixed keys
  // memory/session-only, see swr-cache.ts), this is training/muscle-balance data,
  // not health-sensitive lab/recovery data — persist it to localStorage too, the
  // same way the Brief does, so the Train overview paints instantly on a genuine
  // cold app launch (not just a same-session tab switch), not only mid-session.
  if (json.length <= TOV_SNAP_MAX_BYTES) {
    try { localStorage.setItem(TOV_SNAP_KEY, json); } catch { /* quota — skip */ }
  }
}
function tovLoadSnapshot(): TovData | null {
  try {
    // sessionStorage first (this tab's own last paint, always freshest when
    // present); localStorage as the cold-launch fallback (a new tab/process has
    // no sessionStorage yet, but may have a prior session's persisted copy).
    const raw = sessionStorage.getItem(TOV_SNAP_KEY) || localStorage.getItem(TOV_SNAP_KEY) || "null";
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && "balance" in parsed ? parsed as TovData : null;
  } catch { return null; }
}

async function tovFetch(): Promise<TovData> {
  const grab = (path: string) => api(path).catch(() => null);
  const [stats, balance, trajectory, focus, load, adjustments, sessions, journey, journeyMilestones] = await Promise.all([
    grab("/stats"),
    grab("/program/balance"),
    grab("/muscle-trajectory"),
    grab("/coaching-focus"),
    grab("/muscle-load"),
    grab("/program/adjustments"),
    grab("/sessions?limit=3"),
    grab("/journey"),
    grab("/journey/milestones"),
  ]);
  return {
    stats: CairnProgressData.record(stats),
    balance: CairnProgressData.record(balance),
    trajectory: CairnProgressData.record(trajectory),
    focus: CairnProgressData.record(focus),
    load: CairnProgressData.record(load),
    adjustments: Array.isArray(adjustments) ? adjustments : null,
    sessions: Array.isArray(sessions) ? sessions : null,
    journey: journey && typeof journey === "object" && !Array.isArray(journey) ? journey as import("../contracts/client-api.js").ClientJourneyRead : null,
    journeyMilestones: Array.isArray(journeyMilestones) ? journeyMilestones as import("../contracts/client-api.js").ClientJourneyMilestone[] : null,
  };
}

// SWR entry: paint the last-known read instantly, then revalidate. Guarded
// against painting over a switched-away tab (the renderToday lesson).
async function renderTrainOverview(): Promise<void> {
  headerTitle.textContent = "Train";
  state.progressSeg = "overview";
  const token = ++tovToken;
  if (!tovData) tovData = tovLoadSnapshot();
  if (tovData) paintTrainOverview(tovData);
  else view.innerHTML = segSkeleton("overview", PROGRESS_SEG, 3);
  const fresh = await tovFetch();
  if (token !== tovToken || state.tab !== "progress" || state.progressSeg !== "overview") return;
  const changed = JSON.stringify(fresh) !== JSON.stringify(tovData);
  tovData = fresh;
  tovSaveSnapshot(fresh);
  if (changed || !document.querySelector(".tov-mast, .tov-empty")) paintTrainOverview(fresh);
}

// ---- data folding -------------------------------------------------------------

function tovGroupKey(value: unknown): string {
  return String(value || "").toLowerCase().trim();
}
type TovRow = {
  group: string;
  label: string;
  tone: string;            // due | ok | high | recover | none
  sets: number;
  band: string;            // low | productive | high | ""
  verdict: string;         // advancing | stalling | building | maintaining | ""
  trend: string;           // rising | falling | stable | ""
  loadNote: string;        // "recovering from yesterday's ~2 h ride"
};

function tovFoldRows(data: TovData): TovRow[] {
  const balance = new Map<string, TovBalanceGroup>();
  for (const g of CairnProgressData.rows<TovBalanceGroup>(data.balance?.groups)) balance.set(tovGroupKey(g.group), g);
  const traj = new Map<string, TovTrajectoryGroup>();
  for (const g of CairnProgressData.rows<TovTrajectoryGroup>(data.trajectory?.groups)) traj.set(tovGroupKey(g.group), g);
  const load = new Map<string, TovLoadGroup>();
  for (const g of CairnProgressData.rows<TovLoadGroup>(data.load?.groups)) load.set(tovGroupKey(g.group), g);

  const keys = new Set<string>([...TOV_GROUP_ORDER, ...balance.keys(), ...traj.keys()]);
  keys.delete("mobility");
  const rows: TovRow[] = [];
  for (const key of keys) {
    const b = balance.get(key);
    const t = traj.get(key);
    const l = load.get(key);
    const sets = CairnProgressData.number(b?.sets);
    const band = String(b?.band || "");
    const status = String(b?.status || "");
    const fresh = !!l && CairnProgressData.number(l.days_ago, 9) <= 1 && !!l.heavy;
    const tone = fresh ? "recover"
      : status === "due" ? "due"
      : band === "high" || status === "high" ? "high"
      : band === "productive" || sets > 0 ? "ok"
      : "none";
    let loadNote = "";
    if (fresh && l) {
      const when = CairnProgressData.number(l.days_ago, 0) <= 0 ? "today" : "yesterday";
      const what = l.activity ? `${when}'s ${l.detail ? `${l.detail} ` : ""}${l.activity}` : `${when}'s session`;
      loadNote = `recovering from ${what}`;
    }
    rows.push({
      group: key,
      label: String(t?.label || key),
      tone,
      sets,
      band,
      verdict: String(t?.verdict || ""),
      trend: String(t?.trend || ""),
      loadNote,
    });
  }
  const attention: Record<string, number> = { due: 0, recover: 1, high: 2, ok: 3, none: 4 };
  const anatomical = (g: string) => { const i = TOV_GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };
  rows.sort((a, b) => (attention[a.tone] - attention[b.tone]) || (anatomical(a.group) - anatomical(b.group)));
  return rows;
}

// ---- the figure ---------------------------------------------------------------

function tovEllipse(shape: readonly number[], attrs: string): string {
  const [cx, cy, rx, ry, rot] = shape;
  const transform = rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : "";
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${transform} ${attrs}/>`;
}

// The vendored elite body figure (public/cairn-body-figure.js) — real muscle
// heads, ab segmentation, twin gastrocs (design option 2a). Guarded exactly like
// art(): a missing/stale lib degrades to the ellipse-pack fallback below, so the
// muscle map always draws.
function tovFigureLib(): CairnBodyFigureApi | null {
  try {
    return (window as unknown as { CairnBodyFigure?: CairnBodyFigureApi }).CairnBodyFigure || null;
  } catch {
    return null;
  }
}

// tones fold maps 1:1 to the library's group keys; pulseDue breathes the due
// groups and dataAttrs stamps data-group so a tap on a muscle jumps to its row.
function tovFigureSvg(side: "front" | "back", tones: Record<string, string>): string {
  const lib = tovFigureLib();
  if (lib) return tovPlateSvg(lib.figureSvg(side, tones, { pulseDue: true, dataAttrs: true }), side);
  return tovFigureSvgFallback(side, tones);
}

// The atelier plate: post-compose the library's figure (never edit the vendored
// lib) so it reads as an object, not an icon — modeling light on the silhouette,
// each muscle tone an airbrushed radial wash (dense at the belly, feathered at
// the edge; per-path objectBoundingBox does this per muscle for free), and a
// still-life ground shadow under the feet. IDs are side-suffixed because front
// and back render as sibling inline SVGs in the same document.
function tovPlateSvg(svg: string, side: string): string {
  const p = `tovg-${side}`;
  const swap = (s: string, from: string, to: string) => s.split(from).join(to);
  const tone = (id: string, hex: string) =>
    `<radialGradient id="${p}-${id}" cx="0.5" cy="0.42" r="0.78"><stop offset="0%" stop-color="${hex}"/><stop offset="62%" stop-color="${hex}" stop-opacity="0.85"/><stop offset="100%" stop-color="${hex}" stop-opacity="0.42"/></radialGradient>`;
  const defs =
    `<defs>` +
    `<linearGradient id="${p}-relief" x1="0" y1="0" x2="0.7" y2="1"><stop offset="0%" stop-color="#f3ecdd"/><stop offset="48%" stop-color="#ede4d1"/><stop offset="100%" stop-color="#ddd0b5"/></linearGradient>` +
    tone("due", "#b4552d") +
    tone("ok", "#6e7f5c") +
    tone("high", "#c9a86a") +
    tone("recover", "#57503f") +
    `<filter id="${p}-gblur" x="-40%" y="-160%" width="180%" height="420%"><feGaussianBlur stdDeviation="2.6"/></filter>` +
    `</defs>` +
    `<ellipse cx="130" cy="629" rx="60" ry="5.5" fill="#211d17" opacity="0.08" filter="url(#${p}-gblur)"/>`;
  let out = svg.replace(/(<svg[^>]*>)/, `$1${defs}`);
  out = swap(out, 'fill="#ede4d1"', `fill="url(#${p}-relief)"`);
  out = swap(out, 'fill="#b4552d"', `fill="url(#${p}-due)"`);
  out = swap(out, 'fill="#6e7f5c"', `fill="url(#${p}-ok)"`);
  out = swap(out, 'fill="#c9a86a"', `fill="url(#${p}-high)"`);
  out = swap(out, 'fill="#57503f"', `fill="url(#${p}-recover)"`);
  return out;
}

function tovFigureSvgFallback(side: "front" | "back", tones: Record<string, string>): string {
  const base = `fill="${TOV_FIG_BASE}" stroke="${TOV_FIG_LINE}" stroke-width="1"`;
  const silhouette = [
    `<circle cx="75" cy="22" r="12" ${base}/>`,
    `<rect x="70" y="31" width="10" height="11" rx="4.5" ${base}/>`,
    tovEllipse([75, 72, 26, 32], base),
    tovEllipse([75, 114, 19, 13], base),
    tovEllipse([45, 72, 7.5, 19, 12], base),
    tovEllipse([105, 72, 7.5, 19, -12], base),
    tovEllipse([38, 106, 5.5, 16, 14], base),
    tovEllipse([112, 106, 5.5, 16, -14], base),
    `<circle cx="33" cy="126" r="3.5" ${base}/>`,
    `<circle cx="117" cy="126" r="3.5" ${base}/>`,
    tovEllipse([63, 148, 10.5, 26], base),
    tovEllipse([87, 148, 10.5, 26], base),
    tovEllipse([60, 200, 6.5, 22], base),
    tovEllipse([90, 200, 6.5, 22], base),
    tovEllipse([58, 226, 7, 4], base),
    tovEllipse([92, 226, 7, 4], base),
  ].join("");
  const zones = side === "front" ? TOV_FRONT_ZONES : TOV_BACK_ZONES;
  let overlays = "";
  for (const group of Object.keys(zones)) {
    const tone = TOV_TONE_FILL[tones[group] || ""];
    if (!tone) continue;
    for (const shape of zones[group]) {
      overlays += tovEllipse(shape, `fill="${tone.fill}" opacity="${tone.op}"`);
    }
  }
  return `<svg class="tov-fig" viewBox="0 0 150 236" aria-hidden="true">${silhouette}${overlays}</svg>`;
}

// ---- section renderers ----------------------------------------------------------

function tovHeadline(data: TovData, rows: TovRow[]): string {
  const stats = data.stats || {};
  const done = CairnProgressData.number(stats.week_done);
  const planned = CairnProgressData.number(stats.week_planned);
  const opener = planned > 0
    ? (done >= planned ? "Week complete — every planned session is in."
      : `${done} of ${planned} sessions in this week.`)
    : done > 0 ? `${done} session${done === 1 ? "" : "s"} in this week.` : "";
  const due = rows.filter((r) => r.tone === "due").map((r) => r.label);
  const advancing = rows.filter((r) => r.verdict === "advancing").map((r) => r.label);
  const clause = due.length ? `${due.slice(0, 2).join(" and ")} ${due.length === 1 ? "is" : "are"} due.`
    : advancing.length ? `${advancing.slice(0, 2).join(" and ")} ${advancing.length === 1 ? "is" : "are"} advancing.`
    : "";
  return [opener, clause].filter(Boolean).join(" ") || "Your training, in one look.";
}

function tovMastHtml(data: TovData, rows: TovRow[]): string {
  const stats = data.stats || {};
  const done = CairnProgressData.number(stats.week_done);
  const planned = CairnProgressData.number(stats.week_planned);
  const sets = CairnProgressData.number(stats.week_sets);
  const tonnage = CairnProgressData.number(stats.week_tonnage);
  const streak = CairnProgressData.number(stats.streak);
  const stat = (n: string, l: string, cu?: number) =>
    `<div class="stat"><div class="stat-n"${cu != null ? ` data-cu="${cu}"` : ""}>${escHtml(n)}</div><div class="stat-l">${escHtml(l)}</div></div>`;
  const strip = [
    planned > 0 ? stat(`${done}/${planned}`, "sessions · week") : stat(String(done), "sessions · week"),
    stat(String(sets), "sets · 7d", sets),
    stat(tonnage >= 1000 ? `${(tonnage / 1000).toFixed(1)}k` : String(Math.round(tonnage)), "lb moved · 7d"),
    streak > 1 ? stat(String(streak), "day streak", streak) : "",
  ].filter(Boolean).join("");
  return `<div class="tov-mast reveal" style="${stagger(0)}">
    <div class="lbl">This week</div>
    <h2 class="tov-mast-h">${escHtml(tovHeadline(data, rows))}</h2>
    <div class="statstrip">${strip}</div>
  </div>`;
}

function tovVerdictChip(row: TovRow): string {
  if (row.verdict === "advancing") return `<span class="tov-chip tov-chip-adv">advancing ↗</span>`;
  if (row.verdict === "stalling") return `<span class="tov-chip tov-chip-stall">stalling</span>`;
  if (row.verdict === "building") return `<span class="tov-chip">building</span>`;
  return "";
}

function tovBandBar(row: TovRow): string {
  // Categorical you-are-here: three zones (below / productive / above), the
  // productive band shaded sage — position-vs-band, never a plotted number.
  // A quiet group gets no bar at all; an empty track is just noise.
  if (row.sets <= 0) return "";
  const dotLeft = row.band === "low" || row.tone === "due" ? 16
    : row.band === "high" ? 84
    : 50;
  return `<div class="tov-band"><span class="tov-band-zone"></span><span class="tov-band-dot tov-dot-${row.tone}" style="left:${dotLeft}%"></span></div>`;
}

function tovRowNote(row: TovRow): string {
  const parts: string[] = [];
  if (row.sets > 0) parts.push(`${row.sets} set${row.sets === 1 ? "" : "s"} this week`);
  if (row.band === "productive") parts.push("in the productive range");
  else if (row.band === "high") parts.push("above the productive range");
  else if (row.tone === "due") parts.push(row.sets > 0 ? "room for more" : "not trained lately");
  if (row.loadNote) parts.push(row.loadNote);
  if (!parts.length && row.tone === "none") {
    // No working sets inside the balance window. "Quiet lately" when there's
    // longer-horizon history (a trajectory verdict exists); a true blank otherwise.
    return row.verdict ? "quiet the last two weeks" : "nothing logged yet";
  }
  return parts.join(" · ");
}

function tovMapHtml(rows: TovRow[]): string {
  const tones: Record<string, string> = {};
  for (const row of rows) if (row.tone !== "none") tones[row.group] = row.tone;
  const legend = [
    ["due", "Due"], ["ok", "On track"], ["high", "Running high"], ["recover", "Recovering"],
  ].map(([k, l]) => `<span class="tov-leg"><i class="tov-leg-dot tov-dot-${k}"></i>${l}</span>`).join("");
  return `<div class="tov-map sess reveal" style="${stagger(1)}">
    <div class="lbl">Muscle balance</div>
    <div class="tov-figs">
      <figure><figcaption class="lbl">Front</figcaption>${tovFigureSvg("front", tones)}</figure>
      <figure><figcaption class="lbl">Back</figcaption>${tovFigureSvg("back", tones)}</figure>
    </div>
    <div class="tov-legend">${legend}</div>
  </div>`;
}

function tovRowsHtml(rows: TovRow[]): string {
  const visible = rows.filter((r) => r.tone !== "none" || TOV_GROUP_ORDER.includes(r.group));
  if (!visible.length) return "";
  const items = visible.map((row, i) => `
    <button class="tov-row reveal" type="button" data-tovgo="program" data-group="${escAttr(row.group)}" style="${stagger(Math.min(i + 2, 12))}">
      <span class="tov-row-dot tov-dot-${row.tone === "none" ? "idle" : row.tone}"></span>
      <span class="tov-row-main">
        <span class="tov-row-top"><span class="tov-row-name">${escHtml(tovCapitalize(row.label))}</span>${tovVerdictChip(row)}</span>
        ${tovBandBar(row)}
        <span class="tov-row-note">${escHtml(tovRowNote(row) || "nothing logged yet")}</span>
      </span>
      <span class="tov-row-arw">›</span>
    </button>`).join("");
  return `<div class="tov-kicker lbl reveal" style="${stagger(2)}">Working sets per week, against your productive range</div>${items}`;
}

function tovCapitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function tovFocusHtml(data: TovData): string {
  const focus = data.focus || {};
  const lead = (focus.lead || null) as TovFocusItem | null;
  if (!focus.available || !lead || !lead.title) return "";
  const move = lead.move ? `<div class="tov-focus-move">${escHtml(lead.move)}</div>` : "";
  const retest = (focus.retest || null) as Record<string, unknown> | null;
  const retestNames = (retest && Array.isArray(retest.focus) ? retest.focus : [])
    .map((name) => String(name || "").trim())
    .filter((name) => name && name.toLowerCase() !== "unknown");
  const retestWeeks = CairnProgressData.number(retest?.in_weeks);
  const retestLine = retestNames.length && retestWeeks >= 1
    ? `<div class="tov-focus-retest">Re-test ${escHtml(retestNames.join(", "))} in ~${retestWeeks} wk</div>`
    : "";
  return `<div class="well-accent tov-focus reveal" style="${stagger(3)}">
    <div class="lbl">Where to focus</div>
    <div class="tov-focus-title">${escHtml(lead.title)}</div>
    ${lead.why ? `<div class="tov-focus-why">${escHtml(lead.why)}</div>` : ""}
    ${move}${retestLine}
    <button class="linkbtn linkbtn-sm" type="button" data-tovgo="program">Full program read ›</button>
  </div>`;
}

function tovMovesHtml(data: TovData): string {
  const moves = CairnProgressData.rows<TovAdjustment>(data.adjustments).slice(0, 3);
  if (!moves.length) return "";
  const rows = moves.map((m) => `
    <div class="tov-move">
      <span class="tov-row-dot tov-dot-${String(m.kind) === "deload" ? "recover" : String(m.kind) === "balance" || String(m.kind) === "gap" ? "due" : "ok"}"></span>
      <span class="tov-move-main"><b>${escHtml(m.title)}</b>${m.why ? `<span class="tov-move-why">${escHtml(m.why)}</span>` : ""}</span>
    </div>`).join("");
  return `<div class="sess tov-moves reveal" style="${stagger(4)}">
    <div class="lbl">Week by week</div>
    ${rows}
    <button class="linkbtn linkbtn-sm" type="button" data-tovgo="program">All adjustments ›</button>
  </div>`;
}

function tovSessionsHtml(data: TovData): string {
  const sessions = CairnProgressData.rows<Record<string, unknown>>(data.sessions);
  if (!sessions.length) return "";
  const rows = sessions.map((s) => {
    const sets = Array.isArray(s.sets) ? s.sets.length : 0;
    const when = s.date && typeof relAge === "function" ? relAge(String(s.date)) : String(s.date || "");
    return `<button class="tov-sess" type="button" data-tovgo="sessions">
      <span class="tov-sess-name">${escHtml(s.title || s.day_name || "Session")}</span>
      <span class="tov-sess-meta">${escHtml(when)}${sets ? ` · ${sets} set${sets === 1 ? "" : "s"}` : ""}</span>
      <span class="tov-row-arw">›</span>
    </button>`;
  }).join("");
  return `<div class="tov-recent reveal" style="${stagger(5)}">
    <div class="lbl">Latest sessions</div>
    ${rows}
    <button class="linkbtn linkbtn-sm" type="button" data-tovgo="sessions">All history ›</button>
  </div>`;
}

function tovJourneyHtml(data: TovData): string {
  return CairnProgressJourney?.journeyCardHtml?.(data.journey, data.journeyMilestones, { stagger }) || "";
}

// ---- paint ----------------------------------------------------------------------

function paintTrainOverview(data: TovData): void {
  const head = segBar("overview", PROGRESS_SEG);
  const rows = tovFoldRows(data);
  const hasAny = rows.some((r) => r.sets > 0) || CairnProgressData.rows(data.sessions).length > 0;
  const journey = tovJourneyHtml(data);
  if (!hasAny) {
    view.innerHTML = head + `<div class="tov-empty">` +
      journey +
      emptyStateHtml(art("exercise", "barbell row"), "Log a session and this becomes your training map — what's trained, what's due, and where to push next.") +
      `</div>`;
    wireSeg(PROGRESS_HANDLERS);
    CairnProgressJourney?.wire?.(view);
    return;
  }
  view.innerHTML = head +
    tovMastHtml(data, rows) +
    journey +
    tovMapHtml(rows) +
    tovFocusHtml(data) +
    tovRowsHtml(rows) +
    tovMovesHtml(data) +
    tovSessionsHtml(data);
  wireSeg(PROGRESS_HANDLERS);
  CairnProgressJourney?.wire?.(view);
  runCountUps(view);
  view.querySelectorAll<HTMLElement>("[data-tovgo]").forEach((el) =>
    el.addEventListener("click", () => {
      const handler = PROGRESS_HANDLERS[String(el.dataset.tovgo || "")];
      if (!handler) return;
      withViewTransition(() => Promise.resolve(handler()).then(() => {
        if (typeof syncRouteFromState === "function") syncRouteFromState();
        viewEnter();
      }));
    })
  );
  // Tap a muscle on the figure → scroll to its row and flash it. The elite figure
  // stamps data-group on each toned muscle (scoped to .tov-map so the row buttons,
  // which also carry data-group, aren't rebound); the ellipse-pack fallback carries
  // none, so this is simply a no-op there.
  view.querySelectorAll<SVGElement>(".tov-map [data-group]").forEach((el) => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      const group = el.getAttribute("data-group") || "";
      const row = group ? view.querySelector<HTMLElement>(`.tov-row[data-group="${group}"]`) : null;
      if (!row) return;
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      row.style.transition = "background-color .5s ease";
      row.style.borderRadius = "10px";
      row.style.backgroundColor = "var(--sage-bg, #eef0e6)";
      setTimeout(() => { row.style.backgroundColor = "transparent"; }, 1100);
    });
  });
}

Object.assign(globalThis, { renderTrainOverview });
if (typeof window !== "undefined") Object.assign(window, { renderTrainOverview });
