// @ts-check
// Pure Health marker row/chart helpers for the vanilla PWA.

type HealthMarkersPoint = { value?: unknown; date?: unknown; flag?: unknown; reported?: unknown /* as its lab printed it */ };

type HealthMarkersBand = { low?: unknown; high?: unknown; dir?: unknown };

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
  lab_out_of_range?: unknown; // "out of range" per the LAB, finished by the server (lab-range.ts)
  lab_out_of_range_side?: unknown;
  trend?: { dir?: unknown; span_days?: unknown } | null;
  // The active health_directive's own athlete-facing sentence when this marker
  // is currently shaping training/meals/watch — null otherwise (propagation.ts).
  active_directive?: unknown;
  // Wearable recovery markers (HRV / Resting HR) only — what the status ABOVE is judged
  // against (health-focus.ts's wearableWeeklyMarkerRead). 'week' carries a plain-words
  // note ("this week's average (N nights)"); 'single' means too few nights for a trend,
  // so `latest` is shown for reference but `in_optimal` is null — no status drawn from it.
  status_basis?: unknown;
  status_note?: unknown;
  trend_window?: { value?: unknown } | null; // the week's mean a 'week' status was judged on
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

// The catalog's shared "out of range" definition: outside the LAB's range (the server's
// finished read, below), or outside the optimal band (the doctor report's findings set).
function markerOutOfRange(marker: HealthMarkersRow | null | undefined): boolean {
  return !!labFlagWord(marker) || marker?.in_optimal === false;
}

// The LAB mark as one word ("high", "low", "abnormal", "critical"): the server's own read
// (`lab_out_of_range`/`_side`, src/repo/lab-range.ts), never re-derived here — a row
// without it carries no lab mark. Never the optimal band.
function labFlagWord(marker: HealthMarkersRow | null | undefined): string {
  if (marker?.lab_out_of_range !== true) return "";
  const flag = String(marker?.latest?.flag || "").toLowerCase();
  if (flaggedByLab(flag)) return flag;
  const side = marker?.lab_out_of_range_side;
  return side === "high" || side === "low" ? side : "outside range";
}

// The OPTIMAL phrase when the latest reading sits outside its optimal band: the side
// ("above optimal") when the band and value say which, else "outside optimal". ""
// inside the band or when no band judged it. Never the lab flag.
function offOptimalWord(marker: HealthMarkersRow | null | undefined): string {
  if (marker?.in_optimal !== false) return "";
  return optimalSideWord(marker) || "outside optimal";
}

// A specific, ready-to-send question about this marker for the "ask the coach"
// deep-link — grounded in the actual reading so the coach gets real context.
function markerAskQuestion(marker: HealthMarkersRow | null | undefined): string {
  const name = String(marker?.name || marker?.key || "this marker").replace(/\s+/g, " ").trim();
  const latest = marker?.latest || {};
  const unit = marker?.unit ? ` ${String(marker.unit)}` : "";
  const val = latest.value != null && latest.value !== "" ? `${formatMarkerNumber(latest.value)}${unit}` : "";
  const phrase = optimalPhrase(marker);
  if (markerOutOfRange(marker)) {
    const week = marker?.status_basis === "week" ? statusValue(marker) : Number.NaN;
    const status = Number.isFinite(week) ? `${formatMarkerNumber(week)}${unit} on average this week` : val;
    const side = optimalSideWord(marker);
    const where = side || (flaggedByLab(latest.flag) ? `flagged ${String(latest.flag).toLowerCase()}` : "outside its optimal range");
    const opt = phrase ? ` (optimal ${phrase})` : "";
    return `Can you tell me about my ${name}? It's ${status ? `${status}, ` : ""}${where}${opt}. What's likely driving it, and what should I focus on to improve it?`;
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

// What the status was judged on: a 'week' wearable's mean (never one night), else the latest.
function statusValue(marker: HealthMarkersRow | null | undefined): number {
  const v = marker?.status_basis === "week" ? marker.trend_window?.value : marker?.latest?.value;
  return v == null || v === "" ? Number.NaN : Number(v);
}

// Which side of the optimal band the STATUS sits on, in plain words ("" when unsaid).
function optimalSideWord(marker: HealthMarkersRow | null | undefined): string {
  const band = marker?.optimal;
  const low = Number(band?.low);
  const high = Number(band?.high);
  const value = statusValue(marker);
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

// The marker's trend chart: its readings on the shared line chart, shading the
// optimal band when there is one (else the lab reference range, so a rangeless
// marker still gets its "normal" band). A lab-flagged reading's dot reads watch.
function markerChartSvg(marker: HealthMarkersRow | null | undefined): string {
  const raw = markerPoints(marker).filter((point) => point && Number.isFinite(Number(point.value)));
  if (raw.length < 2) return "";
  const band = effectiveBand(marker);
  const unit = marker?.unit ? ` ${String(marker.unit)}` : "";
  return CairnUiChart.lineChartSvg({
    band: band ? { low: Number(band.low), high: Number(band.high) } : null,
    points: raw.map((point) => ({
      value: Number(point.value),
      label: sparkDateLabel(point.date),
      tip: `${formatMarkerNumber(point.value)}${unit} · ${sparkDateLabel(point.date)}`,
      tone: flaggedByLab(point.flag) ? "watch" : "ok",
    })),
  });
}

// Single-reading gauge: no history to chart yet, so show WHERE the one value
// sits against the optimal band, with only the band edge that matters labelled
// for a one-sided zone.
function markerBandSvg(marker: HealthMarkersRow | null | undefined): string {
  const band = effectiveBand(marker);
  const low = Number(band?.low);
  const high = Number(band?.high);
  const value = Number(marker?.latest?.value);
  if (!band || !Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(value)) return "";
  const dir = String(band.dir || "");
  return CairnUiChart.gaugeSvg({
    value,
    low,
    high,
    tone: flaggedByLab(marker?.latest?.flag) || value < low || value > high ? "watch" : "ok",
    lowLabel: dir !== "high" ? formatMarkerNumber(low) : "",
    highLabel: dir !== "low" ? formatMarkerNumber(high) : "",
  });
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
  // The row header now LEADS with the trajectory (trend-lead), so the panel caption
  // no longer repeats it for a multi-reading marker; a single reading still says so.
  const single = chart ? "" : "single reading";
  const weeklyNote = marker?.status_basis === "week" && marker?.status_note ? escHtml(String(marker.status_note)) : "";
  const caption = [band ? escHtml(band) : "", single, weeklyNote].filter(Boolean).join(" · ");
  const latestValue = latest.value != null && latest.value !== "" ? formatMarkerNumber(latest.value) : "";
  const age = latest.date ? relAge(String(latest.date)) : "";
  const latestLine = latestValue
    ? `<div class="hchart-latest">
        <span class="hchart-latest-v">${escHtml(latestValue)}${marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : ""}</span>
        ${age ? `<span class="hchart-latest-when" title="${escAttr(absDate(String(latest.date)))}">latest · ${escHtml(age)}</span>` : ""}
        ${latest.reported ? `<span class="hchart-latest-when">as reported ${escHtml(String(latest.reported))}</span>` : ""}
      </div>`
    : "";
  const ask = `<button class="linkbtn linkbtn-plain linkbtn-sm hmk-ask" type="button" data-ask="${escAttr(markerAskQuestion(marker))}">Ask the coach<span class="hmk-ask-arw" aria-hidden="true"> →</span></button>`;
  return `${latestLine}${chart || gauge}${caption ? `<div class="hchart-cap">${caption}</div>` : ""}${ask}`;
}

// The `.hmk` row lives in marker-row-client.ts (CairnMarkerRow); this name stays so the
// older Health tab and the Body view keep one entry point.
function hmkRowHtml(marker: HealthMarkersRow | null | undefined, index = 0): string {
  return CairnMarkerRow.rowHtml(marker, index);
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
  labFlagWord,
  offOptimalWord,
};

Object.assign(globalThis, { CairnHealthMarkers: CAIRN_HEALTH_MARKERS });

if (typeof window !== "undefined") {
  window.CairnHealthMarkers = CAIRN_HEALTH_MARKERS;
}
})();
