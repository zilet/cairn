// @ts-check
// The Program look-ahead, the model: GET /api/plan/look-ahead shaped into rows a day.
// Nothing here decides a day's lift, its run, whether it rests or how today stands:
// the read owns them, and today's lift is the server's one strength line, carried
// whole for the view to print verbatim. A day's lift and run words are the day's
// GLANCE (CairnDayDetailModel, the "calendar" bundle train depends on), the same words
// Today's strip and Horizon's week say for that day.
{
  type LookAhead = import("../contracts/client-api.js").ClientPlanLookAhead;
  type LookAheadDay = import("../contracts/client-api.js").ClientPlanLookAheadDay;
  type LookAheadLift = import("../contracts/client-api.js").ClientPlanLookAheadLift;
  type StrengthLine = import("../contracts/client-api.js").ClientTodayStrengthLine;

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function list<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  /** "Squat · Bench · Row" with "+2" when the day holds more. */
  function liftsText(lift: LookAheadLift | null | undefined): string {
    const names = list<unknown>(lift?.lifts).map(text).filter(Boolean);
    const more = Number(lift?.more) > 0 ? Math.round(Number(lift?.more)) : 0;
    if (!names.length) return "";
    return more ? `${names.join(" · ")} +${more}` : names.join(" · ");
  }

  function dayNumber(date: string): string {
    const n = Number(String(date).slice(8, 10));
    return Number.isFinite(n) && n > 0 ? String(n) : "";
  }

  function rowOf(day: LookAheadDay, todayLine: StrengthLine | null, units: unknown): ClientProgramWeekRow | null {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || "")) ? String(day.date) : "";
    if (!date) return null;
    const today = day.today === true;
    // Today's lift speaks the server's one line when it has something to say ("none" is
    // its own silence, and then the row keeps the plan day's name).
    const line =
      today &&
      todayLine &&
      text(todayLine.text) &&
      todayLine.state !== "none" &&
      (!todayLine.date || todayLine.date === date)
        ? todayLine
        : null;
    const lift = day.lift && text(day.lift.title) ? day.lift : null;
    const glance = CairnDayDetailModel.glanceOfLookAheadDay(day, units);
    if (!glance) return null;
    const run = day.run && glance.run ? { text: glance.run.words, done: day.run.done === true, kind: text(day.run.kind) } : null;
    return {
      glance,
      date,
      weekday: text(day.weekday).slice(0, 3).toUpperCase(),
      day: dayNumber(date),
      today,
      hard: day.hard === true,
      line,
      lift: lift
        ? {
            title: text(lift.title),
            // A reshaped today names its own movements on the line; the plan's list would contradict it.
            lifts: line?.reshaped ? "" : liftsText(lift),
            done: lift.done === true,
          }
        : null,
      run,
      rest: !lift && !line && !run,
    };
  }

  /**
   * The look-ahead in rows. Null when the read failed (the view says so in one calm
   * line); `mode: "empty"` when nothing is planned yet.
   */
  function programWeekModel(value: unknown): ClientProgramWeekView | null {
    const read = record(value) as LookAhead | null;
    if (!read || typeof read.mode !== "string") return null;
    const units = read.run_units === "mi" ? "mi" : "km";
    const todayLine = (record(read.strength_line) as StrengthLine | null) ?? null;
    if (read.mode === "order") {
      const order = list<LookAheadLift>(read.order)
        .filter((lift) => text(lift?.title))
        .map((lift) => ({ title: text(lift.title), lifts: liftsText(lift) }));
      return order.length ? { mode: "order", groups: [], order } : { mode: "empty", groups: [], order: [] };
    }
    const groups: ClientProgramWeekGroup[] = list<LookAhead["weeks"][number]>(read.weeks)
      .map((week) => ({
        label: text(week?.label) || "This week",
        markers: list<LookAhead["weeks"][number]["markers"][number]>(week?.markers)
          .filter((m) => text(m?.word))
          .map((m) => ({ kind: text(m.kind), word: text(m.word), note: text(m.note) })),
        rows: list<LookAheadDay>(week?.days)
          .map((day) => rowOf(day, todayLine, units))
          .filter((row): row is ClientProgramWeekRow => !!row),
      }))
      .filter((group) => group.rows.length);
    if (read.mode !== "calendar" || !groups.length) return { mode: "empty", groups: [], order: [] };
    return { mode: "calendar", groups, order: [] };
  }

  const CAIRN_PROGRAM_WEEK_MODEL = { programWeekModel, liftsText };

  Object.assign(globalThis, { CairnProgramWeekModel: CAIRN_PROGRAM_WEEK_MODEL });
}
