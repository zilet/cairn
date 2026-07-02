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
type StandPriority = { label?: unknown; the_move?: unknown; move?: unknown; why_it_matters?: unknown; why?: unknown };
type StandSynthesis = { headline?: unknown; story?: unknown; priorities?: StandPriority[]; one_change?: unknown; generated_at?: unknown };
type StandData = {
  markers: StandMarker[];
  groups: StandGroup[];
  focus: Record<string, unknown> | null;
  body: Record<string, unknown> | null;
  synthesis: StandSynthesis | null;
  connections: Array<{ text?: unknown; kind?: unknown }>;
  recovery: Record<string, unknown> | null;
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
// domain-detail catalog state (mirrors the Markers view): which domain is open,
// the free-text search, and the out-of-range filter. Reset each time a domain opens.
let curDomain: string | null = null;
let standQuery = "";
let standOff = false;

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
function askLink(topic: string): string {
  const q = `Tell me more about ${topic} — what should I focus on?`;
  return `<button class="linkbtn linkbtn-plain linkbtn-sm stand-ask" type="button" data-ask="${escAttr(q)}">Ask the coach<span aria-hidden="true"> →</span></button>`;
}
function readHtml(): string {
  const syn = DATA?.synthesis;
  const headline = syn && typeof syn.headline === "string" ? syn.headline.trim() : "";
  const prios = (syn?.priorities || []).slice(0, 3);
  // No synthesis yet → fall back to the conductor focus line so Stand still leads.
  if (!headline && !prios.length) return focusHeroHtml();
  const age = syn && typeof syn.generated_at === "string" ? ` · ${relAge(syn.generated_at)}` : "";
  const zones = prios.map((p, i) => {
    const label = String(p.label || "");
    const move = String(p.the_move || p.move || "");
    const why = String(p.why_it_matters || p.why || "");
    const tone: StandStatus = i === 0 ? "warn" : "watch"; // the lead reads strongest
    return `<div class="stand-zone tone-${tone}" data-zone>
        <div class="stand-zt"><span class="hdot hdot-${tone}"></span><span class="stand-zlabel">${escHtml(label)}</span><span class="stand-zchev" aria-hidden="true">▾</span></div>
        ${move ? `<div class="stand-zmove">${escHtml(move)}</div>` : ""}
        <div class="stand-zwhy">${why ? escHtml(why) : ""}${askLink(label || "this")}</div>
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
      <span class="stand-read-k lbl">Your read${age}</span>
      ${headline ? `<p class="stand-read-lede">${escHtml(headline)}</p>` : ""}
      ${zones ? `<div class="stand-zones">${zones}</div>` : ""}
      ${oc}
      ${conns ? `<div class="stand-conns"><div class="stand-conns-h lbl">Quiet connections</div>${conns}</div>` : ""}
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
  const rec = recoveryData();
  const card = (label: string, value: string, sub = "") =>
    value ? `<div class="stand-mcard"><span class="stand-mcard-l">${escHtml(label)}</span><span class="stand-mcard-v">${escHtml(value)}</span>${sub ? `<span class="stand-mcard-sub">${escHtml(sub)}</span>` : ""}</div>` : "";
  const cards = rec ? [
    card("Sleep", sleepWord(rec.avg_sleep_min), Number.isFinite(Number(rec.avg_sleep_score)) ? `score ${Math.round(Number(rec.avg_sleep_score))}` : ""),
    card("HRV", Number.isFinite(Number(rec.avg_hrv_ms)) && Number(rec.avg_hrv_ms) > 0 ? `${Math.round(Number(rec.avg_hrv_ms))} ms` : ""),
    card("Resting HR", Number.isFinite(Number(rec.avg_resting_hr)) ? `${Math.round(Number(rec.avg_resting_hr))} bpm` : ""),
    card("Body battery", Number.isFinite(Number(rec.avg_body_battery)) ? `${Math.round(Number(rec.avg_body_battery))}` : ""),
  ].filter(Boolean).join("") : "";
  return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Recovery</h2>
      <p class="stand-read-lede" style="font-size:1rem">A 14-day read from your wearable — sleep, HRV and resting heart rate holding steady.</p>
      ${cards ? `<div class="stand-mcards">${cards}</div>` : `<p class="stand-empty">No wearable data yet.</p>`}
    </div>`;
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
      <div class="stand-browse lbl">Your markers</div>
      <div class="stand-grid">${tiles.map((t) => t.html).join("")}</div>
    </div>`;
}

// The health depth + the clinician-facing exports, reachable from Stand: the full
// agentic read, the doctor Share (clinical order + trends, untouched), uploaded
// Records, and the learned timeline.
// A sticky bar pinned to the top of Stand — Add labs is always one tap away
// (never buried at the scroll bottom); the rest of the health tools sit behind a
// quiet "⋯" menu in the same bar.
function actionBarHtml(): string {
  return `<div class="stand-actionbar">
      <button class="stand-addbtn" data-tool="records" type="button"><span class="stand-addbtn-p" aria-hidden="true">＋</span>Add labs or scan</button>
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
function goHealth(seg: string): void {
  const g = globalThis as unknown as {
    state?: { meSeg?: string; healthSeg?: string; healthSegPicked?: boolean };
    activateTab?: (t: string) => void;
  };
  if (g.state) { g.state.meSeg = "health"; g.state.healthSeg = seg; g.state.healthSegPicked = true; }
  g.activateTab?.("me");
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
  const d = DOMAINS.find((x) => x.key === curDomain);
  if (!d) return "";
  // Sections = the domain's clinical groups, worst first, each with its own head +
  // sub-group sub-heads — so the fine taxonomy stays usable one tap down.
  const present = (DATA?.groups || []).filter((g) => d.groups.includes(g.key) && markersOfGroup(g.key).length);
  present.sort((a, b) => RANK[worstOf(markersOfGroup(b.key))] - RANK[worstOf(markersOfGroup(a.key))]);
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
  const d = DOMAINS.find((x) => x.key === key);
  const markers = d ? markersOfDomain(d) : [];
  const outCount = markers.filter(markerOutOfRange).length;
  paint(`<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">${escHtml(d?.label || "Markers")}</h2>
      ${standControlsHtml(markers.length, outCount)}
      <div id="standResults"></div>
    </div>`);
  wireBack();
  wireControls();
  renderResults();
}
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
  const body = DATA?.body as Record<string, unknown> | null;
  const comp = body && body.comp && typeof body.comp === "object" ? (body.comp as Record<string, unknown>) : null;
  const scales = comp && Array.isArray(comp.scales) ? (comp.scales as Array<Record<string, unknown>>) : [];
  const focus = comp && comp.focus && typeof comp.focus === "object" ? (comp.focus as Record<string, unknown>) : null;
  // reuse the shipped body figure: waist glows when the lever is central-fat.
  const fk = focus && typeof focus.key === "string" ? focus.key : null;
  const figFocus = fk === "whtr" || fk === "whr" || fk === "bodyfat" ? "waist" : null;
  const fig = (BM()?.bodyFigureSvg?.(figFocus, []) as string) || "";
  const focusLine = focus && typeof focus.line === "string" ? focus.line : "";
  const cards = scales.filter((s) => s.value != null).map((s) => {
    const off = focus ? "" : "";
    return `<div class="stand-mcard ${off}"><span class="stand-mcard-l">${escHtml(String(s.label || ""))}</span><span class="stand-mcard-v">${escHtml(String(s.value))}${s.unit ? escHtml(String(s.unit)) : ""}</span></div>`;
  }).join("");
  // Fold the DEXA / body-composition markers (the "body" clinical group) in here too.
  const dexa = markersOfGroup("body").map((m) => HM()?.hmkRowHtml?.(m) as string).filter(Boolean).join("");
  return `<div class="stand-detail stand-root">
      <button class="stand-back linkbtn linkbtn-plain" data-back>‹ Stand</button>
      <h2 class="stand-detail-h">Body</h2>
      <div class="stand-figrow">${fig}<div class="stand-figtxt">${focusLine ? `<p>${escHtml(focusLine)}</p>` : "<p>Holding steady — log a tape session to refresh the read.</p>"}</div></div>
      ${cards ? `<div class="stand-mcards">${cards}</div>` : ""}
      ${dexa ? `<div class="stand-subhead">From your DEXA</div><div class="hmk-list">${dexa}</div>` : ""}
    </div>`;
}

// ---- render + wire -------------------------------------------------------------
function paint(html: string): void {
  view.innerHTML = html;
  if (typeof (globalThis as unknown as { viewEnter?: () => void }).viewEnter === "function") {
    (globalThis as unknown as { viewEnter: () => void }).viewEnter();
  }
}
function showOverview(): void { paint(overviewHtml()); wireOverview(); }
function showBody(): void { paint(bodyDetailHtml()); wireBack(); wireRows(view); }
function showRecovery(): void { paint(recoveryDetailHtml()); wireBack(); }

function wireOverview(): void {
  view.querySelectorAll<HTMLElement>("[data-domain]").forEach((b) =>
    b.addEventListener("click", () => showDomain(b.dataset.domain || "")));
  view.querySelector<HTMLElement>("[data-body]")?.addEventListener("click", () => showBody());
  view.querySelector<HTMLElement>("[data-recovery]")?.addEventListener("click", () => showRecovery());
  view.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) =>
    b.addEventListener("click", () => goHealth(b.dataset.tool || "read")));
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

async function renderStand(): Promise<void> {
  headerTitle.textContent = "Stand";
  paint(`<div class="stand-loading loadstate"><span class="loadstate-label">Reading where you stand…</span></div>`);
  try {
    const [priority, focus, body, synthRes, insightsRes, recoveryRes] = await Promise.all([
      api("/markers/priority") as unknown as Promise<{ markers?: StandMarker[]; groups?: StandGroup[] }>,
      (api("/coaching-focus") as unknown as Promise<Record<string, unknown>>).catch(() => null),
      (api("/body-metrics?unit=in") as unknown as Promise<Record<string, unknown>>).catch(() => null),
      (api("/health/synthesis") as unknown as Promise<{ synthesis?: StandSynthesis }>).catch(() => null),
      (api("/insights") as unknown as Promise<unknown>).catch(() => null),
      (api("/recovery") as unknown as Promise<Record<string, unknown>>).catch(() => null),
    ]);
    const insightsArr = Array.isArray(insightsRes)
      ? (insightsRes as Array<{ text?: unknown; kind?: unknown }>)
      : Array.isArray((insightsRes as { insights?: unknown } | null)?.insights)
        ? ((insightsRes as { insights: Array<{ text?: unknown; kind?: unknown }> }).insights)
        : [];
    DATA = {
      markers: Array.isArray(priority?.markers) ? priority.markers : [],
      groups: Array.isArray(priority?.groups) ? priority.groups : [],
      focus,
      body,
      synthesis: (synthRes && typeof synthRes === "object" ? synthRes.synthesis : null) || null,
      connections: insightsArr.filter((c) => c && String(c.kind || "") === "connection"),
      recovery: recoveryRes && typeof recoveryRes === "object" ? recoveryRes : null,
    };
    showOverview();
  } catch {
    paint(`<div class="stand-error loadstate"><span class="loadstate-label">Couldn't read your standing right now.</span></div>`);
  }
}

const CAIRN_STAND = { renderStand };
Object.assign(globalThis, { CairnStand: CAIRN_STAND, renderStand });
if (typeof window !== "undefined") {
  (window as unknown as { CairnStand: typeof CAIRN_STAND }).CairnStand = CAIRN_STAND;
}
})();
