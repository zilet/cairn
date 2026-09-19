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

  // What the cell SAYS, in priority order: the session that was logged (its content-
  // true title), then a run dated on the cell, then the plan day's short NAME — the
  // focus line is a sentence and belongs on the gallery card, not in a 7-up strip.
  function cellLabel(day: PlanWeekDay): string {
    const session = day.session?.title ? String(day.session.title) : "";
    const run = day.run ? runLabel(day.run, day.date) : "";
    if (session && run) return `${session} · ${run}`;
    if (session) return session;
    if (run) return run;
    if (day.plan_day?.name) return String(day.plan_day.name);
    if (day.status === "rest") return "Rest";
    return "—";
  }

  function statusLine(day: PlanWeekDay): string {
    const status = day.status;
    const weekday = day.weekday ? String(day.weekday) : "";
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
    if (status === "today") return weekday ? `Today · ${weekday}` : "Today";
    if (status === "upcoming") return weekday ? `${weekday} · Up next` : "Up next";
    if (status === "rest") return weekday ? `${weekday} · Rest` : "Rest";
    if (status === "open") return weekday || "Open";
    return weekday || STATUS_LABEL[status] || "";
  }

  function cellHtml(day: PlanWeekDay, index: number): string {
    const role = day.plan_day?.role ?? null;
    const kind = roleClass(role, day.run);
    const label = cellLabel(day);
    const status = statusLine(day);
    const dayNumber = day.plan_day?.day_number;
    return `<div class="pweek-day pweek-${escAttr(kind)}${day.hard ? " is-hard" : ""}${day.status === "today" ? " is-today" : ""}${day.status === "done" ? " is-done" : ""}" style="${stagger(index)}"${dayNumber != null ? ` data-pweek-day="${escAttr(dayNumber)}"` : ""}>
      <span class="pweek-day-k">${escHtml(day.weekday || (dayNumber != null ? `Day ${dayNumber}` : "·"))}</span>
      <span class="pweek-glyph" aria-hidden="true">${roleGlyph(role, day.run)}</span>
      <span class="pweek-day-v">${escHtml(label)}</span>
      ${status ? `<span class="pweek-status lbl">${escHtml(status)}</span>` : ""}
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
    return `<div class="pweek reveal" style="${stagger(0)}" data-plan-week>
      <div class="pweek-h"><span class="lbl">${calendar ? "This week" : "Your week"}</span></div>
      <div class="pweek-map${calendar ? "" : " pweek-map-template"}">${days.map(cellHtml).join("")}</div>
      ${progressLine ? `<div class="pweek-progress">${escHtml(progressLine)}</div>` : ""}
      ${note ? `<div class="pweek-note">${escHtml(note)}</div>` : ""}
    </div>`;
  }

  type PlanWeekAnnotation = { weekday: string | null; status: PlanWeekStatus; label?: string | null };

  /** day_number → { weekday, status, label? } from a week projection, for gallery annotations. */
  function annotationsByDayNumber(value: unknown): Map<number, PlanWeekAnnotation> {
    const map = new Map<number, PlanWeekAnnotation>();
    for (const day of planWeekDays(value)) {
      const n = day.plan_day?.day_number;
      if (n == null || !Number.isFinite(Number(n))) continue;
      const key = Number(n);
      // A template run day whose calendar cell carries a run of another kind (the
      // engine's easy run on the "Long Run" day) says which run, not "Up next".
      const runInstead =
        day.plan_day?.role === "endurance" && day.run && day.status !== "done"
          ? `${day.weekday ? `${day.weekday} · ` : ""}${runLabel(day.run)}`
          : null;
      // A done cell is keyed by the plan day the SESSION resolved to, so the gallery's
      // "Done · Mon" lands on the card that was actually trained. Prefer today/done
      // cells when a day repeats in a cycle.
      const prev = map.get(key);
      if (!prev || day.status === "today" || day.status === "done") {
        map.set(key, { weekday: day.weekday ?? null, status: day.status, label: runInstead });
      }
    }
    return map;
  }

  const CAIRN_PLAN_WEEK = {
    stripHtml,
    annotationsByDayNumber,
    days: planWeekDays,
    statusLine,
  };

  Object.assign(globalThis, { CairnPlanWeek: CAIRN_PLAN_WEEK });
  if (typeof window !== "undefined") {
    window.CairnPlanWeek = CAIRN_PLAN_WEEK;
  }
})();
