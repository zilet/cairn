// @ts-check
// "Since you started", the view (docs/IA.md "Horizon landing" 2): the proof band on
// Horizon's Week — at most three measured changes since the athlete started, each a
// hairline row of three columns: the stone dot and the measure's name (its "since" under
// it), a small picture, and the measure before → after with the after in the display face
// ("183 lb → 153.9 lb"; a single fact, such as a race run, prints its after alone).
//
// The picture is drawn from the server's `series` (oldest first, each 0..1 within the
// series' own span, a drawing aid only): a measured line with an end dot, a working
// load as steps, or weekly volume as columns with the last one in the deep hue. It is
// `aria-hidden`; the row's words are the accessible content. A row with a page is a
// real link carrying `data-horizon-href`. On a cold paint the picture draws in once
// (`enter`); nothing loops, and at rest it is complete.
//
// Deterministic strings over CairnWeekModel's proof rows: every word escaped, no colour
// written here (the hue is the row's `stone-<key>` class), no unit or date logic.
//
// LAZY ("horizon" bundle).
{
  /** The picture's drawing box: a viewBox the SVG stretches into (strokes do not scale). */
  const BOX = { W: 100, H: 28, P: 3 } as const;

  const r1 = (v: number): string => String(Math.round(v * 10) / 10);

  /** The series as viewBox points, oldest first: x evenly spaced, y up for a higher value. */
  function seriesPoints(series: ReadonlyArray<number>): Array<{ x: number; y: number }> {
    const n = series.length;
    const span = BOX.W - 2 * BOX.P;
    const rise = BOX.H - 2 * BOX.P;
    return series.map((v, i) => ({
      x: BOX.P + (n > 1 ? (i * span) / (n - 1) : span / 2),
      y: BOX.P + (1 - Math.max(0, Math.min(1, v))) * rise,
    }));
  }

  /**
   * The picture, drawn to scale within its own span: a line with an end dot, steps (each
   * value held until the next), or columns (the last in the deep hue). "" with fewer than
   * two values.
   */
  function seriesSvg(series: ReadonlyArray<number>, kind: ClientProofRow["kind"]): string {
    if (!Array.isArray(series) || series.length < 2) return "";
    let body = "";
    if (kind === "columns") {
      const n = series.length;
      const slot = (BOX.W - 2 * BOX.P) / n;
      const width = Math.max(1, slot - 2);
      const rise = BOX.H - 2 * BOX.P;
      body = series
        .map((v, i) => {
          const h = Math.max(1.5, Math.max(0, Math.min(1, v)) * rise);
          const cls = i === n - 1 ? "proof-col is-last" : "proof-col";
          return `<rect class="${cls}" x="${r1(BOX.P + i * slot + 1)}" y="${r1(BOX.H - BOX.P - h)}" width="${r1(width)}" height="${r1(h)}"/>`;
        })
        .join("");
    } else {
      const pts = seriesPoints(series);
      const d = pts
        .map((p, i) => {
          if (i === 0) return `M${r1(p.x)} ${r1(p.y)}`;
          return kind === "steps" ? `H${r1(p.x)}V${r1(p.y)}` : `L${r1(p.x)} ${r1(p.y)}`;
        })
        .join("");
      const end = pts[pts.length - 1];
      // The end dot is a zero-length round-capped stroke: it stays a circle however the box stretches.
      body = `<path class="proof-line" d="${d}"/><path class="proof-end" d="M${r1(end.x)} ${r1(end.y)}h0"/>`;
    }
    return `<svg class="proof-svg is-${kind === "columns" ? "columns" : kind === "steps" ? "steps" : "line"}" viewBox="0 0 ${BOX.W} ${BOX.H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  function rowHtml(row: ClientProofRow): string {
    const since = row.sinceWords ? `<small class="proof-since">${escHtml(row.sinceWords)}</small>` : "";
    const ba = row.before
      ? `${escHtml(row.before)}<span aria-hidden="true"> → </span><span class="sr-only"> to </span><b class="proof-after">${escHtml(row.after)}</b>`
      : `<b class="proof-after">${escHtml(row.after)}</b>`;
    const inner = `<span class="proof-name"><span class="proof-dot" aria-hidden="true"></span><span class="proof-label">${escHtml(row.label)}${since}</span></span>
      <span class="proof-pic">${seriesSvg(row.series, row.kind)}</span>
      <span class="proof-ba num">${ba}</span>${row.href ? `<span class="proof-chev" aria-hidden="true">›</span>` : ""}`;
    const body = row.href
      ? `<a class="proof-body proof-link" href="${escAttr(row.href)}" data-horizon-href>${inner}</a>`
      : `<div class="proof-body">${inner}</div>`;
    return `<li class="proof-row is-${escAttr(row.key)} stone-${escAttr(row.stone)}">${body}</li>`;
  }

  /** The band's rows; "" with none (the section is then left out). */
  function listHtml(rows: ReadonlyArray<ClientProofRow>, opts: { enter?: boolean } = {}): string {
    if (!rows.length) return "";
    return `<ul class="proof-band${opts.enter ? " is-drawing" : ""}" aria-label="Since you started">${rows.map(rowHtml).join("")}</ul>`;
  }

  const CAIRN_PROOF_BAND = { listHtml, rowHtml, seriesSvg, seriesPoints, BOX };

  Object.assign(globalThis, { CairnProofBand: CAIRN_PROOF_BAND });
}
