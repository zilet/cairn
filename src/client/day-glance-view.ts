// @ts-check
// The day view's glance variants: `chipHtml` (a day in Today's week strip) and `rowHtml`
// (a day in Program's week list), published as CairnDayGlanceView. They are the GLANCE
// half of the day view family: no body figure, no run structure, no page, so Today's
// strip pays for this and nothing else (the "glance" bundle, with the glance model).
// Pure string builders over a ClientDayGlance; every caller string goes through
// escHtml/escAttr.
{
  // ---- the glance variants: chip and row ----

  /**
   * One day as a chip of a week strip (Today's "What's ahead"): a real button with the
   * weekday, the date, the lift's short name in the strength hue and the run as a bar in
   * the endurance hue (longer for the long run, hatched for quality work), ticked once
   * done, today ringed. `data-tstrip-day` is what the strip's controller wires.
   */
  function chipHtml(g: ClientDayGlance, opts: { selected?: string | null; controls?: string } = {}): string {
    const open = opts.selected === g.date;
    const cls = [
      "tstrip-day",
      g.today ? "is-today" : "",
      g.past ? "is-past" : "",
      g.done ? "is-done" : "",
      g.rest ? "is-rest" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lift = g.lift ? `<span class="tstrip-lift is-${g.lift.state}">${escHtml(g.lift.abbr)}</span>` : "";
    const run = g.run ? `<span class="tstrip-run is-${g.run.state} is-${escAttr(g.run.kind)}"></span>` : "";
    const marks = lift || run ? `${lift}${run}` : `<span class="tstrip-rest">·</span>`;
    const tick = g.done ? `<span class="tstrip-tick">✓</span>` : "";
    const controls = opts.controls ? ` aria-controls="${escAttr(opts.controls)}"` : "";
    return `<li class="tstrip-cell"><button type="button" class="${cls}" data-tstrip-day="${escAttr(g.date)}" aria-expanded="${open ? "true" : "false"}"${controls} aria-label="${escAttr(g.aria)}"${g.today ? ` aria-current="date"` : ""}>
      <span class="tstrip-dow" aria-hidden="true">${escHtml(g.weekday)}</span>
      <span class="tstrip-num" aria-hidden="true">${escHtml(g.num)}${tick}</span>
      <span class="tstrip-marks" aria-hidden="true">${marks}</span>
    </button></li>`;
  }

  type RowOpts = {
    /** Today's lift: the server's one strength line, printed verbatim (never rebuilt). */
    line?: import("../contracts/client-api.js").ClientTodayStrengthLine | null;
    /** The day's first movements ("Squat · Bench +2"). */
    lifts?: string;
    /** The read's "harder day" flag. */
    hard?: boolean;
  };

  /**
   * One day as a row of a week list (Program's week ahead): the weekday and date, the
   * lift and the run in the glance's words with a tick when done, and the way into the
   * day's page (`data-open-day`, the drill controller's).
   */
  function rowHtml(g: ClientDayGlance, opts: RowOpts = {}): string {
    let lift = "";
    const lifts = opts.lifts ? `<span class="pahead-lifts">${escHtml(opts.lifts)}</span>` : "";
    if (opts.line) {
      const said =
        (typeof CairnUiReads !== "undefined" ? CairnUiReads.strengthLineHtml(opts.line, { compact: true }) : "") ||
        `<span class="pahead-lift-t">${escHtml(String(opts.line.text || ""))}</span>`;
      const caveat = String(opts.line.caveat || "").trim();
      lift = `<span class="pahead-item is-strength">${said}${caveat ? `<span class="pahead-caveat">${escHtml(caveat)}</span>` : ""}${lifts}</span>`;
    } else if (g.lift) {
      const tick = g.lift.state === "done" ? `<span class="pahead-tick" aria-label="done">✓</span>` : "";
      lift = `<span class="pahead-item is-strength"><span class="pahead-lift-t">${escHtml(g.lift.words)}${tick}</span>${lifts}</span>`;
    }
    const run = g.run
      ? `<span class="pahead-item is-endurance"><span class="pahead-run-t">${escHtml(g.run.words)}${g.run.state === "done" ? `<span class="pahead-tick" aria-label="done">✓</span>` : ""}</span></span>`
      : "";
    const rest = !lift && !run;
    const body = rest ? `<span class="pahead-rest">Rest</span>` : `<span class="pahead-what">${lift}${run}</span>`;
    const hard = opts.hard && !rest ? `<span class="pahead-hard">A harder day</span>` : "";
    const cls = `pahead-day${g.today ? " is-today" : ""}${rest ? " is-rest" : ""}${opts.hard ? " is-hard" : ""}`;
    return `<li class="${cls}" data-open-day="${escAttr(g.date)}" role="link" tabindex="0"${g.today ? ` aria-current="date"` : ""}>
      <span class="pahead-when">${escHtml(g.weekday.toUpperCase())}<b>${escHtml(g.num)}</b>${g.today ? `<span class="sr-only">, today</span>` : ""}</span>
      <span class="pahead-main">${body}${hard}</span>
      <span class="pahead-go" aria-hidden="true">›</span>
    </li>`;
  }

  const CAIRN_DAY_GLANCE_VIEW = { chipHtml, rowHtml };

  Object.assign(globalThis, { CairnDayGlanceView: CAIRN_DAY_GLANCE_VIEW });
}
