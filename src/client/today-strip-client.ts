// @ts-check
// Today's "What's ahead" strip, the view: Today's ONE week view, right under the
// Brief's state line. A mast (the block clock on its right), the week so far in one
// quiet header line ("2 of 5 lifting days · 6.1 of ~33 km · 3 new bests" — counts the
// server already made, GET /api/plan/week `progress`), then the seven days of this
// week — each the day view's CHIP (day-detail-client.ts, over the day's glance, so its
// lift and run read as Program and Horizon say them) — and a fold that a tapped day's
// PEEK opens into (CairnDrill, the lazy "calendar" bundle). Today's strength line is the Brief's to say (one fact, said once); the strip
// only adds "Pull in place of Push" when today adapted. Pure string builders; every
// server string is escaped and no colour is written here.
//
// LAZY (today-ahead bundle). Mounted by today-strip-controller.ts.
{
  type PlanWeek = import("../contracts/client-api.js").ClientPlanWeek;
  /** What the strip's header says beside the week's own counts (filled by its mount). */
  type StripHeader = {
    /** The block clock: "Sharpen · Wk 5 of 6", or a running recovery week. */
    block?: string;
    /** The week's run plan in km (Today's path read), for "6.1 of ~33 km". */
    kmPlanned?: number | null;
    /** The athlete's run units ("km" | "mi"). */
    units?: string;
  };

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

  function count(n: unknown): number {
    const v = Math.round(Number(n));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** A distance's number in the athlete's run units ("6.1"); "" for nothing. */
  const dist = (km: number, units: string | undefined): string => (km > 0 ? CairnFmt.distance(km, units ?? "km", true) : "");

  /**
   * The week so far in one header line, from the server's own counts: lifting days in
   * against the stated (or observed) lifting days, distance run against the week's run
   * plan, and new bests. Counts only — never a score, never a percentage; a part with
   * nothing to say is left out, and an empty week says nothing.
   */
  function tallyText(week: PlanWeek | null | undefined, header: StripHeader = {}): string {
    const p = week?.progress;
    if (!p || typeof p !== "object") return "";
    const parts: string[] = [];
    const done = count(p.lift_days_done);
    const planned = count(p.lift_days_planned);
    if (planned) parts.push(`${done} of ${planned} lifting day${planned === 1 ? "" : "s"}`);
    else if (done) parts.push(`${done} lifting session${done === 1 ? "" : "s"}`);
    // The week read's own run units win: the warm settings read is only a fallback, so
    // a cold settings cache never prints km to an imperial athlete.
    const units = week?.run_units || header.units;
    const unit = units === "mi" ? "mi" : "km";
    const ran = dist(Number(p.run_km) || 0, unit);
    const plan = dist(Number(header.kmPlanned) || 0, unit);
    const about = plan ? `~${Math.round(Number(plan))}` : "";
    if (ran && about) parts.push(`${ran} of ${about} ${unit}`);
    else if (ran) parts.push(`${ran} ${unit} run`);
    else if (about) parts.push(`${about} ${unit} planned`);
    const prs = count(p.prs);
    if (prs) parts.push(`${prs} new best${prs === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  function tallyHtml(week: PlanWeek | null | undefined, header: StripHeader = {}): string {
    const said = tallyText(week, header);
    return said ? `<p class="tstrip-tally">${escHtml(said)}</p>` : "";
  }

  /**
   * The whole strip: mast (with the block clock), the week's header line, the seven
   * days, today's adaptation, and the (closed) fold its day opens into. "" outside
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
      <div data-tstrip-tally>${tallyHtml(week, header)}</div>
      <ol class="tstrip-days" data-tstrip-days aria-label="This week, Monday to Sunday">${daysHtml(cells, selected)}</ol>
      <div data-tstrip-now>${nowHtml(week, cells)}</div>
      <div class="tstrip-fold" id="tstripFold" data-tstrip-fold role="region" aria-label="The day opened" inert>
        <div class="tstrip-fold-in">
          <div class="tstrip-detail" data-tstrip-detail></div>
        </div>
      </div>
    </section>`;
  }

  const CAIRN_TODAY_STRIP = { stripHtml, daysHtml, nowHtml, tallyText, tallyHtml, cellsOf, abbr };

  Object.assign(globalThis, { CairnTodayStrip: CAIRN_TODAY_STRIP });
}
