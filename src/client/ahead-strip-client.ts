// @ts-check
// "Ahead", the view (docs/IA.md "Horizon landing" 5): what is coming, as ONE honest strip
// and a row per mark, replacing the journey trail and "Next up" on Horizon's Week.
//
// The strip is a time axis with today at its left edge (a dawn tick). The next four weeks
// take the first half of the width; the second half runs from day 28 to the furthest mark,
// with a visible break glyph at the midpoint and mono labels "Next four weeks" and "then
// to <Mon>". When everything lies within four weeks it is one linear four-week axis, no
// break. Each mark is a dot in its stone's hue; a window (a peak week, a checkup week) is a
// short bar from its start to its end. No invented height, no pulsing dot: position is the
// only thing the strip encodes. `aheadPosition`/`aheadLayout` are the pure geometry the
// tests read (the repo does this for `terrainLayout`).
//
// Under it every mark is a milestone row (CairnMilestoneRow, the Season's own row): a real
// link with a chevron when the mark has a page, plain when not. Five show; more than five
// adds "+N more ›", which opens the Season. Nothing is dropped silently.
//
// Deterministic strings over CairnWeekModel's ahead marks: every word escaped, positions are
// data-only custom properties, no colour written here (the hue is the `stone-<key>` class).
//
// LAZY ("horizon" bundle).
{
  /** The near half of the axis: the next four weeks. */
  const NEAR_DAYS = 28;
  /** Rows shown before "+N more ›". */
  const ROWS_MAX = 5;

  /**
   * Where a day sits on the strip, 0..1 of its width. With the furthest mark beyond four
   * weeks the axis is broken: days 0–28 fill the first half, day 28 to the furthest the
   * second. Otherwise it is one linear four-week axis.
   */
  function aheadPosition(days: number, furthest: number): number {
    const d = Math.max(0, Number(days) || 0);
    const far = Math.max(0, Number(furthest) || 0);
    if (far <= NEAR_DAYS) return Math.min(1, d / NEAR_DAYS);
    if (d <= NEAR_DAYS) return (d / NEAR_DAYS) * 0.5;
    return Math.min(1, 0.5 + ((d - NEAR_DAYS) / (far - NEAR_DAYS)) * 0.5);
  }

  /** Every mark placed: a dot at `x`, a window as a bar from `x` to `x2`; whether the axis breaks. */
  function aheadLayout(marks: ReadonlyArray<ClientAheadMark>): ClientAheadLayout {
    const furthest = marks.reduce((far, m) => Math.max(far, m.end_days ?? m.days), 0);
    return {
      broken: furthest > NEAR_DAYS,
      furthest,
      items: marks.map((m) => ({
        kind: m.kind,
        stone: m.stone,
        x: aheadPosition(m.days, furthest),
        x2: m.end_days != null ? aheadPosition(m.end_days, furthest) : null,
      })),
    };
  }

  const pct = (v: number): string => escAttr(String(Math.round(v * 1000) / 10));

  /** The strip alone; "" with no marks. `to` names the month of the furthest mark ("May"). */
  function stripHtml(marks: ReadonlyArray<ClientAheadMark>, opts: { to?: string } = {}): string {
    if (!marks.length) return "";
    const layout = aheadLayout(marks);
    const dots = layout.items
      .map((it) => {
        const cls = `ahead-mark stone-${escAttr(it.stone)} is-kind-${escAttr(it.kind)}`;
        if (it.x2 != null && it.x2 > it.x) {
          return `<span class="${cls} is-window" style="--x:${pct(it.x)};--x2:${pct(it.x2)}"></span>`;
        }
        return `<span class="${cls}" style="--x:${pct(it.x)}"></span>`;
      })
      .join("");
    const said = marks.map((m) => [m.label, m.days_words || m.when].filter(Boolean).join(" ")).join("; ");
    const far = layout.broken
      ? `<span class="ahead-lab is-far" aria-hidden="true">${escHtml(opts.to ? `then to ${opts.to}` : "then on")}</span>`
      : "";
    return `<div class="ahead-strip${layout.broken ? " is-broken" : ""}" role="img" aria-label="${escAttr(`Ahead: ${said}`)}">
      <span class="ahead-lab is-near" aria-hidden="true">Next four weeks</span>${far}
      <span class="ahead-axis" aria-hidden="true"></span>
      ${layout.broken ? `<span class="ahead-break" aria-hidden="true"></span>` : ""}
      <span class="ahead-today" aria-hidden="true"></span>
      <span class="ahead-marks" aria-hidden="true">${dots}</span>
    </div>`;
  }

  /** Every mark as a milestone row (five shown, then "+N more ›" to the Season). */
  function rowsHtml(marks: ReadonlyArray<ClientAheadMark>, opts: { seasonHref?: string } = {}): string {
    if (!marks.length || typeof CairnMilestoneRow === "undefined") return "";
    const shown = marks.slice(0, ROWS_MAX);
    const rows = shown.map(
      (m): ClientMilestoneRow => ({
        kind: m.kind,
        stone: m.stone,
        mark: CairnMilestoneRowModel.KINDS[m.kind]?.mark || "dot",
        side: "ahead",
        when: m.when,
        label: m.label,
        detail: m.detail,
      })
    );
    const list = CairnMilestoneRow.listHtml(rows, {
      label: "Ahead",
      go: (_row, i) => {
        const href = shown[i]?.href;
        return href ? { href, action: "horizon-href", key: href } : null;
      },
    });
    const more = marks.length - shown.length;
    const link =
      more > 0
        ? `<a class="linkbtn linkbtn-plain hwk-season" href="${escAttr(opts.seasonHref || "#")}" data-hwk-season>${escHtml(`+${more} more ›`)}</a>`
        : "";
    return `${list}${link}`;
  }

  /** The Ahead body: the strip, then its rows; "" with no marks. */
  function aheadHtml(marks: ReadonlyArray<ClientAheadMark>, opts: { to?: string; seasonHref?: string } = {}): string {
    if (!marks.length) return "";
    return `<div class="ahead">${stripHtml(marks, opts)}${rowsHtml(marks, opts)}</div>`;
  }

  const CAIRN_AHEAD_STRIP = { aheadPosition, aheadLayout, stripHtml, rowsHtml, aheadHtml, NEAR_DAYS, ROWS_MAX };

  Object.assign(globalThis, { CairnAheadStrip: CAIRN_AHEAD_STRIP });
}
