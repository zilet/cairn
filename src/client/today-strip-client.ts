// @ts-check
// Today's "What's ahead" strip, the view: the seven days of this week right under the
// Brief's why — each a real button carrying the weekday, the date, the day's lift as a
// short name in the strength hue and its run as a bar in the endurance hue (longer for
// the long run, hatched for quality work), ticked once done, today ringed — with
// today's strength line (the server's words, verbatim) beneath, and a fold that opens
// a tapped day inline into the shared day detail (day-detail-client.ts, lazy "day").
// Pure string builders over GET /api/plan/week; every server string is escaped and no
// colour is written here.
//
// LAZY (today-ahead bundle). Mounted by today-strip-controller.ts.
{
  type PlanWeek = import("../contracts/client-api.js").ClientPlanWeek;
  type PlanWeekDay = import("../contracts/client-api.js").ClientPlanWeekDay;

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
   * Today's line: the server's strength line verbatim, and — when today's selection
   * adapted to another plan day — the plan day it stands in for, said quietly.
   */
  function nowHtml(week: PlanWeek | null | undefined, cells: Cell[]): string {
    const line = week?.strength_line;
    const today = cells.find((c) => c.today);
    const said =
      line && text(line.text) && line.state !== "none"
        ? typeof CairnUiReads !== "undefined"
          ? CairnUiReads.strengthLineHtml(line, { kicker: "Today", compact: true })
          : `<span class="lbl">Today</span> ${escHtml(text(line.text))}`
        : "";
    const swap =
      today?.swappedFrom && today.lift && today.swappedFrom !== today.lift.name
        ? `<span class="tstrip-swap">${escHtml(`${today.lift.name} in place of ${today.swappedFrom}`)}</span>`
        : "";
    return said || swap ? `<div class="tstrip-now">${said}${swap}</div>` : "";
  }

  /**
   * The whole strip: mast, the seven days, today's line, and the (closed) fold its day
   * opens into. "" outside calendar mode, so the slot collapses.
   */
  function stripHtml(week: PlanWeek | null | undefined, today: string, selected: string | null = null): string {
    const cells = cellsOf(week, today);
    if (!cells) return "";
    return `<section class="tstrip" aria-labelledby="tstripTitle">
      <div class="tstrip-mast"><h2 class="lbl tstrip-title" id="tstripTitle">What's ahead</h2></div>
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

  const CAIRN_TODAY_STRIP = { stripHtml, daysHtml, nowHtml, cellsOf, abbr };

  Object.assign(globalThis, { CairnTodayStrip: CAIRN_TODAY_STRIP });
}
