// @ts-check
// Today's "What's ahead" strip, the view: a GLANCE at the week, right under the
// Brief's state line (docs/IA.md decision 3). A mast (a running recovery week named on
// its right), then the seven days of this week — each the day view's CHIP
// (day-detail-client.ts, over the day's glance, so its lift and run read as Program and
// Horizon say them) — and a fold that a tapped day's PEEK opens into (CairnDrill, the
// lazy "calendar" bundle). No summary line: the week's sentence and counts are
// Horizon's (one home per fact), and the stage word rides Today's glance line. Today's
// strength line is the Brief's to say; the strip only adds "Pull in place of Push" when
// today adapted. Pure string builders; every server string is escaped, no colour here.
//
// LAZY (today-ahead bundle). Mounted by today-strip-controller.ts.
{
  type PlanWeek = import("../contracts/client-api.js").ClientPlanWeek;
  /** What the strip's header notes (filled by its mount): a running recovery week, else nothing. */
  type StripHeader = { block?: string };

  type Cell = ClientDayGlance;

  /** A plan day's name short enough for a seventh of a phone (the day glance's own). */
  function abbr(name: string): string {
    return CairnDayDetailModel.abbr(name);
  }

  /**
   * The week's seven dated days as their glances (CairnDayDetailModel, the "calendar"
   * bundle today-ahead depends on), or null outside calendar mode (no strip then).
   */
  function cellsOf(week: PlanWeek | null | undefined, today: string): Cell[] | null {
    const days = Array.isArray(week?.days) ? week!.days : [];
    const units = week?.run_units === "mi" ? "mi" : "km";
    const cells = days
      .map((d) => CairnDayDetailModel.glanceOfWeekDay(d, today, units))
      .filter((c): c is Cell => !!c);
    return cells.length === 7 ? cells : null;
  }

  /** The seven days: the day view's CHIP variant, one per day. */
  function daysHtml(cells: Cell[], selected: string | null): string {
    return cells.map((c) => CairnDayDetailView.chipHtml(c, { selected, controls: "tstripFold" })).join("");
  }

  /**
   * Today's adaptation, said quietly: "Pull in place of Push" when today's selection
   * adapted to another plan day. The strength line itself is the Brief's (said once,
   * right above the strip), so it is never repeated here.
   */
  function nowHtml(_week: PlanWeek | null | undefined, cells: Cell[]): string {
    const today = cells.find((c) => c.today);
    return today?.swappedFrom && today.lift && today.swappedFrom !== today.lift.name
      ? `<div class="tstrip-now"><span class="tstrip-swap">${escHtml(`${today.lift.name} in place of ${today.swappedFrom}`)}</span></div>`
      : "";
  }

  /**
   * The whole strip: mast (with its note), the seven days, today's adaptation, and
   * the (closed) fold its day opens into. "" outside
   * calendar mode, so the slot collapses. `data-wired` marks a control a lazy
   * controller wires: a first-paint snapshot of Today freezes it (main shell).
   */
  function stripHtml(
    week: PlanWeek | null | undefined,
    today: string,
    selected: string | null = null,
    header: StripHeader = {}
  ): string {
    const cells = cellsOf(week, today);
    if (!cells) return "";
    return `<section class="tstrip" aria-labelledby="tstripTitle" data-wired>
      <div class="tstrip-mast"><h2 class="lbl tstrip-title" id="tstripTitle">What's ahead</h2><span class="lbl tstrip-block" data-tstrip-block>${escHtml(header.block || "")}</span></div>
      <ol class="tstrip-days" data-tstrip-days aria-label="This week, Monday to Sunday">${daysHtml(cells, selected)}</ol>
      <div data-tstrip-now>${nowHtml(week, cells)}</div>
      <div class="tstrip-fold" id="tstripFold" data-tstrip-fold role="region" aria-label="The day opened" inert>
        <div class="tstrip-fold-in">
          <div class="tstrip-detail" data-tstrip-detail></div>
        </div>
      </div>
    </section>`;
  }

  const CAIRN_TODAY_STRIP = { stripHtml, daysHtml, nowHtml, cellsOf, abbr };

  Object.assign(globalThis, { CairnTodayStrip: CAIRN_TODAY_STRIP });
}
