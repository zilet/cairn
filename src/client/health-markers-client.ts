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
};

type HealthMarkersRow = {
  key?: unknown;
  name?: unknown;
  unit?: unknown;
  latest?: HealthMarkersPoint | null;
  prev?: HealthMarkersPoint | null;
  points?: HealthMarkersPoint[] | null;
  optimal?: HealthMarkersBand | null;
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

// Richer inline progress chart: hand-built SVG, no library. Shades the optimal-zone
// band, draws a Catmull-Rom curve, and labels endpoint dates. Values go into numeric
// attributes; text is escaped through the same global helpers as the legacy screen.
function markerChartSvg(marker: HealthMarkersRow | null | undefined): string {
  const raw = markerPoints(marker).filter((point) => point && Number.isFinite(Number(point.value)));
  if (raw.length < 2) return "";
  const W = 300, H = 108, L = 14, R = 14, T = 14, B = 26;
  const vals = raw.map((point) => Number(point.value));
  let min = Math.min(...vals), max = Math.max(...vals);
  const optimal = marker?.optimal && Number.isFinite(Number(marker.optimal.low)) && Number.isFinite(Number(marker.optimal.high))
    ? marker.optimal
    : null;
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

// Expanded panel: chart, optimal-band caption, trend words, and latest reading.
function markerPanelHtml(marker: HealthMarkersRow | null | undefined): string {
  const latest = marker?.latest || {};
  const chart = markerChartSvg(marker);
  if (!chart) return "";
  const band = marker?.optimal && Number.isFinite(Number(marker.optimal.low)) && Number.isFinite(Number(marker.optimal.high))
    ? `optimal ${escHtml(formatMarkerNumber(marker.optimal.low))}–${escHtml(formatMarkerNumber(marker.optimal.high))}${marker.unit ? " " + escHtml(marker.unit) : ""}`
    : "";
  const trend = markerTrendWord(marker);
  const caption = [band, trend].filter(Boolean).join(" · ");
  const latestValue = latest.value != null && latest.value !== "" ? formatMarkerNumber(latest.value) : "";
  const age = latest.date ? relAge(String(latest.date)) : "";
  const latestLine = latestValue
    ? `<div class="hchart-latest">
        <span class="hchart-latest-v">${escHtml(latestValue)}${marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : ""}</span>
        ${age ? `<span class="hchart-latest-when" title="${escAttr(absDate(String(latest.date)))}">latest · ${escHtml(age)}</span>` : ""}
      </div>`
    : "";
  return `${latestLine}${chart}${caption ? `<div class="hchart-cap">${caption}</div>` : ""}`;
}

function hmkRowHtml(marker: HealthMarkersRow | null | undefined, index = 0): string {
  const latest = marker?.latest || {};
  const exp = markerPoints(marker).filter((point) => point && Number.isFinite(Number(point.value))).length >= 2;
  const lv = Number(latest.value), pv = marker?.prev ? Number(marker.prev.value) : NaN;
  let delta = "";
  if (Number.isFinite(lv) && Number.isFinite(pv) && lv !== pv) {
    const df = lv - pv;
    delta = `<span class="hmk-delta">${df > 0 ? "▲" : "▼"} ${escHtml(formatMarkerNumber(Math.abs(df)))}</span>`;
  }
  const age = latest.date ? relAge(String(latest.date)) : "";
  const when = age ? `<span class="hmk-when" title="${escAttr(absDate(String(latest.date)))}">${escHtml(age)}</span>` : "";
  const unit = marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : "";
  const rowInner = `<span class="hdot ${CairnHealthPicture.healthDotClass(latest.flag)}"></span>
      <span class="hmk-id">
        <span class="hmk-name">${escHtml(marker?.name || marker?.key || "")}</span>
        ${when}
      </span>
      <span class="hmk-right">
        ${delta}
        <span class="hmk-val">${escHtml(formatMarkerNumber(latest.value))}${unit}</span>
        <span class="hmk-chev${exp ? "" : " hmk-chev-ghost"}" aria-hidden="true">${exp ? "▾" : ""}</span>
      </span>`;
  return `<div class="hmk reveal${exp ? " hmk-x" : ""}" style="${stagger(index)}" data-mkey="${escAttr(marker?.key || "")}">
    ${exp
      ? `<button class="hmk-row" aria-expanded="false">${rowInner}</button>
        <div class="hmk-panel"><div class="hmk-panel-in">${markerPanelHtml(marker)}</div></div>`
      : `<div class="hmk-row">${rowInner}</div>`}
  </div>`;
}

const CAIRN_HEALTH_MARKERS = {
  formatMarkerNumber,
  sparkDateLabel,
  markerTrendWord,
  markerSpanWord,
  markerChartSvg,
  wireMarkerChart,
  markerPanelHtml,
  hmkRowHtml,
};

Object.assign(globalThis, { CairnHealthMarkers: CAIRN_HEALTH_MARKERS });

if (typeof window !== "undefined") {
  window.CairnHealthMarkers = CAIRN_HEALTH_MARKERS;
}
})();
