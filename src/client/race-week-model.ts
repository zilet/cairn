// @ts-check
// The race's running words, the model: the athlete's run units (settings.run_units)
// over the engine's kilometres, a week's stage in one word, the "With your lifting"
// rows, and a runner's closed weeks (THIS WEEK itself is race-week-runs-model's). Pure
// shaping over GET /api/race-build: the engine stays in km, every figure is the
// server's, and the only arithmetic is the unit change and a bar's fraction. Loaded before race-week-runs-model
// and race-view-model, which re-exports all of it; Horizon's race lane and the race
// page both read here.
{
  type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
  type RaceWeek = import("../contracts/client-api.js").ClientRaceBuildWeek;
  type LadderRow = ClientRaceLadderRow;

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  type Units = "km" | "mi";

  function unitsOf(value: unknown): Units {
    return runUnits(value);
  }

  /** "32 km", "12.5 km" (or "19.9 mi" in miles): one decimal only when it has one. */
  function kmText(km: unknown, units?: unknown): string {
    const n = num(km);
    return n == null || n < 0 ? "" : CairnFmt.distance(n, units ?? "km");
  }

  /** The distance's number alone in the run units ("12.5"), for "9.7 of 19.5 km". */
  function distNum(km: unknown, units?: unknown): string {
    const n = num(km);
    return n == null || n < 0 ? "" : CairnFmt.distance(n, units ?? "km", true);
  }

  /**
   * The server's own run sentences (a finish estimate's basis) say "12.3 km" and
   * "5:10 /km"; in miles those figures are restated, the words left as written.
   * TODO(S1 display-words): retire this regex rewrite once finish-estimate basis and the
   * plan-week summary are written in the athlete's units by the server (spec rule 5).
   */
  function runWords(value: unknown, units?: unknown): string {
    const s = String(value || "").trim();
    if (unitsOf(units) !== "mi") return s;
    const pace = (mm: string, ss: string): string => CairnFmt.pace(Number(mm) * 60 + Number(ss), "mi");
    // Ranges first, both ends at once ("5:10–5:40 /km", "10-12 km"): the single-value
    // passes below only see a range's LAST figure, which would restate half of it.
    return s
      .replace(
        /(\d+):(\d{2})\s*([–-])\s*(\d+):(\d{2})\s*\/\s*km\b/g,
        (_m, m1: string, s1: string, dash: string, m2: string, s2: string) =>
          `${pace(m1, s1)}${dash}${pace(m2, s2)} /mi`
      )
      .replace(/(\d+):(\d{2}) ?\/ ?km\b/g, (_m, mm: string, ss: string) => `${pace(mm, ss)} /mi`)
      .replace(
        /(\d+(?:\.\d+)?)\s*([–-])\s*(\d+(?:\.\d+)?) ?km\b/g,
        (_m, a: string, dash: string, b: string) => `${distNum(Number(a), "mi")}${dash}${kmText(Number(b), "mi")}`
      )
      .replace(/(\d+(?:\.\d+)?) ?km\b/g, (_m, n: string) => kmText(Number(n), "mi"));
  }

  /**
   * A week's stage, the one word a row and the THIS WEEK block lead with: the turning
   * points by their kind (peak, a down week, the taper, race week), a build week by its
   * phase (base, build, sharpen). Race week is "Race": the row already says "Race week".
   */
  const STAGE_WORD: Record<string, string> = {
    base: "Base",
    build: "Build",
    sharpen: "Sharpen",
    peak: "Peak",
    down: "Down week",
    taper: "Taper",
    race: "Race",
  };

  function stageWord(week: Pick<RaceWeek, "kind" | "phase">): string {
    if (week.kind !== "build") return STAGE_WORD[week.kind] || "Build";
    return STAGE_WORD[week.phase] || "Build";
  }

  /**
   * "With your lifting": the server's one line per week, with a run of weeks that say the
   * same thing folded into one row ("This week – Oct 12"), so three identical build
   * weeks never read as three rows of the same sentence. [] when no week has one (a
   * running-only athlete).
   */
  function liftingModel(ladder: ClientRaceLadderModel): ClientRaceLiftingLine[] {
    const rows = (Array.isArray(ladder?.rows) ? ladder.rows : []).filter((row) => row.lifting_text);
    const out: Array<{ rows: LadderRow[]; text: string }> = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (last && last.text === row.lifting_text) last.rows.push(row);
      else out.push({ rows: [row], text: row.lifting_text });
    }
    return out.map(({ rows: group, text }) => {
      const first = group[0];
      const end = group[group.length - 1];
      const start = first.current ? "This week" : first.date_word;
      const when = group.length === 1 ? start : `${start} – ${end.date_word}`;
      return {
        when,
        stage: group.length === 1 ? first.stage_word : "",
        text,
        current: group.some((row) => row.current),
      };
    });
  }

  /**
   * A runner's closed weeks, oldest first, for the race lane with no race set: each
   * week's distance and its bar against the longest of them. [] when none ran.
   */
  function volumeWeeks(build: RaceBuild | null | undefined, units?: unknown): ClientHorizonVolumeWeek[] {
    const weeks = Array.isArray(build?.review?.weeks) ? build.review.weeks : [];
    const kms = weeks.map((w) => Math.max(0, num(w.km) ?? 0));
    const max = Math.max(0, ...kms);
    if (!(max > 0)) return [];
    return weeks.map((w, i) => {
      const key = String(w.week_start || "").slice(0, 10);
      return {
        week_start: key,
        date_word: /^\d{4}-\d{2}-\d{2}$/.test(key) ? CairnUiChart.dateLabel(key) : "",
        km_text: kms[i] > 0 ? kmText(kms[i], units) : "—",
        frac: Math.round((kms[i] / max) * 1000) / 1000,
      };
    });
  }

  const CAIRN_RACE_WEEK_MODEL = {
    STAGE_WORD,
    stageWord,
    unitsOf,
    kmText,
    distNum,
    runWords,
    liftingModel,
    volumeWeeks,
  };

  Object.assign(globalThis, { CairnRaceWeekModel: CAIRN_RACE_WEEK_MODEL });
}
