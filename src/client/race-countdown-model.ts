// @ts-check
// The race countdown, the model: GET /api/race-build/days as rows a person reads — a
// week's heading in the build's own words (its stage word and focus), then one row a
// day from today to race day: the date and how many days out, the run with its
// distance, pace band and quality parts, the lift with a "legs lighter" mark, travel,
// and the coach's changes on the day. A READ: every run, distance, pace and sentence is
// the server's (src/domain/training/race-days.ts) — the only words made here are the
// date and the marks; "N days out" is the server's countdown wording (`out_words`). Shown only within three weeks of a dated race
// (`shows`, over /race-build); farther out the weekly ladder leads.
{
  type RaceDays = import("../contracts/race-days.js").RaceDays;
  type RaceDay = import("../contracts/race-days.js").RaceDay;
  type RaceDaysWeek = import("../contracts/race-days.js").RaceDaysWeek;

  /** The countdown opens three weeks out (RACE_DAYS_WINDOW on the server). */
  const WINDOW_DAYS = 21;
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

  function text(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  /** "Mon Oct 19"; "" for anything that is not a date. */
  function dayDate(iso: unknown): string {
    const key = String(iso || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
    const d = new Date(`${key}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return "";
    return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  /**
   * The server's one countdown wording for the row (`out_words`: "Race day", "Tomorrow",
   * "13 days out" — raceCountdown, src/repo/race-build.ts), today leading with "Today ·".
   * Today's row never pairs that with a word naming ANOTHER day: on the eve it is
   * "Today · 1 day out", never "Today · Tomorrow". An older read counts the days the same way.
   */
  function outText(day: Pick<RaceDay, "days_out" | "race_day" | "today" | "out_words">): string {
    const n = Math.max(0, Math.round(Number(day.days_out) || 0));
    const out = text(day.out_words) || (day.race_day || n === 0 ? "Race day" : n === 1 ? "Tomorrow" : `${n} days out`);
    return day.today && !day.race_day ? `Today · ${n === 1 ? "1 day out" : out}` : out;
  }

  /** True when /race-build reads a dated race inside the countdown's window. */
  function shows(build: unknown): boolean {
    const b = build as { available?: unknown; race?: { days_to_race?: unknown; date?: unknown } | null } | null;
    if (!b || typeof b !== "object" || b.available === false || !b.race || !b.race.date) return false;
    const n = Number(b.race.days_to_race);
    return Number.isFinite(n) && n >= 0 && n <= WINDOW_DAYS;
  }

  function runModel(day: RaceDay): ClientRaceCountdownRow["run"] {
    const run = day.run;
    if (!run) return null;
    const figure = [text(run.distance_text), text(run.pace_text)].filter(Boolean).join(" · ");
    return {
      title: text(run.label) || "Run",
      figure,
      structure: text(run.structure_text),
      done: run.status === "completed",
      kind: run.kind,
    };
  }

  function liftModel(day: RaceDay): ClientRaceCountdownRow["lift"] {
    const lift = day.lift;
    if (!lift || !text(lift.name)) return null;
    const marks: string[] = [];
    if (lift.legs_lighter) marks.push("legs lighter");
    if (lift.done) marks.push("done");
    return { name: text(lift.name), marks, heavy: lift.heavy_lower === true };
  }

  function travelWords(day: RaceDay): string {
    const label = text(day.travel?.label);
    if (!day.travel) return "";
    return !label || label === "Travelling" ? "Travelling" : `Travelling · ${label}`;
  }

  /** The coach changes' titles ("Adapted" rows), a day's or a week's. */
  function titles(list: unknown): string[] {
    return (Array.isArray(list) ? list : []).map((change) => text(change?.title)).filter(Boolean);
  }

  function rowModel(day: RaceDay): ClientRaceCountdownRow {
    const adapted = titles(day.changes);
    return {
      date: day.date,
      when: dayDate(day.date),
      out: outText(day),
      today: day.today === true,
      race: day.race_day === true,
      done: day.status === "done",
      rest: day.rest === true && !day.race_day,
      run: runModel(day),
      lift: liftModel(day),
      travel: travelWords(day),
      adapted,
    };
  }

  function weekModel(week: RaceDaysWeek, index: number): ClientRaceCountdownWeek {
    const stage = text(week.stage_word);
    const short = text(week.focus_short);
    const title = [stage || (index === 0 ? "This week" : ""), short].filter(Boolean).join(" · ") || "The week";
    return {
      week_start: week.week_start,
      title,
      focus: text(week.focus),
      lifting: text(week.with_lifting),
      adapted: titles(week.changes),
      rows: (Array.isArray(week.days) ? week.days : []).map(rowModel),
    };
  }

  /** The countdown, or null when the read has none (no dated race, too far out, a failed read). */
  function countdownModel(value: unknown): ClientRaceCountdownModel | null {
    const read = value as RaceDays | null;
    if (!read || typeof read !== "object" || read.available !== true || !read.race) return null;
    const weeks = (Array.isArray(read.weeks) ? read.weeks : []).map(weekModel).filter((w) => w.rows.length);
    if (!weeks.length) return null;
    const race = read.race;
    return {
      race: {
        event: text(race.event),
        when: dayDate(race.date),
        distance: text(race.distance_text),
        target: text(race.target_text),
        pace: text(race.pace_text),
      },
      weeks,
    };
  }

  const CAIRN_RACE_COUNTDOWN_MODEL = { WINDOW_DAYS, dayDate, outText, shows, countdownModel };

  Object.assign(globalThis, { CairnRaceCountdownModel: CAIRN_RACE_COUNTDOWN_MODEL });
}
