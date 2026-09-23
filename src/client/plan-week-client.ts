// @ts-check
// Shared Plan-tab week strip — Strength + Endurance both mount the same connected week.

type PlanWeek = import("../contracts/client.js").ClientPlanWeek;
type PlanWeekDay = import("../contracts/client.js").ClientPlanWeekDay;
type PlanWeekStatus = import("../contracts/client.js").ClientPlanWeekStatus;
type PlanWeekRole = import("../contracts/client.js").ClientPlanWeekRole;

(() => {
  const STATUS_LABEL: Record<PlanWeekStatus, string> = {
    done: "Done",
    today: "Today",
    upcoming: "Up next",
    rest: "Rest",
    open: "Open",
  };

  function planWeekRecord(value: unknown): Partial<PlanWeek> & Record<string, unknown> {
    return value && typeof value === "object" ? (value as Partial<PlanWeek> & Record<string, unknown>) : {};
  }

  function planWeekDays(value: unknown): PlanWeekDay[] {
    const read = planWeekRecord(value);
    return Array.isArray(read.days) ? (read.days as PlanWeekDay[]) : [];
  }

  function roleGlyph(role: PlanWeekRole | null | undefined, run: unknown): string {
    if (run) {
      if (role === "strength") return "✦";
      return "➜";
    }
    if (role === "strength") return "◆";
    if (role === "endurance") return "➜";
    if (role === "rest") return "○";
    return "·";
  }

  function roleClass(role: PlanWeekRole | null | undefined, run: unknown): string {
    if (run && role === "strength") return "mixed";
    if (run) return "run";
    if (role === "strength") return "lift";
    if (role === "endurance") return "run";
    if (role === "rest") return "rest";
    return "empty";
  }

  const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function shortWeekdayOf(dateISO: string): string {
    const d = new Date(`${String(dateISO).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? "" : SHORT_WEEKDAYS[d.getUTCDay()];
  }

  function runLabel(run: NonNullable<PlanWeekDay["run"]>, onDate?: string | null): string {
    const km = run.km != null && Number.isFinite(Number(run.km)) ? Number(run.km) : null;
    const kmText = km == null ? "" : ` ${Number.isInteger(km) ? km : km.toFixed(1)} km`;
    const base = `${String(run.label || `${run.kind} run`)}${kmText}`;
    // A completed run carried onto a LATER template cell: say where it actually landed.
    if (run.status === "completed" && run.completion_date && onDate && run.completion_date !== onDate) {
      const when = shortWeekdayOf(String(run.completion_date));
      return when ? `${base} · done ${when}` : `${base} · done`;
    }
    return base;
  }

  // A run beside a lift, short enough for a 7-up cell — the today line's own words:
  // "Pull · run in" once it happened, "Upper Body & Arms + easy run" while it's ahead.
  function withRun(lift: string, run: NonNullable<PlanWeekDay["run"]>): string {
    if (run.status === "completed") return `${lift} · run in`;
    return `${lift} + ${String(run.label || `${run.kind} run`).toLowerCase()}`;
  }

  // What the cell SAYS: the plan day's short NAME — the label everywhere; the focus
  // line is a sentence and belongs on the gallery card, not in a 7-up strip. A logged
  // session the plan cannot place keeps its own title. A lift day that also holds a
  // run names BOTH ("Upper Body & Arms + easy run") — the run never hides the lift. A
  // run on a run/rest day is the cell's work, so it leads there.
  function cellLabel(day: PlanWeekDay): string {
    const liftDay = day.plan_day?.role === "strength";
    const name = day.plan_day?.name ? String(day.plan_day.name) : "";
    const lift = day.session ? name || String(day.session.title || "") : liftDay ? name : "";
    if (lift && day.run) return withRun(lift, day.run);
    if (lift) return lift;
    if (day.run) return runLabel(day.run, day.date);
    if (name) return name;
    if (day.status === "rest") return "Rest";
    return "—";
  }

  // `withWeekday` false in the strip cell, whose header already says the weekday.
  function statusLine(day: PlanWeekDay, withWeekday = true): string {
    const status = day.status;
    const weekday = withWeekday && day.weekday ? String(day.weekday) : "";
    // The run this cell was for already happened elsewhere this week.
    if (
      status === "open" &&
      day.run?.status === "completed" &&
      day.run.completion_date &&
      day.run.completion_date !== day.date
    ) {
      return weekday ? `${weekday} · Covered` : "Covered";
    }
    if (status === "done") return weekday ? `Done · ${weekday}` : "Done";
    // Today's cell holding logged work not yet finished says so — the today line's own
    // "in progress", never a bare "Today" that reads as not started.
    if (status === "today" && day.session) return weekday ? `In progress · ${weekday}` : "In progress";
    if (status === "today") return weekday ? `Today · ${weekday}` : "Today";
    if (status === "upcoming") return weekday ? `${weekday} · Up next` : "Up next";
    if (status === "rest") return weekday ? `${weekday} · Rest` : "Rest";
    if (status === "open") return weekday || "Open";
    return weekday || STATUS_LABEL[status] || "";
  }

  // Mobile tap-for-detail: which cell's detail shows, per week. Absent means the
  // default (today, else the next upcoming day, template mode day 1). Module-level so
  // a soft re-render of the same week keeps the athlete's pick.
  const selectedByWeek = new Map<string, number>();

  function weekKey(read: Record<string, unknown>, calendar: boolean): string {
    const start = typeof read.week_start === "string" ? read.week_start : "";
    return calendar ? start || String(read.as_of ?? "") || "calendar" : "template";
  }

  function defaultIndex(days: PlanWeekDay[], calendar: boolean): number {
    if (!calendar) return 0;
    const today = days.findIndex((d) => d.status === "today");
    if (today >= 0) return today;
    const next = days.findIndex((d) => d.status === "upcoming");
    return next >= 0 ? next : 0;
  }

  function selectedIndex(key: string, days: PlanWeekDay[], calendar: boolean): number {
    const picked = selectedByWeek.get(key);
    return picked != null && picked >= 0 && picked < days.length ? picked : defaultIndex(days, calendar);
  }

  function dayKey(day: PlanWeekDay): string {
    const dayNumber = day.plan_day?.day_number;
    return String(day.weekday || (dayNumber != null ? `Day ${dayNumber}` : "·"));
  }

  // The mobile token's glyph: a done day is a check, anything else keeps its role mark.
  function tokenGlyph(day: PlanWeekDay): string {
    if (day.status === "done") return "✓";
    return roleGlyph(day.plan_day?.role ?? null, day.run);
  }

  // Only the FIRST upcoming cell is "Up next"; the rest of the week is simply later,
  // and a strip of five "Up next" labels said nothing.
  function cellStatus(day: PlanWeekDay, index: number, days: PlanWeekDay[]): string {
    const firstUpcoming = days.findIndex((d) => d.status === "upcoming");
    return day.status === "upcoming" && index !== firstUpcoming ? "" : statusLine(day, false);
  }

  // One cell is one real button. Wide screens lay it out as the labeled grid cell
  // (weekday, glyph, label, status); narrow ones as a weekday over a round token, with
  // the words moving to the one detail line below the strip.
  function cellHtml(day: PlanWeekDay, index: number, days: PlanWeekDay[], selected: number): string {
    const role = day.plan_day?.role ?? null;
    const kind = roleClass(role, day.run);
    const label = cellLabel(day);
    const status = cellStatus(day, index, days);
    const dayNumber = day.plan_day?.day_number;
    const on = index === selected;
    const aria = [dayKey(day), label, (status || (day.status === "upcoming" ? "later this week" : "")).toLowerCase()]
      .filter((part) => part && part !== "—")
      .join(", ");
    return `<button type="button" class="pweek-day pweek-${escAttr(kind)}${day.hard ? " is-hard" : ""}${day.status === "today" ? " is-today" : ""}${day.status === "done" ? " is-done" : ""}${day.status === "rest" ? " is-rest" : ""}${on ? " is-selected" : ""}" style="${stagger(index)}" data-pweek-i="${escAttr(index)}"${dayNumber != null ? ` data-pweek-day="${escAttr(dayNumber)}"` : ""} aria-pressed="${on ? "true" : "false"}" aria-label="${escAttr(aria)}">
      <span class="pweek-day-k">${escHtml(dayKey(day))}</span>
      <span class="pweek-glyph" aria-hidden="true">${roleGlyph(role, day.run)}</span>
      <span class="pweek-token" aria-hidden="true">${tokenGlyph(day)}</span>
      <span class="pweek-under" aria-hidden="true"></span>
      <span class="pweek-day-v">${escHtml(label)}</span>
      ${status ? `<span class="pweek-status lbl">${escHtml(status)}</span>` : ""}
    </button>`;
  }

  // The selected day's detail — the one place its words live on a narrow screen.
  // Today's panel speaks the server's today line verbatim (the same strengthLineHtml
  // the Brief and Session use), never a state re-derived here; every other day reads
  // its cell label and status.
  function detailHtml(
    day: PlanWeekDay,
    index: number,
    days: PlanWeekDay[],
    selected: number,
    todayLine: string
  ): string {
    const isToday = day.status === "today";
    const kicker = isToday ? (day.weekday ? `Today · ${day.weekday}` : "Today") : dayKey(day);
    const status = cellStatus(day, index, days) || (day.status === "upcoming" ? "Planned" : "");
    const body =
      isToday && todayLine
        ? todayLine
        : `<span class="pweek-detail-name">${escHtml(cellLabel(day))}</span>${status ? `<span class="pweek-detail-status">${escHtml(status)}</span>` : ""}`;
    return `<div class="pweek-detail" data-pweek-panel="${escAttr(index)}"${index === selected ? "" : " hidden"}>
      <span class="pweek-detail-k lbl">${escHtml(kicker)}</span>${body}
    </div>`;
  }

  function stripHtml(value: unknown): string {
    const days = planWeekDays(value);
    if (!days.length) return "";
    const read = planWeekRecord(value);
    const layout =
      read.layout && typeof read.layout === "object"
        ? (read.layout as { clean?: boolean; suggestion?: string | null })
        : null;
    const suggestion = layout && layout.clean === false && layout.suggestion ? String(layout.suggestion) : "";
    const summary = typeof read.summary === "string" ? read.summary : "";
    const note = suggestion || summary;
    const progress =
      read.progress && typeof read.progress === "object" ? (read.progress as { line?: string | null }) : null;
    const progressLine = progress && typeof progress.line === "string" ? progress.line : "";
    const calendar = days.some((d) => d.weekday);
    // Today's lift in the server's one line — the same words the Brief and the Session
    // header print — so the strip and the day never disagree about today. Wide screens
    // print it under the grid; narrow ones print it in today's detail panel instead
    // (CSS shows one or the other), which already names the day, so no kicker there.
    const reads = (globalThis as { CairnUiReads?: { strengthLineHtml?: (line: unknown, o?: unknown) => string } })
      .CairnUiReads;
    const canRead = calendar && typeof reads?.strengthLineHtml === "function";
    const todayLine = canRead ? reads!.strengthLineHtml!(read.strength_line, { kicker: "Today" }) : "";
    const todayDetailLine = canRead ? reads!.strengthLineHtml!(read.strength_line) : "";
    const key = weekKey(read, calendar);
    const selected = selectedIndex(key, days, calendar);
    return `<div class="pweek reveal" style="${stagger(0)}" data-plan-week data-pweek-week="${escAttr(key)}" data-pweek-default="${escAttr(defaultIndex(days, calendar))}">
      <div class="pweek-h"><span class="lbl">${calendar ? "This week" : "Your week"}</span></div>
      <div class="pweek-map${calendar ? "" : " pweek-map-template"}">${days.map((day, index) => cellHtml(day, index, days, selected)).join("")}</div>
      <div class="pweek-details" aria-live="polite">${days.map((day, index) => detailHtml(day, index, days, selected, todayDetailLine)).join("")}</div>
      ${todayLine ? `<div class="pweek-today">${todayLine}</div>` : ""}
      ${progressLine ? `<div class="pweek-progress">${escHtml(progressLine)}</div>` : ""}
      ${note ? `<div class="pweek-note">${escHtml(note)}</div>` : ""}
    </div>`;
  }

  // Tap a token to read that day; tap the selected one again to return to the
  // default. Delegated from the document (the strip is re-painted into whichever slot
  // owns it, like coaching-focus-client's routing), and the swap happens in place: the
  // button states and which panel shows.
  function pickDay(root: Element, index: number): void {
    const key = root.getAttribute("data-pweek-week") || "";
    const fallback = Number(root.getAttribute("data-pweek-default")) || 0;
    const current = selectedByWeek.has(key) ? Number(selectedByWeek.get(key)) : fallback;
    const next = index === current ? fallback : index;
    if (next === fallback) selectedByWeek.delete(key);
    else selectedByWeek.set(key, next);
    root.querySelectorAll("[data-pweek-i]").forEach((btn) => {
      const on = Number(btn.getAttribute("data-pweek-i")) === next;
      btn.classList.toggle("is-selected", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    root.querySelectorAll("[data-pweek-panel]").forEach((panel) => {
      if (Number(panel.getAttribute("data-pweek-panel")) === next) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
  }

  // Below 720px the tap actually does something: it swaps which day's words show
  // in the one .pweek-detail line under the strip (CSS hides .pweek-token/-under/
  // -details at 720px+, and every cell already prints its own weekday/glyph/label/
  // status). At 720px+ nothing on screen would change, so the button must not
  // pretend to toggle — aria-pressed there would be lying about a state nothing
  // reflects.
  function isMobilePweekLayout(): boolean {
    try {
      return typeof matchMedia === "function" ? matchMedia("(max-width: 719px)").matches : true;
    } catch {
      return true;
    }
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const btn = target?.closest("[data-pweek-i]");
      const root = btn?.closest("[data-plan-week]");
      if (!btn || !root) return;
      if (!isMobilePweekLayout()) return;
      const index = Number(btn.getAttribute("data-pweek-i"));
      if (Number.isFinite(index)) pickDay(root, index);
    });
  }

  type PlanWeekAnnotation = { weekday: string | null; status: PlanWeekStatus; label?: string | null };

  /** day_number → { weekday, status, label? } from a week projection, for gallery annotations. */
  function annotationsByDayNumber(value: unknown): Map<number, PlanWeekAnnotation> {
    const map = new Map<number, PlanWeekAnnotation>();
    const days = planWeekDays(value);
    const firstUpcoming = days.find((d) => d.status === "upcoming") ?? null;
    for (const day of days) {
      const n = day.plan_day?.day_number;
      if (n == null || !Number.isFinite(Number(n))) continue;
      const key = Number(n);
      // A template run day whose calendar cell carries a run of another kind (the
      // engine's easy run on the "Long Run" day) says which run, not "Up next".
      // Same for the rest day the long run landed on: its card says the run, not "Rest".
      const runInstead =
        (day.plan_day?.role === "endurance" || day.plan_day?.role === "rest") && day.run && day.status !== "done"
          ? `${day.weekday ? `${day.weekday} · ` : ""}${runLabel(day.run)}`
          : null;
      // A done cell is keyed by the plan day the SESSION resolved to, so the gallery's
      // "Done · Mon" lands on the card that was actually trained. Prefer today/done
      // cells when a day repeats in a cycle.
      const prev = map.get(key);
      if (!prev || day.status === "today" || day.status === "done") {
        // Only the week's first upcoming day is "Up next"; later ones just name the weekday.
        const status = day.status === "upcoming" && day !== firstUpcoming ? "open" : day.status;
        map.set(key, { weekday: day.weekday ?? null, status, label: runInstead });
      }
    }
    return map;
  }

  const CAIRN_PLAN_WEEK = {
    stripHtml,
    annotationsByDayNumber,
    days: planWeekDays,
    statusLine,
    pickDay,
    isMobilePweekLayout,
  };

  Object.assign(globalThis, { CairnPlanWeek: CAIRN_PLAN_WEEK });
  if (typeof window !== "undefined") {
    window.CairnPlanWeek = CAIRN_PLAN_WEEK;
  }
})();
