// @ts-check
// Today's "What's ahead" strip, the view: Today's ONE week view, right under the
// Brief's state line. A mast (the block clock on its right), the week so far in one
// quiet header line ("2 of 5 lifting days · 6.1 of ~33 km · 3 new bests" — counts the
// server already made, GET /api/plan/week `progress`), then the seven days of this
// week — each a real button carrying the weekday, the date, the day's lift as a short
// name in the strength hue and its run as a bar in the endurance hue (longer for the
// long run, hatched for quality work), ticked once done, today ringed — and a fold that
// opens a tapped day inline into the shared day detail (day-detail-client.ts, lazy
// "day"). Today's strength line is the Brief's to say (one fact, said once); the strip
// only adds "Pull in place of Push" when today adapted. Pure string builders; every
// server string is escaped and no colour is written here.
//
// LAZY (today-ahead bundle). Mounted by today-strip-controller.ts.
{
  type PlanWeek = import("../contracts/client-api.js").ClientPlanWeek;
  type PlanWeekDay = import("../contracts/client-api.js").ClientPlanWeekDay;
  /** What the strip's header says beside the week's own counts (filled by its mount). */
  type StripHeader = {
    /** The block clock: "Sharpen · Wk 5 of 6", or a running recovery week. */
    block?: string;
    /** The week's run plan in km (Today's path read), for "6.1 of ~33 km". */
    kmPlanned?: number | null;
    /** The athlete's run units ("km" | "mi"). */
    units?: string;
  };

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  type Mark = "done" | "live" | "planned" | "open";
  type Cell = {
    date: string;
    dow: number;
    num: string;
    today: boolean;
    past: boolean;
    lift: { name: string; abbr: string; state: Mark } | null;
    run: { label: string; kind: string; km: number | null; state: Mark } | null;
    /** Today only: the plan day the selection adapted away from. */
    swappedFrom: string;
  };

  function dowOf(iso: string): number {
    const ms = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms).getUTCDay() : -1;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** A plan day's name short enough for a seventh of a phone: "Pull", "LB" (Lower B), "FB". */
  function abbr(name: string): string {
    const words = text(name).split(" ").filter(Boolean);
    if (!words.length) return "";
    if (words.length === 1) return words[0].length <= 5 ? words[0] : words[0].slice(0, 3);
    return words
      .slice(0, 3)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  function cellOf(day: PlanWeekDay, today: string): Cell | null {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || "")) ? String(day.date) : "";
    if (!date) return null;
    const isToday = date === today;
    const past = date < today;
    const plan = day.plan_day && day.plan_day.role === "strength" ? day.plan_day : null;
    const name = text(day.session?.title) || text(plan?.name);
    let lift: Cell["lift"] = null;
    if (name && (day.session || plan)) {
      const done = day.session?.finished === true || (day.status === "done" && !!day.session);
      const state: Mark = done ? "done" : isToday && day.session ? "live" : past ? "open" : "planned";
      lift = { name, abbr: abbr(name), state };
    }
    let run: Cell["run"] = null;
    if (day.run && !day.run.rested) {
      const km = Number(day.run.km);
      run = {
        label: text(day.run.label) || "Run",
        kind: text(day.run.kind),
        km: Number.isFinite(km) && km > 0 ? km : null,
        state: day.run.status === "completed" ? "done" : past ? "open" : "planned",
      };
    }
    return {
      date,
      dow: dowOf(date),
      num: String(Number(date.slice(8, 10))),
      today: isToday,
      past,
      lift,
      run,
      swappedFrom: isToday ? text(day.plan_day?.swapped_from?.name) : "",
    };
  }

  /** The week's seven dated days, or null outside calendar mode (no strip is drawn then). */
  function cellsOf(week: PlanWeek | null | undefined, today: string): Cell[] | null {
    const days = Array.isArray(week?.days) ? week!.days : [];
    const cells = days.map((d) => cellOf(d, today)).filter((c): c is Cell => !!c);
    return cells.length === 7 ? cells : null;
  }

  const STATE_WORD: Readonly<Record<Mark, string>> = {
    done: "done",
    live: "under way",
    planned: "planned",
    open: "left open",
  };

  function ariaOf(cell: Cell): string {
    const parts: string[] = [];
    if (cell.lift) parts.push(`${cell.lift.name}, ${STATE_WORD[cell.lift.state]}`);
    if (cell.run) parts.push(`${cell.run.label}, ${STATE_WORD[cell.run.state]}`);
    return `${DOW_NAME[cell.dow] || ""} ${cell.num}${cell.today ? ", today" : ""}: ${parts.length ? parts.join("; ") : "rest"}`;
  }

  function cellHtml(cell: Cell, selected: string | null): string {
    const open = selected === cell.date;
    const done =
      (!cell.lift || cell.lift.state === "done") &&
      (!cell.run || cell.run.state === "done") &&
      !!(cell.lift || cell.run);
    const cls = [
      "tstrip-day",
      cell.today ? "is-today" : "",
      cell.past ? "is-past" : "",
      done ? "is-done" : "",
      !cell.lift && !cell.run ? "is-rest" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lift = cell.lift ? `<span class="tstrip-lift is-${cell.lift.state}">${escHtml(cell.lift.abbr)}</span>` : "";
    const runKind = /^(easy|quality|long)$/.test(cell.run?.kind || "") ? cell.run!.kind : "easy";
    const run = cell.run ? `<span class="tstrip-run is-${cell.run.state} is-${runKind}"></span>` : "";
    const marks = lift || run ? `${lift}${run}` : `<span class="tstrip-rest">·</span>`;
    const tick = done ? `<span class="tstrip-tick">✓</span>` : "";
    return `<li class="tstrip-cell"><button type="button" class="${cls}" data-tstrip-day="${escAttr(cell.date)}" aria-expanded="${open ? "true" : "false"}" aria-controls="tstripFold" aria-label="${escAttr(ariaOf(cell))}"${cell.today ? ` aria-current="date"` : ""}>
      <span class="tstrip-dow" aria-hidden="true">${escHtml(DOW[cell.dow] || "")}</span>
      <span class="tstrip-num" aria-hidden="true">${escHtml(cell.num)}${tick}</span>
      <span class="tstrip-marks" aria-hidden="true">${marks}</span>
    </button></li>`;
  }

  function daysHtml(cells: Cell[], selected: string | null): string {
    return cells.map((c) => cellHtml(c, selected)).join("");
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
  function dist(km: number, units: string | undefined): string {
    if (!(km > 0)) return "";
    const r = Math.round((units === "mi" ? km / 1.609344 : km) * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }

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
    const unit = header.units === "mi" ? "mi" : "km";
    const ran = dist(Number(p.run_km) || 0, header.units);
    const plan = dist(Number(header.kmPlanned) || 0, header.units);
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
          <div class="tstrip-foot">
            <button type="button" class="linkbtn linkbtn-plain tstrip-horizon" data-tstrip-horizon>Open in Horizon ›</button>
            <button type="button" class="linkbtn-quiet tstrip-close" data-tstrip-close>Close</button>
          </div>
        </div>
      </div>
    </section>`;
  }

  const CAIRN_TODAY_STRIP = { stripHtml, daysHtml, nowHtml, tallyText, tallyHtml, cellsOf, abbr };

  Object.assign(globalThis, { CairnTodayStrip: CAIRN_TODAY_STRIP });
}
