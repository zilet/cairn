// @ts-check
// The race ladder, the model: the server's weeks to race day as rows, with the last few
// closed weeks from the review above them, every bar against the biggest week on the
// page. A READ over raceBuild(): every week, kind and kilometre is the server's ladder
// as given; the only arithmetic is a bar's fraction and the run units. Also the date
// words the race view shares ("Nov 1", "Sunday, Nov 1"). Loaded after race-week-model
// and before race-view-model, which re-exports what it publishes.
{
  type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
  type RaceWeek = import("../contracts/client-api.js").ClientRaceBuildWeek;
  type LadderRow = ClientRaceLadderRow;
  const { stageWord, unitsOf, kmText, distNum, runWords } = CairnRaceWeekModel;

  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

  const KIND_WORD: Record<RaceWeek["kind"], string> = {
    build: "Build",
    down: "Down week",
    peak: "Peak",
    taper: "Taper",
    race: "Race",
  };

  /** The closed weeks the ladder shows above this week: enough to see the climb, no more. */
  const PAST_WEEKS = 3;

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dayKey(iso: unknown): string {
    const key = String(iso || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
  }

  /** "Nov 1", through the one shared date label. */
  function shortDate(iso: unknown): string {
    const key = dayKey(iso);
    return key ? CairnUiChart.dateLabel(key) : "";
  }

  /** "Sunday, Nov 1". */
  function longDate(iso: unknown): string {
    const key = dayKey(iso);
    if (!key) return "";
    const d = new Date(`${key}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return "";
    return `${WEEKDAYS[d.getUTCDay()]}, ${shortDate(key)}`;
  }

  /** "3 runs", "1 run"; "" with no count. */
  function runsWord(runs: unknown): string {
    const n = Math.max(0, Math.round(num(runs) ?? 0));
    return n > 0 ? `${n} ${n === 1 ? "run" : "runs"}` : "";
  }

  /**
   * The ladder: the server's weeks as rows, the last few closed weeks from the review
   * above them, every bar against the biggest week on the page — so a week run past its
   * plan, or a closed week bigger than the plan ahead, is drawn to the same scale. One
   * encoding: an actual is solid, a plan is an outline, this week is its logged solid
   * inside its planned outline. The km figure never sets a plan number beside an
   * actual bar: this week reads "35.8 of 19.5 km" while open, its actual once closed.
   */
  function ladderModel(build: RaceBuild | null | undefined, units?: unknown): ClientRaceLadderModel {
    const weeks = Array.isArray(build?.weeks) ? build.weeks : [];
    // A closed current rung IS the week as run (`km`); its plan rides on `planned_km`.
    // With no prescription behind it (`planned_km` null) there is no plan to outline: the
    // row is drawn like a closed week, its actual alone.
    const unplanned = (week: RaceWeek): boolean => week.current === true && week.closed === true && num(week.planned_km) == null;
    const kms = weeks.map((week) =>
      Math.max(0, num(week.current && week.closed && !unplanned(week) ? week.planned_km : week.km) ?? 0)
    );
    const first = dayKey(weeks[0]?.week_start);
    const thisWeek = build?.this_week || null;
    const review = Array.isArray(build?.review?.weeks) ? build.review.weeks : [];
    // The current week once the server closes it into the review: its own figure and count.
    const here = weeks.find((week) => week.current === true);
    const closedRow = here ? review.find((week) => dayKey(week.week_start) === dayKey(here.week_start)) : undefined;
    const closed = here?.closed === true || thisWeek?.closed === true || !!closedRow;
    const loggedRaw = num(closedRow?.km ?? thisWeek?.logged_km);
    const logged = loggedRaw != null && loggedRaw > 0 ? loggedRaw : null;
    const pastWeeks = review
      .map((week) => ({ week_start: dayKey(week.week_start), km: Math.max(0, num(week.km) ?? 0), runs: week.runs }))
      .filter((week) => week.week_start && (!first || week.week_start < first))
      .sort((a, b) => (a.week_start < b.week_start ? -1 : 1))
      .slice(-PAST_WEEKS);
    const maxKm = Math.max(0, ...kms, logged ?? 0, ...pastWeeks.map((week) => week.km));
    const scale = CairnUiChart.linearScale(0, maxKm, 0, 1);
    const frac = (km: number): number => Math.round(Math.min(1, Math.max(0, scale(km))) * 1000) / 1000;
    const raceDay = longDate(build?.race?.date);
    const past: ClientRaceLadderPastRow[] = pastWeeks.map((week) => ({
      week_start: week.week_start,
      date_word: shortDate(week.week_start),
      km: week.km,
      km_text: week.km > 0 ? kmText(week.km, units) : "Rest",
      runs_text: runsWord(week.runs),
      frac: frac(week.km),
      bar_label: `Week of ${shortDate(week.week_start)}: ${week.km > 0 ? `${kmText(week.km, units)} run` : "no running"}`,
    }));
    const rows: LadderRow[] = weeks.map((week, index) => {
      const km = kms[index];
      const current = week.current === true;
      const out = Math.max(0, Math.round(num(week.weeks_to_race) ?? 0));
      const long = num(week.long_km);
      const loggedKm = current ? (unplanned(week) ? (logged ?? km) : logged) : null;
      const shut = current && closed;
      const noPlan = unplanned(week);
      const kmWords =
        loggedKm == null
          ? kmText(km, units)
          : shut
            ? kmText(loggedKm, units)
            : `${distNum(loggedKm, units)} of ${kmText(km, units)}`;
      const recap = shut
        ? closedRow
          ? // The km sits beside the bar already: the foot says the count and the plan it ran against.
            [runsWord(closedRow.runs), km > 0 && !noPlan ? `plan ${kmText(km, units)}` : ""].filter(Boolean).join(" · ")
          : runWords(String(thisWeek?.headline || "").trim(), units)
        : "";
      return {
        week_start: dayKey(week.week_start),
        weeks_to_race: out,
        kind: week.kind,
        kind_word: KIND_WORD[week.kind] || "Build",
        // The server's one countdown wording (raceCountdown): "12 days out", "Race week",
        // "3 wks out". The calendar-week count is only the fallback for an older read.
        out_word: week.countdown_words || (out === 0 ? "Race week" : `${out} wk out`),
        date_word: shortDate(week.week_start),
        km,
        km_text: kmWords,
        stage_word: stageWord(week),
        long_km: long != null && long > 0 && week.kind !== "race" ? long : null,
        long_text: long != null && long > 0 && week.kind !== "race" && !shut ? `long ${kmText(long, units)}` : "",
        // No plan outline for a closed week with no prescription: the logged solid alone.
        frac: noPlan ? 0 : frac(km),
        current,
        closed: shut,
        logged_km: loggedKm,
        logged_frac: loggedKm != null && maxKm > 0 ? frac(loggedKm) : null,
        race_day_text: week.kind === "race" && raceDay ? `Race day, ${raceDay}` : "",
        focus_text: String(week.focus || "").trim(),
        focus_short: String(week.focus_short || "").trim(),
        recap_text: recap,
        lifting_text: String(week.with_lifting || "").trim(),
        bar_label: [
          `Week of ${shortDate(week.week_start)}`,
          loggedKm != null
            ? noPlan
              ? `${kmText(loggedKm, units)} run`
              : `${kmText(loggedKm, units)} run of ${kmText(km, units)} planned`
            : `${kmText(km, units)} planned`,
        ].join(": "),
      };
    });
    const taper = rows.find((row) => row.kind === "taper");
    const taperText = !taper
      ? ""
      : taper.current
        ? "This week is the taper: the volume comes down so race day finds you fresh."
        : `The taper starts the week of ${taper.date_word}, the week before race week.`;
    // A bigger recent week the build does not climb from, and why — the server's one
    // sentence, its figures restated in the run units. "" when nothing is set aside.
    const capacityText = runWords(String(build?.capacity?.note || "").trim(), units);
    // How the ladder moved with the running actually done: the server's sentence, when sent.
    const adapted = build?.adapted;
    return {
      rows,
      past,
      max_km: maxKm,
      taper_text: taperText,
      capacity_text: capacityText,
      adapted_text: runWords(String(adapted || "").trim(), units),
      units: unitsOf(units),
    };
  }

  const CAIRN_RACE_LADDER_MODEL = { KIND_WORD, WEEKDAYS, dayKey, shortDate, longDate, ladderModel };

  Object.assign(globalThis, { CairnRaceLadderModel: CAIRN_RACE_LADDER_MODEL });
}
