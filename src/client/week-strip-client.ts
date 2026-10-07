// @ts-check
// The week strip, the view (docs/IA.md "Shared objects: Week"): the week as seven
// columns. The `shape` variant is Horizon's: each column a stone-coloured bar sized by
// the day's planned dose (the server's relative height, never a number), the lift's
// colour below the run's on a day that holds both; a done day solid and ticked, a key
// session still ahead hollow, planned work a past day did not get dashed, a rest day a
// low stub, today outlined in dawn. Each dated column is a real button whose label is
// the day in words with its dose WORD; tapping it peeks the day (the controller asks
// CairnDrill). A day with no date (a week in plan order) is a still picture.
//
// Deterministic strings over CairnWeekModel's columns: every word escaped, the bar's
// height a data-only custom property, no colour written here.
//
// LAZY ("calendar" bundle).
{
  type ShapeOpts = {
    /** The date whose peek is open (its button reads expanded). */
    selected?: string | null;
    /** The id of the region a column's peek opens into. */
    controls?: string;
    /** The list's accessible name. */
    label?: string;
  };

  function barHtml(day: ClientWeekShapeDay): string {
    const h = Math.round(day.height * 100) / 100;
    const segs = day.stones.length
      ? day.stones.map((stone) => `<span class="wkshape-seg stone-${stone}"></span>`).join("")
      : `<span class="wkshape-seg is-rest"></span>`;
    return `<span class="wkshape-well"><span class="wkshape-bar" style="--h:${escAttr(String(h))}">${segs}</span></span>`;
  }

  function cellHtml(day: ClientWeekShapeDay, opts: ShapeOpts): string {
    const cls = [
      "wkshape-day",
      day.today ? "is-today" : "",
      day.done ? "is-done" : "",
      day.rest ? "is-rest" : "",
      day.key_open ? "is-key" : "",
      day.missed ? "is-missed" : "",
      day.date ? "" : "is-static",
    ]
      .filter(Boolean)
      .join(" ");
    const tick = day.done ? `<span class="wkshape-tick">✓</span>` : "";
    const inner = `<span class="wkshape-dow">${escHtml(day.weekday)}</span>
      ${barHtml(day)}
      <span class="wkshape-num">${escHtml(day.num)}${tick}</span>
      <span class="wkshape-tag">${escHtml(day.tag)}</span>`;
    if (!day.date) {
      return `<li class="wkshape-cell"><div class="${cls}" role="img" aria-label="${escAttr(day.aria)}"><span class="wkshape-face" aria-hidden="true">${inner}</span></div></li>`;
    }
    const open = opts.selected === day.date;
    const controls = opts.controls ? ` aria-controls="${escAttr(opts.controls)}"` : "";
    return `<li class="wkshape-cell"><button type="button" class="${cls}" data-week-day="${escAttr(day.date)}" aria-expanded="${open ? "true" : "false"}"${controls} aria-label="${escAttr(day.aria)}"${day.today ? ` aria-current="date"` : ""}><span class="wkshape-face" aria-hidden="true">${inner}</span></button></li>`;
  }

  /** The week's shape: seven columns (fewer in plan order); "" with no days. */
  function shapeHtml(days: ReadonlyArray<ClientWeekShapeDay>, opts: ShapeOpts = {}): string {
    if (!days.length) return "";
    const label = opts.label || "This week's shape, day by day";
    return `<ol class="wkshape" aria-label="${escAttr(label)}">${days.map((d) => cellHtml(d, opts)).join("")}</ol>`;
  }

  const CAIRN_WEEK_STRIP = { shapeHtml };

  Object.assign(globalThis, { CairnWeekStrip: CAIRN_WEEK_STRIP });
}
