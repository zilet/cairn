// @ts-check
// The week, the model (docs/IA.md "Shared objects: Week"): GET /api/week (WeekRead,
// src/contracts/week-read.ts) shaped for Horizon's Week page — the frame for the hero,
// the seven columns of the week's shape, the day-by-day glances, what is still open, the
// next milestones and the goals. Replaces horizon-week-model (the old GET /plan/week
// shaping).
//
// Pure: a DTO in, a view model out; never fetches, never touches the DOM or `state`.
// Every word is the server's, already in the athlete's units. A column's height is the
// server's relative dose (`load.height`), a drawing aid — the dose is said as its WORD,
// never a number. A day's status is the chip's own (`status`); nothing here compares
// dates to decide one.
//
// LAZY ("calendar" bundle).
{
  type WeekRead = import("../contracts/week-read.js").WeekRead;
  type DayChip = import("../contracts/week-read.js").DayChip;
  type WeekOpen = import("../contracts/week-read.js").WeekReadOpen;

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  /** "Still open" holds two lines at most (docs/IA.md "Horizon landing" 3). */
  const OPEN_MAX = 2;
  /** "Next up" holds three milestones at most. */
  const NEXT_MAX = 3;

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isoOf(value: unknown): string | null {
    const s = text(value);
    return ISO.test(s) ? s : null;
  }

  function list<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]).filter((v) => !!record(v)) : [];
  }

  /** A plan day's name short enough for a seventh of a phone, through the day view's own rule. */
  function tagOf(title: string): string {
    if (!title) return "";
    return typeof CairnDayDetailModel !== "undefined" ? CairnDayDetailModel.abbr(title) : title.slice(0, 5);
  }

  /** One column: the day's label, its bar's hues and height, and every word for its label. */
  function shapeDay(chip: DayChip, index: number): ClientWeekShapeDay {
    const date = isoOf(chip.date);
    const run = chip.run && !chip.run.rested && !chip.run.covered ? chip.run : null;
    const stones: Array<"strength" | "endurance"> = [];
    if (chip.lift) stones.push("strength");
    if (run) stones.push("endurance");
    const status = text(chip.status);
    const done = status === "done";
    const missed = status === "open";
    // A key session (the server's `hard`: a heavy-leg lift, a quality or long run) still
    // ahead this week is drawn hollow, so the week's big asks stand out before they land.
    const ahead = status === "upcoming" || (status === "today" && !(run && run.status === "completed" && !chip.lift));
    const load = record(chip.load);
    const height = Math.max(0, Math.min(1, Number(load?.height) || 0));
    const doseWord = text(load?.word);
    const words = text(chip.words) || (stones.length ? "" : "Rest");
    const when = text(chip.date_words) || `Day ${index + 1}`;
    const aria = [
      `${when}${chip.today ? ", today" : ""}: ${words}`,
      doseWord && text(load?.dose) !== "rest" ? `${doseWord} load` : "",
      done ? "done" : missed ? "still open" : "",
    ]
      .filter(Boolean)
      .join(". ");
    return {
      date,
      weekday: (text(chip.weekday) || "Day").slice(0, 3).toUpperCase(),
      num: date ? CairnFmt.date(date, { fmt: { day: "numeric" } }) : String(index + 1),
      tag: tagOf(text(chip.lift?.title)),
      today: chip.today === true,
      done,
      rest: !stones.length,
      key_open: chip.hard === true && ahead && stones.length > 0,
      missed,
      stones,
      height: stones.length ? height : Math.min(height, 0.08),
      dose_word: doseWord,
      aria,
    };
  }

  /** A dated chip as the day view's glance (the same words Program's week rows say). */
  function glanceOf(chip: DayChip, today: string, units: unknown): ClientDayGlance | null {
    const date = isoOf(chip.date);
    if (!date || typeof CairnDayDetailModel === "undefined") return null;
    const run = chip.run && !chip.run.rested ? chip.run : null;
    const km = Number(run?.km);
    return CairnDayDetailModel.glance({
      date,
      today,
      isToday: chip.today === true,
      lift: chip.lift ? { name: text(chip.lift.title), done: chip.status === "done", live: false } : null,
      run: run
        ? {
            label: text(run.label),
            kind: text(run.kind),
            km: Number.isFinite(km) && km > 0 ? km : null,
            done: run.status === "completed",
          }
        : null,
      units,
    });
  }

  function openRow(row: WeekOpen): ClientWeekOpenRow | null {
    const words = text(row.words);
    if (!words) return null;
    const kind = text(row.kind);
    return { kind, stone: kind === "lift" ? "strength" : "endurance", words, date: isoOf(row.date) };
  }

  /** The journey trail as served, kept only when it has a dated mark to draw toward. */
  function journeyOf(value: unknown): WeekRead["journey"] {
    const j = record(value) as WeekRead["journey"];
    if (!j || !isoOf(j.start_date) || !isoOf(j.today)) return null;
    const marks = list<NonNullable<WeekRead["journey"]>["marks"][number]>(j.marks).filter((m) => isoOf(m.date));
    if (!marks.length) return null;
    return { ...j, marks, behind: list(j.behind), line: text(j.line) };
  }

  /**
   * The Week page's whole model; null when the read failed (not an object with days). A
   * read with no days is an empty week: `days` is empty and the view says so in one line.
   */
  function landing(value: unknown): ClientWeekLanding | null {
    const read = record(value) as WeekRead | null;
    if (!read || !Array.isArray(read.days)) return null;
    const chips = list<DayChip>(read.days);
    const today = isoOf(read.today) || "";
    const units = read.units?.distance === "mi" ? "mi" : "km";
    const frame = (record(read.frame) || {}) as unknown as WeekRead["frame"];
    return {
      frame,
      range: text(read.range_words),
      days: chips.map(shapeDay),
      summary: text(read.summary),
      layout_note: text(read.layout_note),
      glances: chips.map((chip) => glanceOf(chip, today, units)).filter((g): g is ClientDayGlance => !!g),
      open: list<WeekOpen>(read.still_open)
        .map(openRow)
        .filter((r): r is ClientWeekOpenRow => !!r)
        .slice(0, OPEN_MAX),
      next: list(read.next_milestones)
        .map((m) => CairnMilestoneRowModel.fromWeekRead(m))
        .filter((r): r is ClientMilestoneRow => !!r)
        .slice(0, NEXT_MAX),
      goals: list(read.goals)
        .map((g) => CairnGoalRowModel.fromWeekRead(g))
        .filter((r): r is ClientGoalRow => !!r),
      journey: journeyOf(read.journey),
      this_week: read.this_week !== false,
    };
  }

  /** The weight goal alone (the Season's goal line shows the one weight trend through it). */
  function weightGoal(value: unknown): ClientGoalRow | null {
    const read = record(value) as WeekRead | null;
    const goal = list(read?.goals).find((g) => (g as { key?: unknown }).key === "weight");
    return goal ? CairnGoalRowModel.fromWeekRead(goal) : null;
  }

  const CAIRN_WEEK_MODEL = { landing, shapeDay, weightGoal };

  Object.assign(globalThis, { CairnWeekModel: CAIRN_WEEK_MODEL });
}
