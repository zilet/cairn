// @ts-check
// The race view, the model (docs/V2-PLAN.md wave 4, "race-ladder" / "race-estimate").
// Pure shaping from GET /api/race-build onto what the race view prints. It is a READ
// over raceBuild() and never a second engine: every week, kind and kilometre comes
// from the server's ladder as given (race-ladder-model), the fit is the server's word,
// and the only arithmetic is turning the engine's kilometres into the athlete's run
// units (settings.run_units) for the words and an estimate clock to the minute for the
// head. Nothing is a score.
{
  type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
  type RaceWeek = import("../contracts/client-api.js").ClientRaceBuildWeek;
  type RaceFit = import("../contracts/client-api.js").ClientRaceFit;

  // Units and stage words live in race-week-model, THIS WEEK in race-week-runs-model
  // (both loaded first); the view model reads them there and re-exports them.
  const { STAGE_WORD, stageWord, unitsOf, kmText, distNum, runWords, liftingModel } = CairnRaceWeekModel;
  const { thisWeekModel } = CairnRaceWeekRuns;
  // The ladder and the date words live in race-ladder-model (loaded just before).
  const { KIND_WORD, dayKey, shortDate, longDate, ladderModel } = CairnRaceLadderModel;

  const PHASE_WORD: Record<string, string> = {
    base: "Base building",
    build: "Building",
    sharpen: "Sharpening",
    taper: "Tapering",
  };

  /** The fit, in words. The three words are the whole vocabulary; there is no grade. */
  const FIT_WORD: Record<RaceFit, string> = {
    fits: "Fits",
    stretch: "Stretch",
    beyond_horizon: "Beyond horizon",
  };

  const FIT_LINE: Record<RaceFit, string> = {
    fits: "The estimate sits inside the target.",
    stretch: "A stretch the build can close.",
    beyond_horizon: "Train from today's shape; the target stays the reach.",
  };

  /** Where the estimate sits against the target, in a few words: a place, never a grade. */
  const FIT_HEAD: Record<RaceFit, (target: string) => string> = {
    fits: (target) => `inside ${target}`,
    stretch: (target) => `a stretch to ${target}`,
    beyond_horizon: (target) => `${target} stays the reach`,
  };

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** A finish clock: "1:59:59", or "58:40" under the hour. "" when there is none. */
  function clock(sec: unknown): string {
    const n = num(sec);
    if (n == null || n <= 0) return "";
    const s = Math.round(n);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
    return h > 0 ? `${h}:${mm}:${String(r).padStart(2, "0")}` : `${mm}:${String(r).padStart(2, "0")}`;
  }

  /**
   * The head's countdown, in the one wording every surface prints (`race.countdown`,
   * raceCountdown): "12 days to race", "6 weeks to race", "Race week", "Tomorrow", so the
   * head and the ladder row beneath it count the same days. An older read without it
   * falls back to the current rung's calendar-week count (never the rounded-up day count).
   */
  function countdownText(race: NonNullable<RaceBuild["race"]>, weeks: RaceWeek[]): string {
    if (num(race.days_to_race) === 0) return "Race day is today";
    const said = race.countdown;
    if (said?.words) return said.span && !said.race_week && said.days > 1 ? `${said.span} to race` : said.words;
    const here = weeks.find((week) => week.current === true);
    const count = here ? num(here.weeks_to_race) : num(race.weeks_to_race);
    const out = Math.max(0, Math.round(count ?? 0));
    if (here?.kind === "race" || out === 0) return "Race week";
    // The count is calendar weeks to RACE WEEK: for the whole week before it, the race is
    // 8–13 days off, so "1 week to race" would be untrue.
    return out === 1 ? "Race week is next week" : `${out} weeks to race`;
  }

  function eventName(race: NonNullable<RaceBuild["race"]>): string {
    const event = String(race.event || "").trim();
    if (event) return event;
    const km = num(race.distance_km);
    return km != null && km >= 20.5 && km <= 21.5 ? "Your half marathon" : "Your race";
  }

  /** The race's short name on the chart: "Half", "Marathon", "10K", else "Race". */
  function raceShortName(distanceKm: unknown): string {
    const km = num(distanceKm);
    if (km == null) return "Race";
    if (km >= 20.5 && km <= 21.5) return "Half";
    if (km >= 41.5 && km <= 42.7) return "Marathon";
    if (km >= 9.8 && km <= 10.2) return "10K";
    if (km >= 4.9 && km <= 5.1) return "5K";
    return "Race";
  }

  /**
   * The whole build as terrain: the closed weeks the log already holds (from the first
   * one with running in it), then the ladder's weeks to race day. Null when there is no
   * ridge to draw. The logged weeks are the log's own kilometres, never re-derived.
   */
  function terrainModel(
    build: RaceBuild | null | undefined,
    ladder: ClientRaceLadderModel,
    units?: unknown
  ): ClientHorizonTerrain | null {
    const rows = Array.isArray(ladder?.rows) ? ladder.rows : [];
    if (rows.length < 2) return null;
    const first = rows[0].week_start;
    const review = Array.isArray(build?.review?.weeks) ? build.review.weeks : [];
    const past = review
      .map((week) => ({ week_start: dayKey(week.week_start), km: Math.max(0, num(week.km) ?? 0) }))
      .filter((week) => week.week_start && week.week_start < first)
      .sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
    const start = past.findIndex((week) => week.km > 0);
    const logged = start >= 0 ? past.slice(start) : [];
    const raceDate = dayKey(build?.race?.date);
    return {
      weeks: [
        ...logged.map((week) => ({
          week_start: week.week_start,
          km: week.km,
          kind: "logged",
          current: false,
          logged: true,
        })),
        ...rows.map((row) => ({
          week_start: row.week_start,
          km: row.km,
          kind: row.kind,
          current: row.current,
          stage: row.stage_word,
          long_km: row.long_km,
          logged_km: row.logged_km,
        })),
      ],
      race_date: raceDate,
      race_label: [raceShortName(build?.race?.distance_km), raceDate ? shortDate(raceDate) : ""]
        .filter(Boolean)
        .join(" · "),
      as_of: dayKey(build?.as_of),
      units: unitsOf(units),
    };
  }

  const COUNT_WORDS = [
    "No",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
  ];

  /** What the voice calls the race: "the half", "the 10K", else "race day". */
  function raceNoun(distanceKm: unknown): string {
    const short = raceShortName(distanceKm);
    return short === "Race"
      ? "race day"
      : `the ${short === "Half" || short === "Marathon" ? short.toLowerCase() : short}`;
  }

  /**
   * The race view's one serif line, from the ladder's own count: "Five weeks of build,
   * then the half." In the taper it is the taper; in race week, race week. Calm, never
   * a countdown alarm.
   */
  function buildVoice(ladder: ClientRaceLadderModel, race: RaceBuild["race"] | null | undefined): string {
    const rows = Array.isArray(ladder?.rows) ? ladder.rows : [];
    const here = rows.find((row) => row.current) || rows[0] || null;
    const noun = raceNoun(race?.distance_km);
    const weekday = longDate(race?.date).split(",")[0];
    if (!here || here.kind === "race" || num(race?.days_to_race) === 0) {
      return num(race?.days_to_race) === 0
        ? "Race day is today."
        : `Race week, then ${noun}${weekday ? ` on ${weekday}` : ""}.`;
    }
    if (here.kind === "taper") return `The taper, then ${noun}.`;
    const n = Math.max(1, Math.round(num(here.weeks_to_race) ?? 1));
    const count = n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
    return `${count} ${n === 1 ? "week" : "weeks"} of build, then ${noun}.`;
  }

  /** The finish estimate against the target: the server's fit word, never a gap as a grade. */
  function estimateModel(build: RaceBuild | null | undefined, units?: unknown): ClientRaceEstimateModel {
    const p = build?.prediction || null;
    const target = build?.race?.target || null;
    const fit = p && target && p.fit && FIT_WORD[p.fit] ? p.fit : null;
    const basis = p && String(p.basis_detail || "").trim() ? `From ${runWords(p.basis_detail, units)}.` : "";
    let line = fit ? FIT_LINE[fit] : "";
    if (p && !target) line = "No target time on the race, so the estimate is where today's running reads.";
    if (!p) line = "No finish estimate yet. A recent run or the watch's race predictor gives one.";
    return {
      fit,
      fit_word: fit ? FIT_WORD[fit] : "",
      fit_line: line,
      basis_text: basis,
      empty: !p,
    };
  }

  /** A finish clock to the minute for the head ("1:54"; "58 min" under the hour); "". */
  function headClock(sec: unknown): string {
    const n = num(sec);
    if (n == null || n <= 0) return "";
    const m = Math.round(n / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `${m} min`;
  }

  /**
   * The target as the athlete set it: to the minute when it is on one ("2:00"), to the
   * second when it is not ("1:52:30") — never rounded to a goal they did not set. A
   * stored bound a second or two off its minute (a "sub-2:00" kept strictly under) is
   * that minute.
   */
  function targetClock(sec: unknown): string {
    const n = num(sec);
    if (n == null || n <= 0) return "";
    const off = Math.round(n) % 60;
    return off <= 2 || off >= 58 ? headClock(n) : clock(n);
  }

  /**
   * The head's one estimate line: "Reads about 1:54 · inside sub-2:00 · 13 min faster in
   * the last month". The estimate is rounded to the minute; the target is said as set.
   * The fit is the server's word, said as a place against the target, never a gap or a
   * grade. "" with no estimate.
   */
  function fitHeadText(build: RaceBuild | null | undefined): string {
    const p = build?.prediction || null;
    const reads = headClock(p?.estimate_sec);
    if (!p || !reads) return "";
    const target = build?.race?.target || null;
    const goal = targetClock(target?.sec);
    const named = goal ? `${/^\s*sub/i.test(String(target?.raw || "")) ? "sub-" : ""}${goal}` : "";
    const fit = named && p.fit ? FIT_HEAD[p.fit](named) : "";
    const delta = Math.round(Math.abs(num(p.trend?.delta_sec) ?? 0) / 60);
    const trend = !p.trend
      ? ""
      : p.trend.word === "steady" || delta < 1
        ? "holding steady"
        : `${delta} min ${p.trend.word} in the last month`;
    return [`Reads about ${reads}`, fit, trend].filter(Boolean).join(" · ");
  }

  /** Where the estimate sits against a milestone, as a place: never a gap, never a grade. */
  const MILESTONE_NOTE: Record<RaceFit, string> = {
    fits: "Inside it now",
    stretch: "Within reach",
    beyond_horizon: "Past this build",
  };

  function paceText(secPerKm: unknown, units?: unknown): string {
    const n = num(secPerKm);
    if (n == null || n <= 0 || typeof fmtPaceBand !== "function") return "";
    return fmtPaceBand({ fast_sec_per_km: n, slow_sec_per_km: n }, units);
  }

  /**
   * The race's finish milestones, each a clock with the pace that holds it: the goal as
   * set, where today's shape reads, and the stretch when one is named. [] with neither a
   * target nor an estimate.
   */
  function finishesModel(build: RaceBuild | null | undefined, units?: unknown): ClientRaceFinish[] {
    const target = build?.race?.target || null;
    const stretch = build?.race?.stretch || null;
    const p = build?.prediction || null;
    const out: ClientRaceFinish[] = [];
    const goal = targetClock(target?.sec);
    if (target && goal) {
      out.push({
        key: "goal",
        label: "Goal",
        clock: `${/^\s*sub/i.test(String(target.raw || "")) ? "sub-" : ""}${goal}`,
        pace: paceText(target.pace_sec_per_km, units),
        note: p?.fit && MILESTONE_NOTE[p.fit] ? MILESTONE_NOTE[p.fit] : "",
      });
    }
    const now = headClock(p?.estimate_sec);
    if (p && now) {
      out.push({ key: "now", label: "Today's shape", clock: now, pace: paceText(p.estimate_pace_sec_per_km, units), note: "" });
    }
    const reach = targetClock(stretch?.sec);
    if (stretch && reach) {
      out.push({
        key: "stretch",
        label: "Stretch",
        clock: reach,
        pace: paceText(stretch.pace_sec_per_km, units),
        note: stretch.fit && MILESTONE_NOTE[stretch.fit] ? MILESTONE_NOTE[stretch.fit] : "",
      });
    }
    return out;
  }

  function pacesModel(build: RaceBuild | null | undefined, units?: unknown): Array<{ label: string; text: string }> {
    const all = Array.isArray(build?.paces?.bands) ? build.paces.bands : [];
    // The goal milestone already says the race pace; the band list does not say it twice.
    const bands = build?.race?.target ? all.filter((band) => band.key !== "race") : all;
    return bands.map((band) => {
      const pace = typeof fmtPaceBand === "function" ? fmtPaceBand(band, units) : String(band.text || "");
      const ceiling = num(band.hr_ceiling_bpm);
      return {
        label: String(band.label || band.key),
        text: ceiling != null && ceiling > 0 ? `${pace} · under ${Math.round(ceiling)} bpm` : pace,
      };
    });
  }

  /**
   * The paces fold's sentences. `build.why` is deliberately left out: the head, the estimate
   * and the ladder already say all of it, and its estimate clause prints the time gap
   * as a verdict ("4:31 off the target") in a rounded-up week count the ladder does not use.
   */
  function notesModel(build: RaceBuild | null | undefined): string[] {
    // The strength principle is "With your lifting" now, week by week, in words.
    const notes = [build?.strength?.layout, build?.ride?.placement];
    return notes.map((note) => String(note || "").trim()).filter(Boolean);
  }

  /** A build the view can paint: available, with a race. */
  function isShowable(value: unknown): value is RaceBuild {
    const build = value as RaceBuild | null;
    return !!build && typeof build === "object" && build.available !== false && !!build.race;
  }

  /** The whole view, or null when the build has nothing to show (the empty state). */
  function viewModel(
    value: unknown,
    opts: { units?: unknown; agenda?: import("../contracts/client-api.js").ClientFlexibleTrainingAgenda | null } = {}
  ): ClientRaceViewModel | null {
    if (!isShowable(value)) return null;
    const race = value.race as NonNullable<RaceBuild["race"]>;
    const ladder = ladderModel(value, opts.units);
    const countdown = countdownText(race, Array.isArray(value.weeks) ? value.weeks : []);
    return {
      event: eventName(race),
      countdown,
      race_day: longDate(race.date),
      phase_word: PHASE_WORD[race.phase] || "",
      fit_text: fitHeadText(value),
      estimate: estimateModel(value, opts.units),
      // The head prints the countdown; THIS WEEK's kicker does not say it again.
      this_week: thisWeekModel(value, opts.units, { agenda: opts.agenda, countdownShown: !!countdown }),
      lifting: liftingModel(ladder),
      ladder,
      terrain: terrainModel(value, ladder, opts.units),
      finishes: finishesModel(value, opts.units),
      paces: pacesModel(value, opts.units),
      notes: notesModel(value),
    };
  }

  const CAIRN_RACE_VIEW_MODEL = {
    FIT_WORD,
    KIND_WORD,
    STAGE_WORD,
    stageWord,
    thisWeekModel,
    liftingModel,
    distNum,
    kmText,
    runWords,
    clock,
    longDate,
    isShowable,
    ladderModel,
    terrainModel,
    raceShortName,
    buildVoice,
    estimateModel,
    finishesModel,
    fitHeadText,
    viewModel,
  };

  Object.assign(globalThis, { CairnRaceViewModel: CAIRN_RACE_VIEW_MODEL });
}
