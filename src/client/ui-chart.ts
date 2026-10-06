// @ts-check
// The one chart module (docs/DESIGN.md "Component inventory"): the inline
// sparkline, the dated line chart with a shaded band and a scrub tip, the
// single-reading band gauge, and the zone bar. They share one linear scale and
// one date label. Pure string renderers: numbers go into numeric attributes,
// every caller string is escaped, and colour comes from classes in styles.css,
// never a hex literal here.
{
  type UiChartTone = "ok" | "watch";
  type UiChartPoint = {
    value: number;
    /** Axis label under the first / last point (already a date label). */
    label?: unknown;
    /** Scrub-tip text for this point. */
    tip?: unknown;
    tone?: UiChartTone;
  };
  type UiChartLineOptions = {
    points: ReadonlyArray<UiChartPoint>;
    /** A shaded value band (optimal zone, reference range). */
    band?: { low: number; high: number } | null;
  };
  type UiChartGaugeOptions = {
    value: number;
    low: number;
    high: number;
    tone?: UiChartTone;
    /** Edge labels; an empty or missing label is not drawn. */
    lowLabel?: unknown;
    highLabel?: unknown;
  };
  type UiChartZoneTone = "ok" | "watch" | "warn" | "info";
  type UiChartZoneOptions = {
    min: number;
    max: number;
    bands: ReadonlyArray<{ from: number; to: number; tone: string }>;
    optimal: { from: number; to: number };
    value: number | null;
    projected: number | null;
    /** The whole bar's accessible name. */
    label: unknown;
  };

  /** A linear map from [d0, d1] onto [r0, r1]. A zero-width domain maps to r0. */
  function linearScale(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
    const span = d1 - d0;
    return (value: number) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
  }

  /**
   * The value domain a chart draws over: the extent of `values` (plus any `include`
   * edges such as a band), widened by `pad` of its span on each side. A flat series
   * opens to ±1 so it never divides by zero.
   */
  function chartDomain(
    values: ReadonlyArray<number>,
    pad: number,
    include: ReadonlyArray<number> = []
  ): { min: number; max: number } {
    let min = Math.min(...values, ...include);
    let max = Math.max(...values, ...include);
    if (max === min) {
      max += 1;
      min -= 1;
    }
    const extra = (max - min) * pad;
    return { min: min - extra, max: max + extra };
  }

  /**
   * The one date label: "Jun 20" (or "Jun 20, 2026" with `year`). A bare
   * `YYYY-MM-DD` reads as that local calendar day; anything unparseable comes back
   * as given, and an empty value as "".
   */
  function dateLabel(value: unknown, options: { year?: boolean } = {}): string {
    if (value == null || value === "") return "";
    return CairnFmt.date(value, { style: "short", year: options.year ? "always" : false });
  }

  // Tiny inline sparkline (numbers only). The y-span is floored so a near-flat
  // series (bodyweight 70.0/70.1/69.9) never stretches noise into a full-height
  // zigzag; a wide series is unaffected, since centring a full-span band on its own
  // midpoint reduces exactly to [min, max].
  function sparkSvg(input: unknown, width = 132, height = 30): string {
    const values = (Array.isArray(input) ? input : []).map(Number).filter((n: number) => !Number.isNaN(n));
    if (values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mid = (max + min) / 2;
    const floor = Math.max(0.04 * Math.max(Math.abs(max), Math.abs(min)), 1e-6);
    const span = Math.max(max - min, floor);
    const x = linearScale(0, values.length - 1, 2, width - 2);
    const y = linearScale(mid - span / 2, mid + span / 2, height - 3, 3);
    const pts = values.map((n: number, i: number) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
    const last = values[values.length - 1];
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="currentColor"/>
    </svg>`;
  }

  // A Catmull-Rom curve through the points, as SVG cubic segments.
  function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
    let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  // The dated line chart: an optional shaded band, a smooth curve, a dot per
  // reading (toned ok / watch), endpoint labels, and the scrub guide, cursor and
  // tip (`data-pts` carries each point's position and tip text for the wiring).
  function lineChartSvg(options: UiChartLineOptions): string {
    const raw = (options.points || []).filter((point) => Number.isFinite(point.value));
    if (raw.length < 2) return "";
    const W = 300,
      H = 108,
      L = 14,
      R = 14,
      T = 14,
      B = 26;
    const band =
      options.band && Number.isFinite(options.band.low) && Number.isFinite(options.band.high) ? options.band : null;
    const { min, max } = chartDomain(
      raw.map((point) => point.value),
      0.08,
      band ? [band.low, band.high] : []
    );
    const x = linearScale(0, raw.length - 1, L, W - R);
    const y = linearScale(min, max, H - B, T);
    const points = raw.map((point, index) => [x(index), y(point.value)] as const);
    const bandRect = band
      ? (() => {
          const yHi = Math.max(T, y(band.high));
          const yLo = Math.min(H - B, y(band.low));
          return `<rect class="hchart-band" x="${L}" y="${yHi.toFixed(1)}" width="${(W - L - R).toFixed(1)}" height="${Math.max(1, yLo - yHi).toFixed(1)}" rx="3"/>`;
        })()
      : "";
    const dots = points
      .map(
        ([px, py], index) =>
          `<circle class="hchart-dot hchart-dot-${raw[index].tone === "watch" ? "watch" : "ok"}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${index === points.length - 1 ? 4 : 2.8}"/>`
      )
      .join("");
    const tipData = raw.map((point, index) => ({
      x: Number(points[index][0].toFixed(1)),
      y: Number(points[index][1].toFixed(1)),
      t: String(point.tip ?? ""),
    }));
    return `<svg class="hchart" viewBox="0 0 ${W} ${H}" data-pts="${escAttr(JSON.stringify(tipData))}" aria-hidden="true">
      ${bandRect}
      <path class="hchart-line" d="${smoothPath(points)}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      <text class="hchart-txt" x="${L}" y="${H - 7}" text-anchor="start">${escHtml(raw[0].label ?? "")}</text>
      <text class="hchart-txt" x="${W - R}" y="${H - 7}" text-anchor="end">${escHtml(raw[raw.length - 1].label ?? "")}</text>
      <line class="hchart-guide" x1="0" y1="${T}" x2="0" y2="${H - B}"/>
      <circle class="hchart-cursor" cx="0" cy="0" r="4.2"/>
      <g class="hchart-tip" transform="translate(0,0)"><rect rx="9" x="0" y="0" width="0" height="18"/><text x="8" y="13"></text></g>
    </svg>`;
  }

  // Single-reading gauge: where one value sits against a band on a track.
  function gaugeSvg(options: UiChartGaugeOptions): string {
    const { value, low, high } = options;
    if (![value, low, high].every(Number.isFinite)) return "";
    const W = 300,
      H = 46,
      L = 14,
      R = 14,
      cy = 18;
    const { min, max } = chartDomain([value], 0.1, [low, high]);
    const x = linearScale(min, max, L, W - R);
    const bx = x(low);
    const bw = Math.max(1, x(high) - x(low));
    const edge = (at: number, label: unknown) =>
      label == null || String(label) === ""
        ? ""
        : `<text class="hchart-txt" x="${at.toFixed(1)}" y="${H - 6}" text-anchor="middle">${escHtml(label)}</text>`;
    return `<svg class="hchart hgauge" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <line class="hgauge-track" x1="${L}" y1="${cy}" x2="${W - R}" y2="${cy}"/>
      <rect class="hchart-band" x="${bx.toFixed(1)}" y="${cy - 7}" width="${bw.toFixed(1)}" height="14" rx="4"/>
      <circle class="hchart-dot hchart-dot-${options.tone === "watch" ? "watch" : "ok"}" cx="${x(value).toFixed(1)}" cy="${cy}" r="5"/>
      ${edge(bx, options.lowLabel)}${edge(bx + bw, options.highLabel)}
    </svg>`;
  }

  const ZONE_TONES: ReadonlySet<string> = new Set<UiChartZoneTone>(["ok", "watch", "warn", "info"]);

  // Zone bar: a value's plain-language bands (the optimal band reads stronger), a
  // solid dot for now, and a dashed hollow dot where the current pace lands.
  // Words and position, never a score.
  function zoneBarSvg(options: UiChartZoneOptions): string {
    const W = 300,
      H = 26,
      PAD = 8,
      barY = 6,
      barH = 8,
      mid = barY + barH / 2;
    const clamp = (v: number) => Math.min(options.max, Math.max(options.min, v));
    const scale = linearScale(options.min, options.max === options.min ? options.min + 1 : options.max, PAD, W - PAD);
    const x = (v: number) => scale(clamp(v));
    const span = options.max - options.min || 1;
    const segs = options.bands
      .map((band) => {
        const tone = ZONE_TONES.has(band.tone) ? band.tone : "info";
        const optimal = band.from >= options.optimal.from && band.to <= options.optimal.to;
        return `<rect class="zonebar-seg zonebar-seg-${tone}${optimal ? " is-optimal" : ""}" x="${x(band.from)}" y="${barY}" width="${Math.max(1, x(band.to) - x(band.from))}" height="${barH}" rx="2"/>`;
      })
      .join("");
    const optLabel = `<text class="zonebar-optimal" x="${x((options.optimal.from + options.optimal.to) / 2)}" y="${barY + barH + 11}" text-anchor="middle">optimal</text>`;
    const { value, projected } = options;
    const proj =
      projected != null && value != null && Math.abs(projected - value) > span / 100
        ? `<line class="zonebar-pace" x1="${x(value)}" y1="${mid}" x2="${x(projected)}" y2="${mid}"/>
      <circle class="zonebar-ahead" cx="${x(projected)}" cy="${mid}" r="4"/>`
        : "";
    const now = value != null ? `<circle class="zonebar-now" cx="${x(value)}" cy="${mid}" r="4.5"/>` : "";
    return `<svg class="zonebar" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${escAttr(options.label)}">${segs}${optLabel}${proj}${now}</svg>`;
  }

  const CAIRN_UI_CHART = {
    linearScale,
    domain: chartDomain,
    dateLabel,
    sparkSvg,
    lineChartSvg,
    gaugeSvg,
    zoneBarSvg,
  };

  Object.assign(globalThis, { CairnUiChart: CAIRN_UI_CHART });
}
