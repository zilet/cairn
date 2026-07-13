// @ts-check
// Pure Health marker row/chart helpers for the vanilla PWA.

type HealthMarkersPoint = {
  value?: unknown;
  date?: unknown;
  flag?: unknown;
};

type HealthMarkersBand = {
  low?: unknown;
  high?: unknown;
  dir?: unknown;
};

type HealthMarkersRow = {
  key?: unknown;
  name?: unknown;
  unit?: unknown;
  latest?: HealthMarkersPoint | null;
  prev?: HealthMarkersPoint | null;
  points?: HealthMarkersPoint[] | null;
  optimal?: HealthMarkersBand | null;
  reference?: { low?: unknown; high?: unknown } | null;
  reference_source?: unknown;
  reference_source_url?: unknown;
  in_optimal?: unknown;
  trend?: { dir?: unknown; span_days?: unknown } | null;
};

type HealthMarkersChartPoint = {
  x: number;
  y: number;
  t: string;
};

type HealthMarkersChartSvg = SVGElement & {
  _scrubWired?: boolean;
  dataset: DOMStringMap;
  setPointerCapture(pointerId: number): void;
};

(() => {
function markerPoints(marker: HealthMarkersRow | null | undefined): HealthMarkersPoint[] {
  return Array.isArray(marker?.points) ? marker.points : [];
}

function formatMarkerNumber(value: unknown): string {
  return CairnHealthClient.formatMarkerNumber(value);
}

function sparkDateLabel(value: unknown): string {
  return CairnHealthClient.sparkDateLabel(value);
}

function markerTrendWord(marker: HealthMarkersRow | null | undefined): string {
  return CairnHealthClient.markerTrendWord(marker);
}

function markerSpanWord(days: unknown): string {
  return CairnHealthClient.markerSpanWord(days);
}

function flaggedByLab(flag: unknown): boolean {
  const f = String(flag || "").toLowerCase();
  return f === "low" || f === "high" || f === "abnormal" || f === "critical";
}

// The optimal band as a target phrase honoring the zone's worse-direction:
// dir 'high' → lower is better ("≤ 100"), dir 'low' → higher is better
// ("≥ 40"), else the band ("70–100"). Unit appended when known. NOT escaped —
// callers escape.
function optimalPhrase(marker: HealthMarkersRow | null | undefined): string {
  const band = marker?.optimal;
  const low = Number(band?.low);
  const high = Number(band?.high);
  if (!band || !Number.isFinite(low) || !Number.isFinite(high)) return "";
  const dir = String(band.dir || "");
  const range = dir === "high"
    ? `≤ ${formatMarkerNumber(high)}`
    : dir === "low"
      ? `≥ ${formatMarkerNumber(low)}`
      : `${formatMarkerNumber(low)}–${formatMarkerNumber(high)}`;
  return `${range}${marker?.unit ? ` ${String(marker.unit)}` : ""}`;
}

// The catalog's shared "out of range" definition: lab-flagged, or lab-normal
// but outside the optimal band (the doctor report's findings set).
function markerOutOfRange(marker: HealthMarkersRow | null | undefined): boolean {
  return flaggedByLab(marker?.latest?.flag) || marker?.in_optimal === false;
}

// A specific, ready-to-send question about this marker for the "ask the coach"
// deep-link — grounded in the actual reading so the coach gets real context.
function markerAskQuestion(marker: HealthMarkersRow | null | undefined): string {
  const name = String(marker?.name || marker?.key || "this marker").replace(/\s+/g, " ").trim();
  const latest = marker?.latest || {};
  const val = latest.value != null && latest.value !== ""
    ? `${formatMarkerNumber(latest.value)}${marker?.unit ? ` ${String(marker.unit)}` : ""}`
    : "";
  const phrase = optimalPhrase(marker);
  if (markerOutOfRange(marker)) {
    const side = optimalSideWord(marker);
    const where = side || (flaggedByLab(latest.flag) ? `flagged ${String(latest.flag).toLowerCase()}` : "outside its optimal range");
    const opt = phrase ? ` (optimal ${phrase})` : "";
    return `Can you tell me about my ${name}? It's ${val ? `${val}, ` : ""}${where}${opt}. What's likely driving it, and what should I focus on to improve it?`;
  }
  return `Can you tell me about my ${name}${val ? ` — it's ${val}` : ""}? Is this something I should keep an eye on?`;
}

// The reference range as a phrase ("65–175", "≤ 130", "≥ 40"). Usually this is
// the lab's printed interval; standard markers may use a curated fallback when
// the upload omitted one.
// Unit appended when known. NOT escaped — callers escape.
function referenceRangePhrase(marker: HealthMarkersRow | null | undefined): string {
  const ref = marker?.reference;
  // NB: Number(null) is 0, not NaN — a null bound must be treated as absent, not 0.
  const hasLow = ref?.low != null && Number.isFinite(Number(ref.low));
  const hasHigh = ref?.high != null && Number.isFinite(Number(ref.high));
  const low = Number(ref?.low);
  const high = Number(ref?.high);
  if (!ref || (!hasLow && !hasHigh)) return "";
  const unit = marker?.unit ? ` ${String(marker.unit)}` : "";
  const range = hasLow && hasHigh
    ? `${formatMarkerNumber(low)}–${formatMarkerNumber(high)}`
    : hasHigh ? `≤ ${formatMarkerNumber(high)}` : `≥ ${formatMarkerNumber(low)}`;
  return `${range}${unit}`;
}

// The one reference a row shows: the number it's being compared to. The
// evidence-anchored optimal band when we have one (the stronger framing), else the
// clinical reference range. "" when there's no number to compare against —
// the status colour carries the read then, never a written-out "in range". NOT escaped.
function markerReferenceSub(marker: HealthMarkersRow | null | undefined): string {
  const opt = optimalPhrase(marker);
  if (opt) return `optimal ${opt}`;
  const ref = referenceRangePhrase(marker);
  if (ref) return `range ${ref}`;
  return "";
}

// The at-a-glance status — a traffic-light read that DRIVES the colour (dot + value),
// so "good" needs no words. Optimal-aware, not just the lab flag: a value the lab
// calls "normal" can still sit outside its longevity-optimal band (watch), and a
// value outside the lab's OWN printed range reads warn even if the flag is missing.
//   warn  (red)   — lab-flagged low/high, or outside the reference range
//   watch (amber) — in range but off the optimal target band
//   ok    (green) — inside the optimal band or the lab range
//   mute  (grey)  — nothing to compare against (a qualitative row)
function markerStatus(marker: HealthMarkersRow | null | undefined): "ok" | "watch" | "warn" | "mute" {
  const labFlag = String(marker?.latest?.flag || "").toLowerCase();
  if (flaggedByLab(labFlag)) return "warn";
  if (marker?.in_optimal === false) return "watch";
  const v = Number(marker?.latest?.value);
  const ref = marker?.reference;
  if (ref && Number.isFinite(v)) {
    const overHigh = ref.high != null && Number.isFinite(Number(ref.high)) && v > Number(ref.high);
    const underLow = ref.low != null && Number.isFinite(Number(ref.low)) && v < Number(ref.low);
    if (overHigh || underLow) return "warn";
    if (ref.low != null || ref.high != null) return "ok";
  }
  if (labFlag === "normal" || marker?.in_optimal === true) return "ok";
  return "mute";
}

// The band to draw a gauge/chart against: the optimal zone (preferred) or, absent
// one, the two-sided reference range. One-sided ranges can't anchor a gauge
// (no opposite edge) so they're excluded here — the row line still states them.
function effectiveBand(marker: HealthMarkersRow | null | undefined):
  { low: number; high: number; dir: string; kind: "optimal" | "reference" } | null {
  const o = marker?.optimal;
  const oLow = Number(o?.low), oHigh = Number(o?.high);
  if (o && Number.isFinite(oLow) && Number.isFinite(oHigh)) {
    return { low: oLow, high: oHigh, dir: String(o.dir || "band"), kind: "optimal" };
  }
  const r = marker?.reference;
  // A gauge needs both edges; Number(null) is 0, so guard the null explicitly.
  if (r && r.low != null && r.high != null) {
    const rLow = Number(r.low), rHigh = Number(r.high);
    if (Number.isFinite(rLow) && Number.isFinite(rHigh)) return { low: rLow, high: rHigh, dir: "band", kind: "reference" };
  }
  return null;
}

// Which side of the optimal band the latest value sits on, in plain words.
function optimalSideWord(marker: HealthMarkersRow | null | undefined): string {
  const band = marker?.optimal;
  const low = Number(band?.low);
  const high = Number(band?.high);
  const value = Number(marker?.latest?.value);
  if (!band || !Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(value)) return "";
  return value > high ? "above optimal" : value < low ? "below optimal" : "";
}

// The trend-lead tone: is the latest movement carrying this marker TOWARD its
// optimal zone, AWAY from it, or neither? Sage 'toward' (improving), terracotta
// 'away' (worsening AND currently out of range — a lever, never punishment),
// muted 'stable' otherwise (no clear direction, drift inside a two-sided band, or
// no optimal anchor to judge against). Derived only from data already on the row —
// the trend direction plus the optimal zone's worse-direction — so it never needs
// a server field.
function markerTrendTone(marker: HealthMarkersRow | null | undefined): "toward" | "away" | "stable" {
  const dir = String(marker?.trend?.dir || "");
  if (dir !== "rising" && dir !== "falling") return "stable";
  const band = marker?.optimal;
  const low = Number(band?.low);
  const high = Number(band?.high);
  if (!band || !Number.isFinite(low) || !Number.isFinite(high)) return "stable";
  const zoneDir = String(band.dir || "band");
  let toward: boolean;
  if (zoneDir === "high") {
    toward = dir === "falling"; // high is the worse direction → falling improves
  } else if (zoneDir === "low") {
    toward = dir === "rising"; // low is the worse direction → rising improves
  } else {
    // Two-sided band: only a value already outside the band has a clear direction
    // home; drift inside the band stays calm.
    const value = Number(marker?.latest?.value);
    if (!Number.isFinite(value)) return "stable";
    if (value > high) toward = dir === "falling";
    else if (value < low) toward = dir === "rising";
    else return "stable";
  }
  if (toward) return "toward";
  // Moving the wrong way reads as attention only when the marker is actually off —
  // an in-range drift is calm information, not a lever.
  return markerOutOfRange(marker) ? "away" : "stable";
}

// Richer inline progress chart: hand-built SVG, no library. Shades the optimal-zone
// band, draws a Catmull-Rom curve, and labels endpoint dates. Values go into numeric
// attributes; text is escaped through the same global helpers as the legacy screen.
function markerChartSvg(marker: HealthMarkersRow | null | undefined): string {
  const raw = markerPoints(marker).filter((point) => point && Number.isFinite(Number(point.value)));
  if (raw.length < 2) return "";
  const W = 300, H = 108, L = 14, R = 14, T = 14, B = 26;
  const vals = raw.map((point) => Number(point.value));
  let min = Math.min(...vals), max = Math.max(...vals);
  // Shade the optimal band when we have one, else the lab reference range — so a
  // rangeless marker still gets its "normal" band drawn once the lab range is known.
  const optimal = effectiveBand(marker);
  if (optimal) {
    min = Math.min(min, Number(optimal.low));
    max = Math.max(max, Number(optimal.high));
  }
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x = (index: number) => L + (index * (W - L - R)) / (raw.length - 1);
  const y = (value: number) => T + (1 - (value - min) / (max - min)) * (H - T - B);
  const points = raw.map((point, index) => [x(index), y(Number(point.value))] as const);
  let band = "";
  if (optimal) {
    const yHi = Math.max(T, y(Number(optimal.high))), yLo = Math.min(H - B, y(Number(optimal.low)));
    band = `<rect class="hchart-band" x="${L}" y="${yHi.toFixed(1)}" width="${(W - L - R).toFixed(1)}" height="${Math.max(1, yLo - yHi).toFixed(1)}" rx="3"/>`;
  }
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const dots = points.map(([px, py], index) => {
    const f = String(raw[index].flag || "").toLowerCase();
    const flagged = f === "low" || f === "high" || f === "abnormal" || f === "critical";
    return `<circle class="hchart-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${index === points.length - 1 ? 4 : 2.8}" fill="${flagged ? "#b3402e" : "#6e7f5c"}"/>`;
  }).join("");
  const unit = marker?.unit ? ` ${String(marker.unit)}` : "";
  const tipData: HealthMarkersChartPoint[] = raw.map((point, index) => ({
    x: Number(points[index][0].toFixed(1)),
    y: Number(points[index][1].toFixed(1)),
    t: `${formatMarkerNumber(point.value)}${unit} · ${sparkDateLabel(point.date)}`,
  }));
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" data-pts="${escAttr(JSON.stringify(tipData))}" aria-hidden="true">
      ${band}
      <path class="hchart-line" d="${d}" fill="none" stroke="#211d17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      <text class="hchart-txt" x="${L}" y="${H - 7}" text-anchor="start">${escHtml(sparkDateLabel(raw[0].date))}</text>
      <text class="hchart-txt" x="${W - R}" y="${H - 7}" text-anchor="end">${escHtml(sparkDateLabel(raw[raw.length - 1].date))}</text>
      <line class="hchart-guide" x1="0" y1="${T}" x2="0" y2="${H - B}"/>
      <circle class="hchart-cursor" cx="0" cy="0" r="4.2"/>
      <g class="hchart-tip" transform="translate(0,0)"><rect rx="9" x="0" y="0" width="0" height="18"/><text x="8" y="13"></text></g>
    </svg>`;
}

// Single-reading gauge: no history to chart yet, so show WHERE the one value
// sits against the optimal band — shaded zone on a track, a dot for the
// reading, band-edge labels (only the edge that matters for one-sided zones).
function markerBandSvg(marker: HealthMarkersRow | null | undefined): string {
  const band = effectiveBand(marker);
  const low = Number(band?.low);
  const high = Number(band?.high);
  const value = Number(marker?.latest?.value);
  if (!band || !Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(value)) return "";
  const W = 300, H = 46, L = 14, R = 14, y = 18;
  let min = Math.min(low, value), max = Math.max(high, value);
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const x = (v: number) => L + ((v - min) / (max - min)) * (W - L - R);
  const flagged = flaggedByLab(marker?.latest?.flag) || value < low || value > high;
  const bx = x(low), bw = Math.max(1, x(high) - x(low));
  const dir = String(band.dir || "");
  const labels = [
    dir !== "high" ? `<text class="hchart-txt" x="${bx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${escHtml(formatMarkerNumber(low))}</text>` : "",
    dir !== "low" ? `<text class="hchart-txt" x="${(bx + bw).toFixed(1)}" y="${H - 6}" text-anchor="middle">${escHtml(formatMarkerNumber(high))}</text>` : "",
  ].join("");
  return `<svg class="hchart hgauge" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <line class="hgauge-track" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/>
      <rect class="hchart-band" x="${bx.toFixed(1)}" y="${y - 7}" width="${bw.toFixed(1)}" height="14" rx="4"/>
      <circle class="hchart-dot" cx="${x(value).toFixed(1)}" cy="${y}" r="5" fill="${flagged ? "#b3402e" : "#6e7f5c"}"/>
      ${labels}
    </svg>`;
}

// Wire pointer scrubbing onto a marker chart SVG. Idempotent per element.
function wireMarkerChart(svg: SVGElement | null | undefined): void {
  const chartSvg = svg as HealthMarkersChartSvg | null | undefined;
  if (!chartSvg || chartSvg._scrubWired) return;
  let pts: HealthMarkersChartPoint[];
  try { pts = JSON.parse(chartSvg.dataset.pts || "[]") as HealthMarkersChartPoint[]; } catch { pts = []; }
  if (!Array.isArray(pts) || pts.length < 2) return;
  chartSvg._scrubWired = true;
  const VB = 300;
  const guide = chartSvg.querySelector(".hchart-guide");
  const cursor = chartSvg.querySelector(".hchart-cursor");
  const tip = chartSvg.querySelector(".hchart-tip");
  const tipRect = tip && tip.querySelector("rect");
  const tipText = tip && tip.querySelector("text");
  const last = pts[pts.length - 1];
  const cur = { x: last.x, y: last.y, pop: 0 };
  const tgt = { x: last.x, y: last.y, idx: pts.length - 1 };
  let touchActive = false, raf: number | null = null, tipW = 0;

  const apply = () => {
    if (guide) { guide.setAttribute("x1", cur.x.toFixed(1)); guide.setAttribute("x2", cur.x.toFixed(1)); }
    if (cursor) {
      cursor.setAttribute("cx", cur.x.toFixed(1));
      cursor.setAttribute("cy", cur.y.toFixed(1));
      cursor.setAttribute("r", (4.2 + 1.8 * cur.pop).toFixed(2));
    }
    if (tip) {
      const tx = Math.max(2, Math.min(cur.x - tipW / 2, VB - tipW - 2));
      const ty = cur.y - 26 < 0 ? cur.y + 8 : cur.y - 26;
      tip.setAttribute("transform", `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
    }
  };
  const tick = () => {
    cur.x += (tgt.x - cur.x) * 0.34; cur.y += (tgt.y - cur.y) * 0.34; cur.pop *= 0.8;
    const settled = Math.abs(cur.x - tgt.x) < 0.3 && Math.abs(cur.y - tgt.y) < 0.3 && cur.pop < 0.02;
    if (settled) { cur.x = tgt.x; cur.y = tgt.y; cur.pop = 0; }
    apply();
    raf = settled ? null : requestAnimationFrame(tick);
  };
  const setIdx = (index: number, snap: boolean) => {
    if ((index !== tgt.idx || snap) && tipText && tipRect) {
      tipText.textContent = pts[index].t;
      tipW = (tipText.getComputedTextLength ? tipText.getComputedTextLength() : pts[index].t.length * 5.2) + 16;
      tipRect.setAttribute("width", tipW.toFixed(1));
      if (index !== tgt.idx && !snap) cur.pop = 1;
    }
    tgt.x = pts[index].x; tgt.y = pts[index].y; tgt.idx = index;
    if (snap || reducedMotion()) { cur.x = tgt.x; cur.y = tgt.y; cur.pop = 0; apply(); return; }
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const show = (event: PointerEvent) => {
    const rect = chartSvg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = ((event.clientX - rect.left) / rect.width) * VB;
    let idx = 0, best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dd = Math.abs(pts[i].x - vx);
      if (dd < best) { best = dd; idx = i; }
    }
    const firstTouch = !chartSvg.classList.contains("scrubbing");
    chartSvg.classList.add("scrubbing");
    setIdx(idx, firstTouch);
  };
  const rest = () => chartSvg.classList.remove("scrubbing");
  chartSvg.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") { touchActive = true; try { chartSvg.setPointerCapture(event.pointerId); } catch {} }
    show(event);
  });
  chartSvg.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse" || touchActive) show(event); });
  chartSvg.addEventListener("pointerup", (event) => { if (event.pointerType !== "mouse") { touchActive = false; rest(); } });
  chartSvg.addEventListener("pointercancel", () => { touchActive = false; rest(); });
  chartSvg.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") rest(); });
}

// Expanded panel: chart (2+ readings) or band gauge (single reading with a
// known optimal zone), an optimal-target caption, trend words, latest reading.
function markerPanelHtml(marker: HealthMarkersRow | null | undefined): string {
  const latest = marker?.latest || {};
  const chart = markerChartSvg(marker);
  const gauge = chart ? "" : markerBandSvg(marker);
  if (!chart && !gauge) return "";
  // The reference, already labeled ("optimal 50–150" / "range 65–175" / "in range").
  const band = markerReferenceSub(marker);
  const side = optimalSideWord(marker);
  // The row header now LEADS with the trajectory (trend-lead), so the panel caption
  // no longer repeats it for a multi-reading marker; a single reading still says so.
  const single = chart ? "" : "single reading";
  const caption = [band ? escHtml(band) : "", side, single].filter(Boolean).join(" · ");
  const latestValue = latest.value != null && latest.value !== "" ? formatMarkerNumber(latest.value) : "";
  const age = latest.date ? relAge(String(latest.date)) : "";
  const latestLine = latestValue
    ? `<div class="hchart-latest">
        <span class="hchart-latest-v">${escHtml(latestValue)}${marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : ""}</span>
        ${age ? `<span class="hchart-latest-when" title="${escAttr(absDate(String(latest.date)))}">latest · ${escHtml(age)}</span>` : ""}
      </div>`
    : "";
  const ask = `<button class="linkbtn linkbtn-plain linkbtn-sm hmk-ask" type="button" data-ask="${escAttr(markerAskQuestion(marker))}">Ask the coach<span class="hmk-ask-arw" aria-hidden="true"> →</span></button>`;
  return `${latestLine}${chart || gauge}${caption ? `<div class="hchart-cap">${caption}</div>` : ""}${ask}`;
}

function hmkRowHtml(marker: HealthMarkersRow | null | undefined, index = 0): string {
  const latest = marker?.latest || {};
  const panel = markerPanelHtml(marker);
  const exp = !!panel;
  const lv = Number(latest.value), pv = marker?.prev ? Number(marker.prev.value) : NaN;
  let delta = "";
  if (Number.isFinite(lv) && Number.isFinite(pv) && lv !== pv) {
    const df = lv - pv;
    delta = `<span class="hmk-delta">${df > 0 ? "▲" : "▼"} ${escHtml(formatMarkerNumber(Math.abs(df)))}</span>`;
  }
  const age = latest.date ? relAge(String(latest.date)) : "";
  // Every row shows the NUMBER it's compared to (optimal band, else lab range) —
  // never a written-out "in range". The status colour, not prose, says good/off/out.
  const ref = markerReferenceSub(marker);
  const sub = [age, ref].filter(Boolean).join(" · ");
  const when = sub
    ? `<span class="hmk-when"${latest.date ? ` title="${escAttr(absDate(String(latest.date)))}"` : ""}>${escHtml(sub)}</span>`
    : "";
  const unit = marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : "";
  // Traffic-light status colours the dot AND the value, so what needs attention
  // (amber/red) pops while a good reading stays calm ink with a green dot.
  const st = markerStatus(marker);
  const valClass = st === "watch" ? " mst-watch" : st === "warn" ? " mst-warn" : "";
  // Trend-first: the row leads with what the marker is DOING (name + directional
  // phrase, toned toward/away/stable), and the latest value + range read as the
  // supporting detail (the figure on the right, the reference on the line below).
  const trendLead = CairnUiReads.trendLeadHtml({
    name: marker?.name || marker?.key || "",
    phrase: markerTrendWord(marker),
    tone: markerTrendTone(marker),
  });
  const rowInner = `<span class="hdot hdot-${st}"></span>
      <div class="hmk-id">
        ${trendLead}
        ${when}
      </div>
      <span class="hmk-right">
        ${delta}
        <span class="hmk-val${valClass}">${escHtml(formatMarkerNumber(latest.value))}${unit}</span>
        <span class="hmk-chev${exp ? "" : " hmk-chev-ghost"}" aria-hidden="true">${exp ? "▾" : ""}</span>
      </span>`;
  return `<div class="hmk reveal${exp ? " hmk-x" : ""}" style="${stagger(index)}" data-mkey="${escAttr(marker?.key || "")}">
    ${exp
      ? `<button class="hmk-row" aria-expanded="false">${rowInner}</button>
        <div class="hmk-panel"><div class="hmk-panel-in">${panel}</div></div>`
      : `<div class="hmk-row">${rowInner}</div>`}
  </div>`;
}

const CAIRN_HEALTH_MARKERS = {
  formatMarkerNumber,
  sparkDateLabel,
  markerTrendWord,
  markerSpanWord,
  optimalPhrase,
  optimalSideWord,
  markerTrendTone,
  referenceRangePhrase,
  markerReferenceSub,
  markerStatus,
  markerOutOfRange,
  markerAskQuestion,
  markerChartSvg,
  markerBandSvg,
  wireMarkerChart,
  markerPanelHtml,
  hmkRowHtml,
};

Object.assign(globalThis, { CairnHealthMarkers: CAIRN_HEALTH_MARKERS });

if (typeof window !== "undefined") {
  window.CairnHealthMarkers = CAIRN_HEALTH_MARKERS;
}
})();
