// @ts-check
// Horizon's Week view, the model (wave 6B): this week, day by day, shaped from
// GET /api/plan/week, the plan strip's own read. Nothing here decides a day's status,
// a run's distance or the week's line; the read owns them. Words and kilometres only.
{
  type PlanWeek = import("../contracts/client-api.js").ClientPlanWeek;
  type PlanWeekDay = import("../contracts/client-api.js").ClientPlanWeekDay;
  type StrengthLine = import("../contracts/client-api.js").ClientTodayStrengthLine;

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dayKey(value: unknown): string {
    const key = String(value || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
  }

  /**
   * This week, day by day, off GET /api/plan/week (the plan strip's own read): each day's
   * lift and run as pills, done ones ticked, a run still to place drawn open, and a day
   * with neither is rest. Today's lift is the server's one today line (`strength_line`,
   * the words the Brief, Session and plan strip print), never a state read here off the
   * session. The week's spoken line is the server's. Null when the read failed; a read
   * with no days is an empty week (the view says so in one line).
   */
  /**
   * One plan-week day's run in words, in the athlete's run units: "Long run · 8.4 mi" —
   * the day's GLANCE words (CairnDayDetailModel.glance, the "calendar" bundle horizon
   * reaches through train), so Horizon's week, Today's strip and Program's week say one
   * run the same way. A run done or behind is named by its kind ("Easy run"); a run today
   * or ahead keeps the server's label. "" with no run.
   */
  function dayRunText(value: unknown, today: string, units?: unknown): string {
    const day = record(value) as PlanWeekDay | null;
    const run = day?.run;
    if (!run) return "";
    const date = dayKey(day?.date);
    const km = num(run.km);
    return (
      CairnDayDetailModel.glance({
        date,
        // A day with no date (a week in plan order) is never behind.
        today: date ? today : "",
        isToday: false,
        lift: null,
        run: { label: text(run.label), kind: text(run.kind), km: km != null && km > 0 ? km : null, done: run.status === "completed" },
        units: units ?? "km",
      }).run?.words || ""
    );
  }

  function weekView(value: unknown, today: string, units?: unknown): ClientHorizonWeek | null {
    const read = record(value) as PlanWeek | null;
    if (!read) return null;
    const days = Array.isArray(read.days) ? (read.days as PlanWeekDay[]) : [];
    // A read with no days is a week with nothing planned yet, not a failed read.
    if (!days.length) return { line: "", days: [] };
    const todayLine = record(read.strength_line) as StrengthLine | null;
    const out: ClientHorizonWeekDay[] = days.map((day, index) => {
      const date = dayKey(day.date);
      const isToday = day.status === "today" || (!!date && date === today);
      const pills: ClientHorizonWeekPill[] = [];
      const plan = day.plan_day;
      // Today's lift speaks the server's line when it has one for this day ("none" is
      // its own "nothing to say", and then the row falls back to the plan's pills).
      const lineDate = dayKey(todayLine?.date);
      const line =
        isToday && todayLine && text(todayLine.text) && todayLine.state !== "none" && (!lineDate || lineDate === date)
          ? todayLine
          : null;
      const lift = line ? "" : text(day.session?.title) || (plan && plan.role === "strength" ? text(plan.name) : "");
      if (lift) {
        const done = day.session?.finished === true || (day.status === "done" && !!day.session);
        pills.push({
          stone: "strength",
          text: lift,
          state: done ? "done" : isToday && day.session ? "live" : "planned",
        });
      }
      const run = day.run;
      if (run) {
        const past = !!date && !!today && date < today;
        pills.push({
          stone: "endurance",
          text: dayRunText(day, today, units),
          state: run.status === "completed" ? "done" : past ? "open" : "planned",
        });
      }
      const weekday = text(day.weekday) || (date ? CairnRaceViewModel.longDate(date).split(",")[0] : "");
      // Today's selection can adapt to another plan day than the weekday map's: the row
      // says, quietly, which day it stands in for ("In place of Lower B").
      const shown = line ? text(line.title) : lift;
      const from = isToday ? text(plan?.swapped_from?.name) : "";
      // A week in plan order (no lifting weekdays stated) has no dates: its rows count
      // "DAY 1, 2, 3" rather than standing unlabelled.
      return {
        date,
        weekday: weekday ? weekday.slice(0, 3).toUpperCase() : "DAY",
        day: date ? String(Number(date.slice(8, 10))) : String(index + 1),
        today: isToday,
        pills,
        line,
        rest: !pills.length && !line,
        done: pills.length > 0 && pills.every((p) => p.state === "done") && !line,
        swappedFrom: from && from !== shown ? from : "",
      };
    });
    const line = CairnRaceViewModel.runWords(text(read.progress?.line) || text(read.summary), units);
    return { line, days: out };
  }

  const CAIRN_HORIZON_WEEK_MODEL = { weekView, dayRunText };

  Object.assign(globalThis, { CairnHorizonWeekModel: CAIRN_HORIZON_WEEK_MODEL });
}
