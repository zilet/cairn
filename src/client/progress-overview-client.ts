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
type TovLoadGroup = {
  group?: unknown;
  days_ago?: unknown;
  heavy?: unknown;
  saturated?: unknown;
  activity?: unknown;
  detail?: unknown;
};
type TovAdjustment = { kind?: unknown; title?: unknown; why?: unknown };
type TovData = {
  stats: Record<string, unknown> | null;
  balance: Record<string, unknown> | null;
  trajectory: Record<string, unknown> | null;
  focus: Record<string, unknown> | null;
  load: Record<string, unknown> | null;
  loadBand: Record<string, unknown> | null;
  adjustments: unknown[] | null;
  sessions: unknown[] | null;
  journey: import("../contracts/client-api.js").ClientJourneyRead | null;
  journeyMilestones: import("../contracts/client-api.js").ClientJourneyMilestone[] | null;
  timeline: import("../contracts/client-api.js").ClientForwardTimelineEntry[] | null;
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

let tovToken = 0;

// The overview's reads, in the order tovCompose() folds them.
function tovPaths(): string[] {
  return [
    "/stats",
    "/program/balance",
    "/muscle-trajectory",
    "/coaching-focus",
    "/muscle-load",
    "/training-load",
    "/program/adjustments",
    "/sessions?limit=3",
    "/journey",
    "/journey/milestones",
    "/journey/timeline",
  ];
}

function tovCompose(values: unknown[]): TovData {
  const [stats, balance, trajectory, focus, load, loadBand, adjustments, sessions, journey, journeyMilestones, timeline] = values;
  return {
    stats: CairnProgressData.record(stats),
    balance: CairnProgressData.record(balance),
    trajectory: CairnProgressData.record(trajectory),
    focus: CairnProgressData.record(focus),
    load: CairnProgressData.record(load),
    loadBand: CairnProgressData.record(loadBand),
    adjustments: Array.isArray(adjustments) ? adjustments : null,
    sessions: Array.isArray(sessions) ? sessions : null,
    journey: journey && typeof journey === "object" && !Array.isArray(journey) ? journey as import("../contracts/client-api.js").ClientJourneyRead : null,
    journeyMilestones: Array.isArray(journeyMilestones) ? journeyMilestones as import("../contracts/client-api.js").ClientJourneyMilestone[] : null,
    timeline: Array.isArray(timeline) ? timeline as import("../contracts/client-api.js").ClientForwardTimelineEntry[] : null,
  };
}

// Stale-while-revalidate read of the whole overview. Every read opts into api()'s
// `swr`: a body another surface fetched moments ago (Today's /coaching-focus and
// /stats) or this tab fetched on its last visit resolves at once, and only the
// reads with nothing remembered wait on the network. `refresh` settles with the
// network-fresh overview once every background refresh lands, or null when
// nothing was served stale (the first answer already IS the network's).
async function tovFetch(): Promise<{ data: TovData; refresh: Promise<TovData | null>; unreachable: number }> {
  const refreshes: Array<Promise<unknown> | undefined> = [];
  // Reads that failed because Cairn is out of reach. They are NOT "nothing trained":
  // the caller keeps the last-known overview (or says it cannot reach Cairn) rather
  // than folding a pile of nulls into the first-run empty state.
  let unreachable = 0;
  const paths = tovPaths();
  if (typeof CairnTrainFanIn !== "undefined") CairnTrainFanIn.prime("overview", paths); // one /train-home trip answers every read below
  const values: unknown[] = await Promise.all(
    paths.map((path, i) =>
      api(path, {
        swr: {
          onStale: (refresh) => {
            refreshes[i] = refresh;
          },
        },
      }).catch((error: unknown) => {
        if (CairnOffline.isUnreachable(error)) unreachable += 1;
        return null;
      })
    )
  );
  const data = tovCompose(values);
  if (!refreshes.some(Boolean)) return { data, refresh: Promise.resolve(null), unreachable };
  const refresh = Promise.all(
    values.map((value, i) => {
      const pending = refreshes[i];
      return pending ? pending.then((fresh) => (fresh === undefined ? value : fresh)) : value;
    })
  ).then(tovCompose);
  return { data, refresh, unreachable };
}

// SWR entry: paint the last-known read instantly, then revalidate. Guarded
// against painting over a switched-away tab (the renderToday lesson). A repaint
// happens only when the payload actually changed, so a quiet revalidate never
// re-runs the entrance stagger.
async function renderTrainOverview(): Promise<void> {
  headerTitle.textContent = "Train";
  state.progressSeg = "overview";
  const token = ++tovToken;
  const known = CairnTrainSnapshot.load() as TovData | null; // last-known read (progress-overview-snapshot-client.ts)
  if (known) paintTrainOverview(known);
  else view.innerHTML = segSkeleton("overview", PROGRESS_SEG, 3);
  const current = (): boolean => token === tovToken && state.tab === "progress" && state.progressSeg === "overview";
  const land = (fresh: TovData): void => {
    const changed = JSON.stringify(fresh) !== JSON.stringify(CairnTrainSnapshot.load());
    CairnTrainSnapshot.save(fresh);
    if (changed || !document.querySelector(".tov-mast, .tov-empty")) paintTrainOverview(fresh);
  };
  const { data, refresh, unreachable } = await tovFetch();
  if (!current()) return;
  // Out of reach: never land (or re-save) a partial read over the last-known one,
  // and never let failed reads masquerade as a fresh install (CairnOffline).
  if (unreachable) return known ? tovMarkLastKnown() : paintTrainUnreachable();
  land(data);
  const upgraded = await refresh;
  if (upgraded && current()) land(upgraded);
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
    // `saturated` is the server's acuteGate() answer. Do not re-derive it from
    // days_ago + heavy — that was one of the four retired heuristics the gate
    // replaced, and a Saturday ride then read "due" on Monday while the Brief
    // had already suppressed it.
    const recovering = !!l?.saturated;
    const tone = recovering ? "recover"
      : status === "due" ? "due"
      : band === "high" || status === "high" ? "high"
      : band === "productive" || sets > 0 ? "ok"
      : "none";
    let loadNote = "";
    if (recovering && l) {
      const ago = CairnProgressData.number(l.days_ago, 0);
      const when = ago <= 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
      const what = l.activity
        ? (ago <= 1 ? `${when}'s ${l.detail ? `${l.detail} ` : ""}${l.activity}` : `${l.detail ? `${l.detail} ` : ""}${l.activity} ${when}`)
        : (ago <= 1 ? `${when}'s session` : `a session ${when}`);
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

// What the muscle map says, in one line. No session count: the week's sessions done
// against planned are Horizon's (one home per fact) — Train reads whether it is working.
function tovHeadline(_data: TovData, rows: TovRow[]): string {
  const due = rows.filter((r) => r.tone === "due").map((r) => r.label);
  const advancing = rows.filter((r) => r.verdict === "advancing").map((r) => r.label);
  const clause = due.length ? `${due.slice(0, 2).join(" and ")} ${due.length === 1 ? "is" : "are"} due.`
    : advancing.length ? `${advancing.slice(0, 2).join(" and ")} ${advancing.length === 1 ? "is" : "are"} advancing.`
    : "";
  return clause || "Your training, in one look.";
}

// The week's load, as one serif voice line and at most one supporting mono fact.
// Sessions ride the voice line; sets are the one fact; pounds moved live one tap
// deeper (Volume, History). Honest continuity, not a streak: a reset-on-miss
// consecutive-day count is the chain-you-fear-breaking mechanic the constitution
// rules out — §2/§6C of VISION.md. The deterministic streak value still exists in
// getWeeklyStats for agent context; it is not surfaced here.
function tovMastHtml(data: TovData, rows: TovRow[]): string {
  const stats = data.stats || {};
  const sets = CairnProgressData.number(stats.week_sets);
  const fact = sets > 0 ? `${sets} working set${sets === 1 ? "" : "s"} this week` : "";
  return `<div class="tov-mast reveal" style="${stagger(3)}">
    <div class="lbl">This week</div>
    <h2 class="tov-mast-h">${escHtml(tovHeadline(data, rows))}</h2>
    ${fact ? `<div class="tov-mast-fact lbl">${escHtml(fact)}</div>` : ""}
  </div>`;
}

// A quiet personal-baseline band under the masthead: this week's training load
// against the athlete's OWN trailing-typical weekly volume, in plain words —
// "running hot" (terracotta) only when genuinely above typical. Absent until
// there's enough history. The numbers live one tap deeper, on Volume; the band
// is words (VISION Amendment 2). The server envelope is { band }.
// One aligned row — label · compact meter · one word — so the word sits where the
// eye lands after the dot instead of wrapping under the track. The word is read off
// the band the server already drew (dot above / below / inside the athlete's own
// range, the same p25/p75 test behind its phrase); the full phrase stays as the
// row's accessible name.
function tovLoadBandWord(band: Record<string, unknown>): string {
  const pos = Number(band.position);
  const lo = Math.min(Number(band.range_start), Number(band.range_end));
  const hi = Math.max(Number(band.range_start), Number(band.range_end));
  if (band.hot === true || (Number.isFinite(pos) && Number.isFinite(hi) && pos > hi)) return "heavier";
  if (Number.isFinite(pos) && Number.isFinite(lo) && pos < lo) return "lighter";
  return "usual";
}

function tovLoadBandHtml(data: TovData): string {
  const band = CairnProgressData.record(CairnProgressData.record(data.loadBand).band);
  const phrase = CairnProgressData.string(band.phrase);
  if (!phrase) return "";
  const label = CairnProgressData.string(band.label) || "Training load";
  const row = CairnUiReads.baselineBandHtml({
    label,
    position: band.position,
    rangeStart: band.range_start,
    rangeEnd: band.range_end,
    phrase: tovLoadBandWord(band),
    hot: band.hot === true,
  });
  if (!row) return "";
  return `<div class="tov-loadband reveal" role="group" aria-label="${escAttr(`${label}: ${phrase}`)}" style="${stagger(3)}">${row}</div>`;
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
  // Volume in range while the lifts stall is two facts, said as two: never "stalling
  // … in the productive range" as if the range were the verdict.
  if (row.band === "productive" && row.verdict === "stalling") parts.push("volume is in range, progress has stalled");
  else if (row.band === "productive") parts.push("in the productive range");
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
  return `<div class="tov-map sess reveal" style="${stagger(4)}">
    <div class="lbl">Muscle balance</div>
    <div class="tov-figs">
      <figure><figcaption class="lbl">Front</figcaption>${tovFigureSvg("front", tones)}</figure>
      <figure><figcaption class="lbl">Back</figcaption>${tovFigureSvg("back", tones)}</figure>
    </div>
    <div class="tov-legend">${legend}</div>
  </div>`;
}

function tovRowHtml(row: TovRow, i: number): string {
  return `
    <button class="tov-row reveal" type="button" data-tovgo="program" data-group="${escAttr(row.group)}" style="${stagger(Math.min(i + 2, 12))}">
      <span class="tov-row-dot tov-dot-${row.tone === "none" ? "idle" : row.tone}"></span>
      <span class="tov-row-main">
        <span class="tov-row-top"><span class="tov-row-name">${escHtml(tovCapitalize(row.label))}</span>${tovVerdictChip(row)}</span>
        ${tovBandBar(row)}
        <span class="tov-row-note">${escHtml(tovRowNote(row) || "nothing logged yet")}</span>
      </span>
      <span class="tov-row-arw">›</span>
    </button>`;
}

// The groups that ask for a look (due, running high, stalling) lead, at least three;
// the rest fold under one quiet line, one tap away, never a wall of thirteen rows.
function tovRowsHtml(rows: TovRow[]): string {
  const visible = rows.filter((r) => r.tone !== "none" || TOV_GROUP_ORDER.includes(r.group));
  if (!visible.length) return "";
  const lead = visible.filter((r) => r.tone === "due" || r.tone === "high" || r.verdict === "stalling");
  for (const row of visible) if (lead.length < 3 && !lead.includes(row)) lead.push(row);
  const rest = visible.filter((r) => !lead.includes(r));
  const hint = rest.slice(0, 3).map((r) => tovCapitalize(r.label)).join(", ") + (rest.length > 3 ? "…" : "");
  const more = rest.length ? `<details class="tov-more"><summary class="tov-more-sum"><span>${rest.length} more muscle group${rest.length === 1 ? "" : "s"}</span><span class="tov-more-hint">${escHtml(hint)}</span></summary><div class="tov-rows">${rest.map((row, i) => tovRowHtml(row, lead.length + i)).join("")}</div></details>` : "";
  return `<div class="tov-kicker lbl reveal" style="${stagger(2)}">Working sets per week, against your productive range</div>
    <div class="tov-rows">${lead.map((row, i) => tovRowHtml(row, i)).join("")}</div>${more}`;
}

/** A muscle's row, with its fold opened when it sits among the quiet groups. */
function tovOpenRow(view: ParentNode, group: string): HTMLElement | null {
  const row = group ? view.querySelector<HTMLElement>(`.tov-row[data-group="${group}"]`) : null;
  row?.closest("details")?.setAttribute("open", "");
  return row;
}

function tovCapitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// The first-run start entry (nothing logged yet), through the shared openSession() (the
// Brief's path; dayPicked reset in wireTovStart). A Train with history has no "Today"
// card: today's lift is the Brief's line, said once (docs/IA.md "Tab model").
function tovStartHtml(): string {
  return `<button class="draftbtn tov-start reveal" style="${stagger(1)}" type="button" id="tovStart">Start today's training →</button>`;
}

function wireTovStart(): void {
  const btn = view.querySelector<HTMLElement>("#tovStart");
  if (!btn) return;
  btn.addEventListener("click", () => {
    state.dayPicked = false;
    state.dayPickedOn = null;
    if (typeof openSession === "function") void openSession(localISO(), {
      source: "adaptive_plan",
      trigger: btn,
      provenance: { entry: "train_overview" },
    });
  });
}

// The Progress-overview lever is the "overview" display variant of the ONE
// coaching-focus renderer (src/client/coaching-focus-client.ts) — same payload,
// same gating, this surface's density and chrome. It used to be a fourth
// hand-rolled copy of the read.
function tovFocusHtml(data: TovData): string {
  if (typeof coachingFocusHtml !== "function") return "";
  return coachingFocusHtml((data.focus || null) as unknown as ClientCoachingFocus | null, {
    variant: "overview",
    style: stagger(2),
  });
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

// A session's name: the server's content title (deriveSessionTitle), else its plan day,
// else the day it was trained ("Tuesday's session") — never a bare "Session".
function tovSessionTitle(s: Record<string, unknown>): string {
  const title = String(s.title || "").trim();
  if (title && title !== "Session") return title;
  if (s.day_name) return String(s.day_name);
  const weekday = s.date ? CairnFmt.date(String(s.date), { fmt: { weekday: "long" } }) : "";
  return weekday && !/\d{4}-/.test(weekday) ? `${weekday}'s session` : "Training session";
}

function tovSessionsHtml(data: TovData): string {
  const sessions = CairnProgressData.rows<Record<string, unknown>>(data.sessions);
  if (!sessions.length) return "";
  const rows = sessions.map((s) => {
    const sets = Array.isArray(s.sets) ? s.sets.length : 0;
    const when = s.date && typeof relAge === "function" ? relAge(String(s.date)) : String(s.date || "");
    return `<button class="tov-sess" type="button" data-tovgo="sessions">
      <span class="tov-sess-name">${escHtml(tovSessionTitle(s))}</span>
      <span class="tov-sess-meta">${escHtml(when)}${sets ? ` · ${sets} set${sets === 1 ? "" : "s"}` : ""}</span>
      <span class="tov-row-arw">›</span>
    </button>`;
  }).join("");
  return `<div class="tov-recent reveal" style="${stagger(5)}">
    <div class="lbl">Latest sessions</div>
    ${rows}
  </div>`;
}

// The journey's one line: the phase read (or, before one exists, the nearest
// checkpoint on the road ahead), pointing to Horizon's goal line, where the journey
// story and the road-ahead timeline live in full. "" when neither read has anything
// to say. No score, no countdown: the same plain-language lead the goal line prints.
function tovJourneyPointerHtml(data: TovData): string {
  const hasJourney = !!CairnProgressJourney?.hasRead?.(data.journey, data.journeyMilestones);
  const hasRoad = Array.isArray(data.timeline) && data.timeline.length > 0;
  if (!hasJourney && !hasRoad) return "";
  const phase = CairnProgressJourney?.phaseSummary?.(data.journey, data.journeyMilestones) || "";
  const next = CairnJourneyTimeline?.nextLabel?.(data.timeline) || "";
  const line = phase || next || "Your journey and the road ahead";
  const routes = typeof routeApi === "function" ? routeApi() : null;
  const href = routes?.routeToUrl({ tab: "horizon", section: "goal" }) || "/app/horizon/goal";
  return `<a class="tov-jpoint reveal" style="${stagger(5)}" href="${escAttr(href)}" data-tov-horizon>
    <span class="lbl tov-jpoint-kick">Journey</span>
    <span class="tov-jpoint-line">${escHtml(line)}</span>
    <span class="tov-jpoint-arw" aria-hidden="true">›</span>
  </a>`;
}

function wireTovJourneyPointer(): void {
  view.querySelector<HTMLElement>("[data-tov-horizon]")?.addEventListener("click", (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    state.horizonSeg = "goal";
    activateTab("horizon");
  });
}

// ---- paint ----------------------------------------------------------------------

// The one quiet "last known" line over a remembered overview (CairnOffline).
function tovMarkLastKnown(): void {
  if (view.querySelector(".offline-lastknown")) return;
  view.querySelector(".segwrap")?.insertAdjacentHTML("afterend", CairnOffline.lastKnownHtml());
}

// Nothing remembered and Cairn out of reach: say so, never "log a session".
function paintTrainUnreachable(): void {
  view.innerHTML = segBar("overview", PROGRESS_SEG) + CairnOffline.unreachableHtml({ body: "Your training map fills in as soon as it's back." });
  wireSeg(PROGRESS_HANDLERS);
  CairnOffline.wireRetry(view, () => renderTrainOverview());
}

function paintTrainOverview(data: TovData): void {
  const head = segBar("overview", PROGRESS_SEG);
  const rows = tovFoldRows(data);
  const hasAny = rows.some((r) => r.sets > 0) || CairnProgressData.rows(data.sessions).length > 0;
  if (!hasAny) {
    // Nothing trained yet — lead with the journey line so a fresh install still
    // opens to something, not an empty screen.
    // The welcome's first week, while it comes together (first-week-client.ts, eager).
    const firstWeek = (globalThis as { CairnFirstWeek?: FirstWeekApi }).CairnFirstWeek;
    view.innerHTML = head + `<div class="tov-empty">` +
      (firstWeek?.slotHtml() ?? "") +
      tovStartHtml() +
      tovJourneyPointerHtml(data) +
      emptyStateHtml(art("exercise", "barbell row"), "Log a session and this becomes your training map — what's trained, what's due, and where to push next.") +
      `</div>`;
    wireSeg(PROGRESS_HANDLERS);
    wireTovStart();
    wireTovJourneyPointer();
    return;
  }
  // Train reads whether the training is working: Where to focus and What moved lead,
  // then the week's load (the voice line, the load band, the muscle map and the groups
  // asking for a look). The week-by-week moves, the latest sessions and the deeper
  // views follow; the journey is one line that opens Horizon's goal line. Today's lift
  // and the week's session count are not here: the Brief and Horizon own them.
  view.innerHTML = head +
    tovFocusHtml(data) +
    tovMastHtml(data, rows) +
    tovLoadBandHtml(data) +
    tovMapHtml(rows) +
    tovRowsHtml(rows) +
    tovMovesHtml(data) +
    tovSessionsHtml(data) +
    `<div data-train-deeper-slot></div>` +
    tovJourneyPointerHtml(data);
  wireSeg(PROGRESS_HANDLERS);
  wireTovJourneyPointer();
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
      const row = tovOpenRow(view, el.getAttribute("data-group") || "");
      if (!row) return;
      const reduce = reducedMotion();
      row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      row.style.transition = "background-color .5s ease";
      row.style.borderRadius = "10px";
      row.style.backgroundColor = "var(--sage-bg, #eef0e6)";
      setTimeout(() => { row.style.backgroundColor = "transparent"; }, 1100);
    });
  });
}

Object.assign(globalThis, { renderTrainOverview, tovJourneyPointerHtml, tovRowsHtml, tovOpenRow });
if (typeof window !== "undefined") Object.assign(window, { renderTrainOverview, tovJourneyPointerHtml, tovRowsHtml, tovOpenRow });
