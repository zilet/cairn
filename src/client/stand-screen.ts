// @ts-check
// Stand — the card-based "where you stand" brain. You consume the overview at a
// glance (the one lever + a grid of domain tiles, each a traffic-light read), tap a
// tile to dig into that domain, tap a marker to expand it, tap back. No long scroll:
// every view is ONE focused screen you move through. Self-contained (like
// body-metrics-client), reusing the shipped marker rows + status + body figure.

type StandLatest = { value?: unknown; flag?: unknown } | null;
type StandMarker = {
  key?: unknown; name?: unknown; unit?: unknown; group?: unknown; group_label?: unknown;
  latest?: StandLatest; optimal?: unknown; in_optimal?: unknown; reference?: unknown;
  points?: unknown; trend?: unknown;
};
type StandGroup = { key: string; label: string };
type StandPriority = { label?: unknown; the_move?: unknown; move?: unknown; why_it_matters?: unknown; why?: unknown; recheck?: unknown };
type StandSynthesis = { headline?: unknown; story?: unknown; priorities?: StandPriority[]; one_change?: unknown; generated_at?: unknown };
type StandData = {
  markers: StandMarker[];
  groups: StandGroup[];
  focus: Record<string, unknown> | null;
  body: Record<string, unknown> | null;
  synthesis: StandSynthesis | null;
  synthStale: boolean;
  connections: Array<{ text?: unknown; kind?: unknown }>;
  recovery: Record<string, unknown> | null;
  supplements: Array<Record<string, unknown>>;
  directives: Array<Record<string, unknown>>;
};
type StandStatus = "ok" | "watch" | "warn" | "mute";

(() => {
const RANK: Record<StandStatus, number> = { warn: 3, watch: 2, ok: 1, mute: 0 };

// The overview must be CONSUMABLE, not a wall — a comprehensive panel has ~20
// clinical groups. Fold them into a handful of meaningful DOMAINS for the tiles;
// the fine clinical groups still lead each domain's detail one tap down. "body"
// (DEXA composition) folds into the dedicated Body tile with the tape figure.
type StandDomain = { key: string; label: string; groups: string[] };
const DOMAINS: StandDomain[] = [
  { key: "heart", label: "Heart & Circulation", groups: ["lipids", "cardiac", "inflammation", "vitals"] },
  { key: "metabolic", label: "Metabolic & Fitness", groups: ["metabolic", "fitness"] },
  { key: "blood", label: "Blood & Iron", groups: ["iron", "blood"] },
  { key: "organs", label: "Organs", groups: ["kidney", "liver", "electrolytes"] },
  { key: "endocrine", label: "Hormones & Thyroid", groups: ["hormones", "thyroid"] },
  { key: "vitamins", label: "Vitamins & Minerals", groups: ["vitamins"] },
  { key: "screening", label: "Screening & Other", groups: ["autoimmune", "screening", "metals", "urinalysis", "other"] },
];
const HM = () => (globalThis as unknown as { CairnHealthMarkers?: Record<string, (...a: unknown[]) => unknown> }).CairnHealthMarkers;
const BM = () => (globalThis as unknown as { CairnBodyMetrics?: Record<string, (...a: unknown[]) => unknown> }).CairnBodyMetrics;

let DATA: StandData | null = null;
let LOADP: Promise<void> | null = null;
// Stale-while-revalidate plumbing. `reqToken` is bumped by every load; a resolving
// fetch only writes DATA if it's still the latest (a slower earlier fetch never
// clobbers a newer one). `curView` names the on-screen Stand view so a background
// refresh only silently repaints the calm, input-free reads. `quietPaint` suppresses
// the view-enter animation during a background repaint.
let reqToken = 0;
type StandView = "overview" | "domain" | "markers" | "body" | "recovery" | "supplements"
  | "records" | "share" | "learned" | "connections" | "age";
let curView: StandView = "overview";
let quietPaint = false;
const SNAP_KEY = "cairn.stand.v1";
// Self-contained tool views fetch their own data — the overview background refresh
// must never repaint one out from under the user.
const SELF_CONTAINED: ReadonlySet<StandView> = new Set(["records", "share", "learned", "connections", "age", "supplements"]);
// domain-detail catalog state (mirrors the Markers view): which domain is open,
// the free-text search, and the out-of-range filter. Reset each time a domain opens.
let curDomain: string | null = null;
let standQuery = "";
let standOff = false;

// Every Stand sub-view is a first-class, deep-linkable route (/app/stand/<seg>).
// state.standSeg is the single source of which view is open; setting it keeps the
// URL in step so reload/back land where you were.
function setStandSeg(seg: ClientStandSection | null): void {
  state.standSeg = seg;
  if (state.tab === "stand") syncRouteFromState();
}

function status(m: StandMarker): StandStatus {
  const s = HM()?.markerStatus?.(m) as StandStatus | undefined;
  return s || "mute";
}
function worstOf(markers: StandMarker[]): StandStatus {
  let s: StandStatus = "mute";
  for (const m of markers) if (RANK[status(m)] > RANK[s]) s = status(m);
  return s;
}
// The marker that should headline a group tile: the worst-status one (most
// actionable first), falling back to the first marker so a calm group still reads.
function leadMarker(markers: StandMarker[]): StandMarker | null {
  if (!markers.length) return null;
  return [...markers].sort((a, b) => RANK[status(b)] - RANK[status(a)])[0];
}
function markersOfGroup(key: string): StandMarker[] {
  return (DATA?.markers || []).filter((m) => String(m.group) === key);
}
function markersOfDomain(d: StandDomain): StandMarker[] {
  return (DATA?.markers || []).filter((m) => d.groups.includes(String(m.group)));
}
function offCount(markers: StandMarker[]): number {
  return markers.filter((m) => { const s = status(m); return s === "warn" || s === "watch"; }).length;
}
function valWord(m: StandMarker): string {
  const v = m?.latest?.value;
  if (v == null || v === "") return "";
  const num = HM()?.formatMarkerNumber?.(v) as string | undefined;
  return `${num ?? v}${m.unit ? ` ${String(m.unit)}` : ""}`;
}

// ---- overview: Your Read (the synthesis as focus-zones, not a scroll) ----------
const WHOLE_PICTURE_Q = "Walk me through my whole health picture — what matters most right now, and the single most effective thing I can do about it?";
function askLink(topic: string): string {
  const q = `Tell me more about ${topic} — what should I focus on?`;
  return `<button class="linkbtn linkbtn-plain linkbtn-sm stand-ask" type="button" data-ask="${escAttr(q)}">Ask the coach<span aria-hidden="true"> →</span></button>`;
}
// A small "recheck in ~3 months" timing chip on any priority that carries one.
function recheckBadge(p: StandPriority): string {
  const r = typeof p.recheck === "string" ? p.recheck.trim() : "";
  return r ? `<span class="stand-zrecheck lbl">↻ ${escHtml(r)}</span>` : "";
}
// The agentic whole-picture read is generated and refreshed right here — Stand is
// where the read lives, so the trigger lives with it (calm: one small control).
function readRefreshHtml(): string {
  return DATA?.synthStale
    ? `<button class="linkbtn linkbtn-plain linkbtn-sm stand-read-refresh" data-readrefresh type="button"><span class="hdot hdot-warn"></span>New results — refresh</button>`
    : `<button class="linkbtn linkbtn-plain linkbtn-sm stand-read-refresh" data-readrefresh type="button">refresh</button>`;
}
function readGenHtml(): string {
  if (!(DATA?.markers || []).length) return "";
  return `<div class="stand-read reveal">
      <span class="stand-read-k lbl">Your read</span>
      <p class="stand-read-lede">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn stand-read-gen" data-readgen type="button">Read my whole picture</button>
    </div>`;
}
function readHtml(): string {
  const syn = DATA?.synthesis;
  const headline = syn && typeof syn.headline === "string" ? syn.headline.trim() : "";
  const prios = (syn?.priorities || []).slice(0, 3);
  // No synthesis yet → the conductor focus line still leads, with a quiet invite
  // to generate the whole-picture read once there are markers to read.
  if (!headline && !prios.length) return focusHeroHtml() + readGenHtml();
  const age = syn && typeof syn.generated_at === "string" ? ` · ${relAge(syn.generated_at)}` : "";
  const zones = prios.map((p, i) => {
    const label = String(p.label || "");
    const move = String(p.the_move || p.move || "");
    const why = String(p.why_it_matters || p.why || "");
    const tone: StandStatus = i === 0 ? "warn" : "watch"; // the lead reads strongest
    return `<div class="stand-zone tone-${tone}" data-zone>
        <div class="stand-zt"><span class="hdot hdot-${tone}"></span><span class="stand-zlabel">${escHtml(label)}</span><span class="stand-zchev" aria-hidden="true">▾</span></div>
        ${move ? `<div class="stand-zmove">${escHtml(move)}</div>` : ""}
        <div class="stand-zwhy">${why ? escHtml(why) : ""}${recheckBadge(p)}${askLink(label || "this")}</div>
      </div>`;
  }).join("");
  const oc = syn && typeof syn.one_change === "string" && syn.one_change.trim()
    ? `<div class="stand-onechange well-accent-sm"><span class="lbl">If you change one thing</span><span>${escHtml(syn.one_change.trim())}</span></div>`
    : "";
  const conns = (DATA?.connections || [])
    .filter((c) => typeof c.text === "string" && String(c.text).trim())
    .slice(0, 2)
    .map((c) => `<div class="stand-conn"><span class="stand-conn-i" aria-hidden="true">◇</span><span>${escHtml(String(c.text))}</span></div>`)
    .join("");
  return `<div class="stand-read reveal">
      <span class="stand-read-top"><span class="stand-read-k lbl">Your read${age}</span>${readRefreshHtml()}</span>
      ${headline ? `<p class="stand-read-lede">${escHtml(headline)}</p>` : ""}
      ${zones ? `<div class="stand-zones">${zones}</div>` : ""}
      ${oc}
      ${conns ? `<div class="stand-conns"><div class="stand-conns-h lbl">Quiet connections</div>${conns}</div>` : ""}
      ${fullStoryHtml()}
    </div>`;
}
// Progressive disclosure of the depth the calm read holds back: the narrative
// "story" paragraph, any priorities beyond the visible three, and a whole-picture
// "ask the coach" deep-link. Collapsed by default; rendered only when there's more
// to show than the three zones already carry.
function fullStoryHtml(): string {
  const syn = DATA?.synthesis;
  const story = syn && typeof syn.story === "string" ? syn.story.trim() : "";
  const rest = (syn?.priorities || []).slice(3);
  const restRows = rest.map((p) => {
    const label = String(p.label || "");
    const move = String(p.the_move || p.move || "");
    const why = String(p.why_it_matters || p.why || "");
    if (!label && !move && !why) return "";
    return `<div class="stand-sp">
        ${label ? `<div class="stand-sp-label">${escHtml(label)}</div>` : ""}
        ${move ? `<div class="stand-zmove">${escHtml(move)}</div>` : ""}
        <div class="stand-zwhy stand-sp-why">${why ? escHtml(why) : ""}${recheckBadge(p)}${askLink(label || "this")}</div>
      </div>`;
  }).join("");
  if (!story && !restRows) return "";
  return `<div class="stand-story" data-story>
      <button class="stand-story-t linkbtn linkbtn-quiet linkbtn-sm" type="button" data-storytoggle aria-expanded="false">The full story<span class="stand-story-chev" aria-hidden="true">▾</span></button>
      <div class="stand-story-body">
        ${story ? `<p class="stand-story-p">${escHtml(story)}</p>` : ""}
        ${restRows ? `<div class="stand-story-prios">${restRows}</div>` : ""}
        <button class="linkbtn linkbtn-plain linkbtn-sm stand-ask stand-ask-all" type="button" data-ask="${escAttr(WHOLE_PICTURE_Q)}">Ask the coach about this<span aria-hidden="true"> →</span></button>
      </div>
    </div>`;
}
function focusHeroHtml(): string {
  const f = DATA?.focus as Record<string, unknown> | null;
  const headline = f && typeof f.headline === "string" ? f.headline.trim() : "";
  const lead = f && f.lead && typeof f.lead === "object" ? (f.lead as Record<string, unknown>) : null;
  const line = lead && typeof lead.line === "string" ? lead.line.trim()
    : lead && typeof lead.why === "string" ? lead.why.trim() : "";
  if (!headline && !line) return "";
  return `<div class="stand-focus reveal">
      <span class="stand-focus-k">Where to focus</span>
      ${headline ? `<h2 class="stand-focus-h">${escHtml(headline)}</h2>` : ""}
      ${line ? `<p class="stand-focus-p">${escHtml(line)}</p>` : ""}
    </div>`;
}

function bodyComp(): Record<string, unknown> | null {
  const body = DATA?.body as Record<string, unknown> | null;
  return body && body.comp && typeof body.comp === "object" ? (body.comp as Record<string, unknown>) : null;
}
function bodyStatus(): StandStatus {
  const comp = bodyComp();
  if (!comp) return markersOfGroup("body").length ? worstOf(markersOfGroup("body")) : "mute";
  const scales = Array.isArray(comp.scales) ? (comp.scales as Array<Record<string, unknown>>) : [];
  const focus = comp.focus && typeof comp.focus === "object";
  return focus ? "watch" : scales.length ? "ok" : "mute";
}
function bodyTile(): string {
  const comp = bodyComp();
  if (!comp && !markersOfGroup("body").length) return "";
  const scales = comp && Array.isArray(comp.scales) ? (comp.scales as Array<Record<string, unknown>>) : [];
  const whtr = scales.find((s) => s.key === "whtr") || scales[0];
  const st = bodyStatus();
  const read = whtr && whtr.value != null
    ? `waist <b>${escHtml(String(whtr.value))}</b> of height`
    : "log a tape session";
  return `<button class="stand-tile reveal" data-body>
      <span class="stand-tile-top"><span class="hdot hdot-${st}"></span><span class="stand-tile-name">Body</span></span>
      <span class="stand-tile-read ${st}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
}

// ---- recovery (condensed tile + detail, from wearable/daily metrics) -----------
function recoveryData(): Record<string, unknown> | null {
  const r = DATA?.recovery;
  if (!r || r.has_data === false) return null;
  return r.recovery && typeof r.recovery === "object" ? (r.recovery as Record<string, unknown>) : null;
}
function sleepWord(min: unknown): string {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "";
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}
function recoveryStatus(): StandStatus {
  const rec = recoveryData();
  if (!rec) return "mute";
  const score = Number(rec.avg_sleep_score);
  if (Number.isFinite(score)) return score >= 75 ? "ok" : score >= 60 ? "watch" : "warn";
  return "ok";
}
function recoveryTile(): string {
  const rec = recoveryData();
  if (!rec) return "";
  const st = recoveryStatus();
  const sleep = sleepWord(rec.avg_sleep_min);
  const hrv = Number(rec.avg_hrv_ms);
  const read = sleep
    ? `sleep <b>${escHtml(sleep)}</b>${Number.isFinite(hrv) && hrv > 0 ? ` · HRV ${Math.round(hrv)}` : ""}`
    : "no wearable data yet";
  return `<button class="stand-tile reveal" data-recovery>
      <span class="stand-tile-top"><span class="hdot hdot-${st}"></span><span class="stand-tile-name">Recovery</span></span>
      <span class="stand-tile-read ${st === "ok" ? "" : st}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
}
function recoveryDetailHtml(): string {
  // Reuse the shipped plain-language recovery read — ~13 signals (sleep + its
  // architecture, resting HR, HRV + status, stress, body battery, respiration +
  // SpO₂, skin temp, training readiness, VO₂max + status, steps, body comp) with
  // source labels — instead of the old 4-card summary. Same /recovery payload.
  const rec = recoveryData();
  const body = rec
    ? (CairnHealthRead.recoveryHtml(DATA?.recovery as Record<string, unknown> | null) || "")
    : "";
  return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Recovery</h2>
      ${body || `<p class="stand-empty">No wearable data yet.</p>`}
    </div>`;
}

// ---- supplements (condensed tile + list; informational, no traffic-light) ------
function supplementsTile(): string {
  const list = DATA?.supplements || [];
  if (!list.length) return "";
  const names = list.map((s) => String(s.name || "")).filter(Boolean);
  const read = names.length
    ? `${escHtml(names.slice(0, 2).join(", "))}${names.length > 2 ? ` +${names.length - 2}` : ""}`
    : `${list.length} tracked`;
  return `<button class="stand-tile reveal" data-supps>
      <span class="stand-tile-top"><span class="hdot hdot-ok"></span><span class="stand-tile-name">Supplements</span></span>
      <span class="stand-tile-read">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
}
// ---- connections (the connected brain: active directives, managed in-place) ----
function activeDirectives(): Array<Record<string, unknown>> {
  return (DATA?.directives || []).filter((d) => !d.status || d.status === "active");
}
function connectionsTile(): string {
  const n = activeDirectives().length;
  if (!n && !(DATA?.markers || []).length) return "";
  const read = n
    ? `<b>${n}</b> shaping your plan`
    : "nothing in effect";
  return `<button class="stand-tile reveal" data-connections>
      <span class="stand-tile-top"><span class="hdot hdot-${n ? "watch" : "mute"}"></span><span class="stand-tile-name">Connections</span></span>
      <span class="stand-tile-read ${n ? "watch" : ""}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
}

// ---- age (the biological-age / percentile standing read, hosted one tap down) ---
function ageTile(): string {
  if (!(DATA?.markers || []).length) return "";
  return `<button class="stand-tile reveal" data-age>
      <span class="stand-tile-top"><span class="hdot hdot-mute"></span><span class="stand-tile-name">Age</span></span>
      <span class="stand-tile-read">how you compare</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
}

function domainTileHtml(d: StandDomain, st: StandStatus): string {
  const markers = markersOfDomain(d);
  const lead = leadMarker(markers);
  const off = offCount(markers);
  // An off domain leads with the marker that needs attention; a calm domain just
  // says how many reads sit inside it (a number to tap into, never "all good" prose).
  const read = off && lead
    ? `${escHtml(String(lead.name || lead.key || ""))} <b>${escHtml(valWord(lead))}</b>${off > 1 ? ` · ${off} to watch` : ""}`
    : `${markers.length} reading${markers.length === 1 ? "" : "s"}`;
  return `<button class="stand-tile reveal" data-domain="${escAttr(d.key)}">
      <span class="stand-tile-top"><span class="hdot hdot-${st}"></span><span class="stand-tile-name">${escHtml(d.label)}</span></span>
      <span class="stand-tile-read ${off ? st : ""}">${read}</span><span class="stand-tile-arw" aria-hidden="true">›</span>
    </button>`;
}

function overviewHtml(): string {
  // One tile per domain that has any markers, plus Body — sorted worst-first so
  // what needs attention rises to the top of a short, glanceable grid.
  type Tile = { st: StandStatus; html: string };
  const tiles: Tile[] = [];
  const b = bodyTile();
  if (b) tiles.push({ st: bodyStatus(), html: b });
  const rec = recoveryTile();
  if (rec) tiles.push({ st: recoveryStatus(), html: rec });
  const conn = connectionsTile();
  if (conn) tiles.push({ st: activeDirectives().length ? "watch" : "mute", html: conn });
  const supp = supplementsTile();
  if (supp) tiles.push({ st: "ok", html: supp });
  const age = ageTile();
  if (age) tiles.push({ st: "mute", html: age });
  for (const d of DOMAINS) {
    const markers = markersOfDomain(d);
    if (!markers.length) continue;
    const st = worstOf(markers);
    tiles.push({ st, html: domainTileHtml(d, st) });
  }
  tiles.sort((a, b2) => RANK[b2.st] - RANK[a.st]);
  return `<div class="stand-root">
      ${actionBarHtml()}
      ${readHtml()}
      <div class="stand-browse lbl">Your markers<button class="stand-allmk linkbtn linkbtn-plain linkbtn-sm" type="button" data-allmarkers>All markers<span aria-hidden="true"> →</span></button></div>
      <div class="stand-grid">${tiles.map((t) => t.html).join("")}</div>
    </div>`;
}

// The health depth + the clinician-facing exports are Stand's OWN sub-views now —
// Records, the doctor Share (clinical order + trends, untouched), and the learned
// timeline all render in place, never warping to another tab.
// A sticky bar pinned to the top of Stand — Add labs is always one tap away
// (never buried at the scroll bottom); the rest of the health tools sit behind a
// quiet "⋯" menu in the same bar.
function actionBarHtml(): string {
  return `<div class="stand-actionbar">
      <button class="stand-addbtn" data-tool="add" type="button"><span class="stand-addbtn-p" aria-hidden="true">＋</span>Add labs or scan</button>
      <div class="stand-more">
        <button class="stand-morebtn" type="button" aria-label="More health tools" aria-expanded="false" data-morebtn>⋯</button>
        <div class="stand-moremenu" data-moremenu hidden>
          <button class="stand-moreitem" data-tool="share" type="button">Share with your doctor</button>
          <button class="stand-moreitem" data-tool="records" type="button">Records</button>
          <button class="stand-moreitem" data-tool="learned" type="button">Learned</button>
        </div>
      </div>
    </div>`;
}

// ---- hosted health tools (records / share / learned / connections / age) -------
// These reuse the shipped controllers with Stand-shaped deps: same upload flow,
// same doctor report, same directive flips — rendered inside Stand's shell.
function toolShellHtml(title: string, mounts: string, lede = ""): string {
  return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">${escHtml(title)}</h2>
      ${lede ? `<p class="stand-read-lede" style="font-size:1rem">${escHtml(lede)}</p>` : ""}
      ${mounts}
    </div>`;
}

// Refresh Stand's own marker snapshot after an upload/re-analysis lands, so the
// overview tiles are warm and current when the athlete steps back.
async function refreshStandMarkers(): Promise<void> {
  try {
    const priority = await api("/markers/priority") as { markers?: StandMarker[]; groups?: StandGroup[] } | null;
    if (DATA && priority && typeof priority === "object") {
      DATA.markers = Array.isArray(priority.markers) ? priority.markers : DATA.markers;
      DATA.groups = Array.isArray(priority.groups) ? priority.groups : DATA.groups;
    }
  } catch { /* the overview simply repaints from the last snapshot */ }
}

function pictureDeps(): ClientHealthPictureControllerDeps {
  return {
    root: view,
    state,
    api,
    toast,
    switchHealthSeg: (seg, opts) => { if (seg === "records") showRecords(opts || {}); else showOverview(); },
    onHealthReadView: () => state.tab === "stand" && state.standSeg === "connections",
    pollToken: () => pollToken,
    escapeHtml: escHtml,
  };
}

function recordsDeps(): ClientHealthRecordsControllerDeps {
  return {
    state,
    api,
    toast,
    armDelete,
    pollEnrichment,
    enrichmentActive,
    pollToken: () => pollToken,
    loadHealthMarkers: () => { void refreshStandMarkers(); },
    paintHealthPicture: () => CairnHealthPictureController.paintHealthPicture(pictureDeps()),
    getHealthPictureCache: () => CairnHealthPictureController.getHealthPictureCache(),
    setHealthPictureCache: (cache) => CairnHealthPictureController.setHealthPictureCache(cache),
  };
}

function shareDeps(): ClientHealthShareControllerDeps {
  return {
    root: view,
    api,
    cachedApi,
    peekCached,
    swrInvalidate,
    toast,
    btnBusy,
    downloadFile,
    select: $,
    stagger,
    switchHealthSeg: (seg, opts) => { if (seg === "records") showRecords(opts || {}); else showOverview(); },
    withToken,
  };
}

function readDeps(): ClientHealthReadControllerDeps {
  return {
    root: view,
    state,
    api,
    cachedApi,
    peekCached,
    markRefreshing,
    swrInvalidate,
    runOp,
    toast,
    pollToken: () => pollToken,
    select: $,
    escapeAttr: escAttr,
    escapeHtml: escHtml,
    relTime,
    stagger,
    reducedMotion,
    switchHealthSeg: (seg) => { if (seg === "markers") showAllMarkers(); else showOverview(); },
    isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
    loadHealthPicture: (token, docsPromise) => CairnHealthPictureController.loadHealthPicture(token, docsPromise, pictureDeps()),
    paintHealthPicture: () => CairnHealthPictureController.paintHealthPicture(pictureDeps()),
    setReadSpy: () => {},
    teardownReadSpy: () => {},
  };
}

function standingDeps(): ClientHealthStandingControllerDeps {
  return {
    root: view,
    document,
    state,
    api,
    swrInvalidate,
    toast,
    activateTab,
    pollToken: () => pollToken,
    select: $,
    escapeAttr: escAttr,
    loadDexaTargeting: (slotId) => loadDexaTargeting(slotId),
  };
}

function showRecords(opts: { openPicker?: boolean } = {}): void {
  curView = "records";
  setStandSeg("records");
  paint(toolShellHtml("Records", `<div id="hContent"></div>`,
    "Lab reports, DEXA scans and other documents — everything Cairn reads your markers from."));
  wireBack();
  void CairnHealthRecordsController.render(recordsDeps());
  if (opts.openPicker) view.querySelector<HTMLInputElement>("#hFile")?.click();
}

function showShare(): void {
  curView = "share";
  setStandSeg("share");
  paint(toolShellHtml("Share with your doctor", `<div id="hContent"></div><div id="hbSymptomLinks"></div>`));
  wireBack();
  CairnHealthShareController.render(shareDeps());
  // "Worth mentioning to your doctor" belongs with the clinician-facing tools.
  void CairnHealthReadController.loadSymptomLinks(readDeps(), pollToken);
}

function showLearned(): void {
  curView = "learned";
  setStandSeg("learned");
  paint(toolShellHtml("Learned", `<div id="standLearned">${skelLines(4)}</div>`));
  wireBack();
  const token = pollToken;
  api("/learned-timeline")
    .then((data) => paintLearned(data, token))
    .catch(() => paintLearned({ items: [] }, token));
}
function paintLearned(data: unknown, token: number): void {
  const wrap = view.querySelector<HTMLElement>("#standLearned");
  if (!wrap || !wrap.isConnected || token !== pollToken) return;
  wrap.innerHTML = learnedTimelineHtml((data || { items: [] }) as Parameters<typeof learnedTimelineHtml>[0]);
  // Curation lives in the about-you home (Settings → You → Memory).
  wrap.querySelector<HTMLElement>("#learnedToMemory")?.addEventListener("click", () => {
    state.meSeg = "memory";
    activateTab("me");
  });
}

function showConnections(): void {
  curView = "connections";
  setStandSeg("connections");
  paint(toolShellHtml("Connections",
    `<div id="hbDirectives"><div class="hb-load">Gathering connections…</div></div>
     <div id="hPicture"></div>`,
    "One brain across your whole picture: a finding in your labs quietly shapes your meals, training, and what to watch. Informational — never medical advice; nothing changes your plan on its own."));
  wireBack();
  void CairnHealthDirectiveLoader.load(pollToken);
  const deps = pictureDeps();
  if (CairnHealthPictureController.isHealthReviewRunning()) CairnHealthPictureController.paintHealthPicture(deps);
  else void CairnHealthPictureController.loadHealthPicture(pollToken, api("/health-docs"), deps);
}

function showAge(): void {
  curView = "age";
  setStandSeg("age");
  paint(toolShellHtml("How you compare", `<div id="hContent"></div>`));
  wireBack();
  CairnHealthStandingController.paintReview(standingDeps());
}

// ---- domain detail — the Markers catalog, scoped to one domain -----------------
// The old Markers affordances come along: search (when there are many), an
// out-of-range filter, clinical sub-group sections, and expandable rows carrying
// the chart, the range/optimal target, and the trend. Controls render ONCE (so the
// search field keeps focus); only #standResults re-fills on filter/search.
const HC = () => (globalThis as unknown as { CairnHealthClient?: Record<string, (...a: unknown[]) => unknown> }).CairnHealthClient;
function markerOutOfRange(m: StandMarker): boolean { return !!HM()?.markerOutOfRange?.(m); }
function matchesQuery(m: StandMarker): boolean {
  const q = standQuery.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return true;
  return `${String(m.name || m.key || "")} ${String(m.group_label || "")}`.toLowerCase().includes(q);
}

function standControlsHtml(total: number, outCount: number): string {
  const search = total > 5
    ? `<div class="hmk-search"><svg class="hmk-search-i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><input id="standSearch" type="search" class="hmk-search-in" placeholder="Search…" aria-label="Search markers" autocomplete="off" spellcheck="false" enterkeyhint="search"></div>`
    : "";
  const pill = outCount
    ? `<button id="standOut" class="hmk-filter-toggle${standOff ? " on" : ""}" aria-pressed="${standOff ? "true" : "false"}"><span class="hdot hdot-warn"></span>Out of range · ${outCount}</button>`
    : "";
  return search || pill ? `<div class="hmk-controls reveal">${search}${pill}</div>` : "";
}

function domainResultsHtml(): string {
  const all = curDomain === "__all__";
  const d = all ? null : DOMAINS.find((x) => x.key === curDomain);
  if (!all && !d) return "";
  // Sections = clinical groups, each with its own head + sub-group sub-heads so the
  // fine taxonomy stays usable one tap down. A domain view sorts its groups worst-
  // first (what needs attention rises); the full "All markers" catalog keeps the
  // backend's canonical clinical-review order (CBC → CMP → lipids → …).
  const present = (DATA?.groups || []).filter((g) => (all || d!.groups.includes(g.key)) && markersOfGroup(g.key).length);
  if (!all) present.sort((a, b) => RANK[worstOf(markersOfGroup(b.key))] - RANK[worstOf(markersOfGroup(a.key))]);
  let rowIndex = 0;
  const sections = present.map((g, gi) => {
    let list = markersOfGroup(g.key);
    if (standOff) list = list.filter(markerOutOfRange);
    list = list.filter(matchesQuery);
    if (!list.length) return "";
    const ordered = (HC()?.orderMarkersForDisplay?.(g.key, list) as StandMarker[]) || list;
    let lastSub = "";
    const rows = ordered.map((m) => {
      const sub = HC()?.markerSubgroup?.(g.key, String(m.name || m.key || "")) as string | null;
      const subhead = sub && sub !== lastSub ? `<div class="hmk-subhead">${escHtml(sub)}</div>` : "";
      if (sub) lastSub = sub;
      return subhead + (HM()?.hmkRowHtml?.(m, rowIndex++) as string);
    }).join("");
    const off = ordered.filter(markerOutOfRange).length;
    const badge = off ? `<span class="hmk-headcount">${off} off</span>` : "";
    const head = `<div class="hmk-grouphead lbl reveal" style="--i:${Math.min(gi, 12)}">${escHtml(g.label)}${badge}</div>`;
    const note = g.key === "lipids" ? ((HC()?.lipidGroupNoteHtml?.(ordered, { relAge }) as string) || "") : "";
    return `<section class="hmk-section">${head}${note}<div class="hmk-card">${rows}</div></section>`;
  }).join("");
  return sections || `<p class="stand-empty">${standQuery || standOff ? "Nothing matches — clear the filter." : "No readings here yet."}</p>`;
}

function showDomain(key: string): void {
  curDomain = key; standQuery = ""; standOff = false;
  const all = key === "__all__";
  curView = all ? "markers" : "domain";
  setStandSeg(all ? "markers" : null);
  const d = all ? null : DOMAINS.find((x) => x.key === key);
  const markers = all ? (DATA?.markers || []) : d ? markersOfDomain(d) : [];
  const outCount = markers.filter(markerOutOfRange).length;
  paint(`<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">${escHtml(all ? "All markers" : d?.label || "Markers")}</h2>
      ${standControlsHtml(markers.length, outCount)}
      <div id="standResults"></div>
    </div>`);
  wireBack();
  wireControls();
  renderResults();
}
function showAllMarkers(): void { showDomain("__all__"); }
function renderResults(): void {
  const el = view.querySelector<HTMLElement>("#standResults");
  if (!el) return;
  el.innerHTML = domainResultsHtml();
  wireRows(el);
}
function wireControls(): void {
  const search = view.querySelector<HTMLInputElement>("#standSearch");
  search?.addEventListener("input", () => { standQuery = search.value; renderResults(); });
  const pill = view.querySelector<HTMLElement>("#standOut");
  pill?.addEventListener("click", () => {
    standOff = !standOff;
    pill.classList.toggle("on", standOff);
    pill.setAttribute("aria-pressed", standOff ? "true" : "false");
    renderResults();
  });
}

function bodyDetailHtml(): string {
  // The Body detail is the full body-progress home: the shipped body-metrics
  // surface (the glowing figure, "where you stand" indicators, height, one-tap
  // tape logging, and per-site + weight trend sparklines) mounts into
  // #standBodyMetrics on showBody(). We keep only the DEXA / body-composition
  // markers (the "body" clinical group) below it, for their inline charts.
  const dexa = markersOfGroup("body").map((m) => HM()?.hmkRowHtml?.(m) as string).filter(Boolean).join("");
  return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Body</h2>
      <div id="standBodyMetrics" class="stand-bodymetrics"></div>
      ${dexa ? `<div class="stand-subhead">From your DEXA</div><div class="hmk-list">${dexa}</div>` : ""}
    </div>`;
}

// ---- render + wire -------------------------------------------------------------
function paint(html: string): void {
  view.innerHTML = html;
  // A background (stale-while-revalidate) repaint must not re-run the view-enter
  // animation — that would flash the whole screen for an invisible data refresh.
  if (quietPaint) return;
  if (typeof (globalThis as unknown as { viewEnter?: () => void }).viewEnter === "function") {
    (globalThis as unknown as { viewEnter: () => void }).viewEnter();
  }
}
function showOverview(): void {
  curView = "overview";
  setStandSeg(null);
  // Stepped back from a self-contained tool before the overview data landed →
  // hold the calm loading state until the in-flight fetch resolves.
  if (!DATA) {
    paint(`<div class="stand-loading loadstate"><span class="loadstate-label">Reading where you stand…</span></div>`);
    (LOADP || loadStandData()).then(() => {
      if (state.tab === "stand" && !state.standSeg && DATA) { paint(overviewHtml()); wireOverview(); }
      else if (state.tab === "stand" && !state.standSeg) paint(standErrorHtml());
    });
    return;
  }
  paint(overviewHtml());
  wireOverview();
}
function showBody(): void {
  curView = "body";
  setStandSeg("body");
  paint(bodyDetailHtml());
  wireBack();
  // Hand the mount to the self-contained body-metrics surface (log + trends).
  (BM()?.renderBodyMetrics as ((m: HTMLElement | null) => void) | undefined)?.(view.querySelector<HTMLElement>("#standBodyMetrics"));
  wireRows(view);
}
function showRecovery(): void { curView = "recovery"; setStandSeg("recovery"); paint(recoveryDetailHtml()); wireBack(); }
function showSupplements(): void {
  curView = "supplements";
  setStandSeg("supplements");
  // The manageable supplements card (plain-words add + remove) hosts in place of
  // the old read-only list — say it once, Cairn folds it into your reads.
  paint(toolShellHtml("Supplements", `<div id="hbSupplements"></div>`,
    "What you take — Cairn folds these into your reads (e.g. creatine nudges eGFR)."));
  wireBack();
  CairnHealthReadSupplements.load(readDeps(), pollToken);
}

function wireOverview(): void {
  view.querySelectorAll<HTMLElement>("[data-domain]").forEach((b) =>
    b.addEventListener("click", () => showDomain(b.dataset.domain || "")));
  view.querySelector<HTMLElement>("[data-body]")?.addEventListener("click", () => showBody());
  view.querySelector<HTMLElement>("[data-recovery]")?.addEventListener("click", () => showRecovery());
  view.querySelector<HTMLElement>("[data-supps]")?.addEventListener("click", () => showSupplements());
  view.querySelector<HTMLElement>("[data-connections]")?.addEventListener("click", () => showConnections());
  view.querySelector<HTMLElement>("[data-age]")?.addEventListener("click", () => showAge());
  view.querySelector<HTMLElement>("[data-allmarkers]")?.addEventListener("click", () => showAllMarkers());
  view.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      const tool = b.dataset.tool || "";
      if (tool === "add") showRecords({ openPicker: true });
      else if (tool === "records") showRecords();
      else if (tool === "share") showShare();
      else if (tool === "learned") showLearned();
    }));
  // The agentic whole-picture read: generate on first run, refresh after new labs.
  view.querySelector<HTMLElement>("[data-readrefresh]")?.addEventListener("click", () => triggerStandRead());
  view.querySelector<HTMLElement>("[data-readgen]")?.addEventListener("click", () => triggerStandRead());
  // the "⋯ more" tools menu in the sticky action bar
  const moreBtn = view.querySelector<HTMLElement>("[data-morebtn]");
  const moreMenu = view.querySelector<HTMLElement>("[data-moremenu]");
  moreBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = moreMenu?.hasAttribute("hidden");
    if (open) moreMenu?.removeAttribute("hidden");
    else moreMenu?.setAttribute("hidden", "");
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("click", () => moreMenu?.setAttribute("hidden", ""), { once: true });
  // "The full story" progressive-disclosure: story paragraph + deeper priorities.
  const storyToggle = view.querySelector<HTMLElement>("[data-storytoggle]");
  storyToggle?.addEventListener("click", () => {
    const story = view.querySelector<HTMLElement>("[data-story]");
    const open = story?.classList.toggle("open") || false;
    storyToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  // Your Read focus-zones: tap to expand the "why"; ask-the-coach deep-links.
  view.querySelectorAll<HTMLElement>("[data-zone]").forEach((z) =>
    z.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".stand-ask")) return;
      z.classList.toggle("open");
    }));
  view.querySelectorAll<HTMLElement>(".stand-ask").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const g = globalThis as unknown as { CairnHealthClient?: { askCoach?: (q: unknown) => void } };
      g.CairnHealthClient?.askCoach?.(b.getAttribute("data-ask"));
    }));
}
function wireBack(): void {
  view.querySelector<HTMLElement>("[data-back]")?.addEventListener("click", () => showOverview());
}
// marker row expand + chart + ask (mirrors the Markers catalog wiring)
function wireRows(wrap: ParentNode): void {
  wrap.querySelectorAll<HTMLElement>(".hmk-x .hmk-row").forEach((button) =>
    button.addEventListener("click", () => {
      const item = button.closest<HTMLElement>(".hmk");
      if (!item) return;
      const open = item.classList.toggle("open");
      button.setAttribute("aria-expanded", open ? "true" : "false");
    }));
  wrap.querySelectorAll<SVGElement>("svg.hchart").forEach((svg) => (HM()?.wireMarkerChart as ((s: SVGElement) => void) | undefined)?.(svg));
  wrap.querySelectorAll<HTMLElement>(".hmk-ask").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const g = globalThis as unknown as { CairnHealthClient?: { askCoach?: (q: unknown) => void } };
      g.CairnHealthClient?.askCoach?.(button.getAttribute("data-ask"));
    }));
}

function standErrorHtml(): string {
  return `<div class="stand-error loadstate"><span class="loadstate-label">Couldn't read your standing right now.</span></div>`;
}

// One fetch fills the whole overview snapshot; hosted tool views fetch their own
// data so a deep link paints immediately while this warms behind them. Pure — it
// returns the built payload and never touches module state, so the caller decides
// whether it wins the token race and whether the change warrants a repaint.
async function fetchStandData(): Promise<StandData> {
  const [priority, focus, body, synthRes, insightsRes, recoveryRes, suppRes, dirRes] = await Promise.all([
    api("/markers/priority") as unknown as Promise<{ markers?: StandMarker[]; groups?: StandGroup[] }>,
    (api("/coaching-focus") as unknown as Promise<Record<string, unknown>>).catch(() => null),
    (api("/body-metrics?unit=in") as unknown as Promise<Record<string, unknown>>).catch(() => null),
    (api("/health/synthesis") as unknown as Promise<{ synthesis?: StandSynthesis; stale?: unknown }>).catch(() => null),
    (api("/insights") as unknown as Promise<unknown>).catch(() => null),
    (api("/recovery") as unknown as Promise<Record<string, unknown>>).catch(() => null),
    (api("/supplements") as unknown as Promise<unknown>).catch(() => null),
    (api("/directives") as unknown as Promise<{ directives?: unknown[] }>).catch(() => null),
  ]);
  const insightsArr = Array.isArray(insightsRes)
    ? (insightsRes as Array<{ text?: unknown; kind?: unknown }>)
    : Array.isArray((insightsRes as { insights?: unknown } | null)?.insights)
      ? ((insightsRes as { insights: Array<{ text?: unknown; kind?: unknown }> }).insights)
      : [];
  const syn = synthRes && typeof synthRes === "object" ? synthRes.synthesis : null;
  return {
    markers: Array.isArray(priority?.markers) ? priority.markers : [],
    groups: Array.isArray(priority?.groups) ? priority.groups : [],
    focus,
    body,
    synthesis: syn || null,
    synthStale: !!(synthRes && typeof synthRes === "object" && (synthRes.stale ?? (syn as { stale?: unknown } | null)?.stale)),
    connections: insightsArr.filter((c) => c && String(c.kind || "") === "connection"),
    recovery: recoveryRes && typeof recoveryRes === "object" ? recoveryRes : null,
    supplements: (Array.isArray(suppRes) ? suppRes : (suppRes as { supplements?: unknown[] } | null)?.supplements || [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && (s as { active?: unknown }).active !== 0),
    directives: Array.isArray(dirRes?.directives)
      ? (dirRes.directives as unknown[]).filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      : [],
  };
}

// The canonical loader for cold paths (spinner → fetch → paint) and the step-back
// warm-behind. Token-guarded so a slower earlier fetch never clobbers a newer one.
function loadStandData(): Promise<void> {
  const token = ++reqToken;
  const p = fetchStandData().then((next) => {
    if (token !== reqToken) return; // a newer load already won
    DATA = next;
    saveSnapshot(next);
  });
  LOADP = p.catch(() => {});
  return p;
}

// The stale-while-revalidate background refresh: fetch fresh data behind an already-
// painted view; if it actually changed, quietly repaint the calm reads in place.
function revalidateStand(): Promise<void> {
  const token = ++reqToken;
  const p = fetchStandData().then((next) => {
    if (token !== reqToken) return; // superseded
    const prev = DATA;
    DATA = next;
    saveSnapshot(next);
    if (prev && standDataEqual(prev, next)) return; // nothing changed → no repaint
    quietRepaintStand();
  });
  LOADP = p.catch(() => {});
  return p.catch(() => {});
}

// Cheap structural equality — the payload is plain JSON, so a stable stringify is
// exact and fast enough for a once-per-entry compare.
function standDataEqual(a: StandData, b: StandData): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

// sessionStorage snapshot for an instant cold paint on the next open. Quota/parse
// safe — a failure just falls back to the normal loading → fetch path.
function saveSnapshot(data: StandData): void {
  try { sessionStorage.setItem(SNAP_KEY, JSON.stringify(data)); } catch { /* quota — skip */ }
}
function loadSnapshot(): StandData | null {
  try {
    const raw = sessionStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StandData;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.markers) ? parsed : null;
  } catch { return null; }
}

// Repaint after a background refresh found a change — but ONLY the calm, input-free
// reads (overview, recovery). Domain/markers/body carry in-progress state (search
// focus, expanded rows, an open tape-log form) that a silent repaint would wipe, and
// self-contained tool views own their own data — so those are left as-is (the fresh
// DATA still shows the next time they're entered). Scroll is preserved so there's
// never a visible jump.
function quietRepaintStand(): void {
  if (state.tab !== "stand") return;
  if (curView !== "overview" && curView !== "recovery") return;
  const y = window.scrollY;
  quietPaint = true;
  try {
    if (curView === "overview") showOverview();
    else showRecovery();
  } finally { quietPaint = false; }
  window.scrollTo(0, y);
}

// Regenerate the whole-picture read in place (the same background job the old
// health Read tab ran), then repaint the overview with the fresh synthesis.
function triggerStandRead(): void {
  void runOp("health_synthesis", {}, {
    path: "/health/synthesis",
    anchor: ".stand-read",
    caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
    guard: () => !(state.tab === "stand" && !state.standSeg),
    render: () => { void reloadStandRead(); },
    onFail: () => {
      toast("Couldn't read the picture right now — try again in a bit.");
    },
  });
}
async function reloadStandRead(): Promise<void> {
  try {
    const res = await api("/health/synthesis") as { synthesis?: StandSynthesis; stale?: unknown } | null;
    if (DATA && res && typeof res === "object") {
      DATA.synthesis = res.synthesis || DATA.synthesis;
      DATA.synthStale = !!res.stale;
    }
  } catch { /* keep the last read */ }
  if (state.tab === "stand" && !state.standSeg) showOverview();
}

// Paint one of the DATA-driven views straight from the in-memory snapshot.
function paintStandSeg(seg: ClientStandSection | null): void {
  if (seg === "markers") { showAllMarkers(); return; }
  if (seg === "body") { showBody(); return; }
  if (seg === "recovery") { showRecovery(); return; }
  showOverview();
}

async function renderStand(): Promise<void> {
  headerTitle.textContent = "Stand";
  const seg = state.standSeg || null;

  // Cold first paint: hydrate DATA from the sessionStorage snapshot so the overview
  // paints instantly, then background-revalidate. A truly cold open (no snapshot)
  // falls through to the loading state → fetch path below, exactly as before.
  if (!DATA) { const snap = loadSnapshot(); if (snap) DATA = snap; }

  // Self-contained tool views fetch their own data — paint immediately and warm the
  // overview snapshot behind them for the "‹ Stand" step back. The background
  // refresh never repaints a tool view (quietRepaintStand only touches overview /
  // recovery), so it stays put while its own data lands.
  if (seg && SELF_CONTAINED.has(seg as StandView)) {
    if (DATA) void revalidateStand(); else void loadStandData();
    if (seg === "records") return showRecords();
    if (seg === "share") return showShare();
    if (seg === "learned") return showLearned();
    if (seg === "connections") return showConnections();
    if (seg === "age") return showAge();
    if (seg === "supplements") return showSupplements();
  }

  // DATA-driven view. Warm (or snapshot-hydrated) → instant paint from cache, then
  // revalidate in the background (repaints only on a real change, preserving scroll).
  if (DATA) {
    paintStandSeg(seg);
    void revalidateStand();
    return;
  }
  // Truly cold, no snapshot: the calm loading state, then fetch and paint.
  paint(`<div class="stand-loading loadstate"><span class="loadstate-label">Reading where you stand…</span></div>`);
  try {
    await loadStandData();
  } catch {
    paint(standErrorHtml());
    return;
  }
  if (state.tab !== "stand") return;
  paintStandSeg(state.standSeg || null);
}

const CAIRN_STAND = { renderStand };
Object.assign(globalThis, { CairnStand: CAIRN_STAND, renderStand });
if (typeof window !== "undefined") {
  (window as unknown as { CairnStand: typeof CAIRN_STAND }).CairnStand = CAIRN_STAND;
}
})();
