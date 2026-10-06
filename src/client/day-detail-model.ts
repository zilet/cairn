// @ts-check
// The day detail, the model: GET /api/plan/day-detail shaped for the one shared day
// view (day-detail-client.ts) that Horizon's week, Train's week ahead and Today's
// "What's ahead" strip all open. Nothing here decides what a day is for, what a lift
// loads or how a run is built: the read owns every word and number. This only frames
// them — where the day sits against today in words, a run's parts as proportions of a
// bar, the day's movements as regions of the body figure, distances and paces in the
// athlete's run units. Pure; no DOM, no fetch.
//
// LAZY ("day" bundle), loaded before the view and the controller.
{
  type DayDetail = import("../contracts/day-detail.js").DayDetail;
  type DayDetailRun = import("../contracts/day-detail.js").DayDetailRun;
  type DayDetailSegment = import("../contracts/day-detail.js").DayDetailRunSegment;
  type DayDetailExercise = import("../contracts/day-detail.js").DayDetailExercise;

  // The day's state as one quiet word beside where it sits. "open" is a past day whose
  // plan was not logged: said neutrally ("Left open"), never as "missed".
  const STATUS_WORD: Readonly<Record<string, string>> = {
    done: "Done",
    today: "Still to do",
    upcoming: "Planned",
    rest: "Rest day",
    open: "Left open",
  };

  /** The hero's mono kicker: "Tomorrow · Planned", "Today · Still to do", "Yesterday · Done". */
  function kicker(detail: Pick<DayDetail, "date" | "today" | "status">): string {
    const where = CairnFmt.relDay(detail.date, detail.today);
    const word = STATUS_WORD[detail.status] || "";
    if (detail.status === "today" && where === "Today") return "Today";
    return word ? `${where} · ${word}` : where;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** "5.8 km" / "3.6 mi" — one distance in the athlete's run units. */
  function distText(km: number | null | undefined, units: unknown): string {
    const n = Number(km);
    if (km == null || !Number.isFinite(n) || n <= 0) return "";
    return CairnFmt.distance(n, units);
  }

  /**
   * A pace band in the athlete's units, from the read's own seconds ("6:55–7:25 /km",
   * "11:08–11:57 /mi"). The read writes its text in /km; a miles athlete reads miles.
   */
  function paceText(
    pace: { text?: string; slow_sec_per_km?: number; fast_sec_per_km?: number } | null | undefined,
    units: unknown
  ): string {
    if (!pace) return "";
    const fast = Number(pace.fast_sec_per_km);
    const slow = Number(pace.slow_sec_per_km);
    if (Number.isFinite(fast) && Number.isFinite(slow) && fast > 0 && slow > 0) {
      const a = CairnFmt.pace(Math.min(fast, slow), units);
      const b = CairnFmt.pace(Math.max(fast, slow), units);
      return `${a === b ? a : `${a}–${b}`} ${fmtRunUnitSuffix(units)}`;
    }
    return text(pace.text);
  }

  function bandText(low: number | null | undefined, high: number | null | undefined): string {
    const lo = Number(low);
    const hi = Number(high);
    if (low == null || high == null || !Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return "";
    return `${Math.round(lo)}–${Math.round(hi)} bpm`;
  }

  /** The zone key as a CSS-safe suffix ("z4"), or "" when the read names none. */
  function zoneClass(key: unknown): string {
    const k = String(key || "").toUpperCase();
    return /^Z[1-5]$/.test(k) ? k.toLowerCase() : "";
  }

  type SegmentView = {
    part: DayDetailSegment["part"];
    label: string;
    text: string;
    /** The segment's share of the bar, 0–1; the parts sum to 1. */
    frac: number;
    zone: string;
    zoneKey: string;
    dist: string;
    reps: number;
    hr: string;
    pace: string;
  };

  /**
   * The run's parts as shares of one bar, drawn to scale where the engine sizes them.
   * A part the engine does not size (a tempo's warm-up) takes a modest share of what is
   * known, so the bar still reads warm-up → work → cool-down without inventing a
   * distance (its row says none). A run with no structure is one easy segment.
   */
  function runSegments(run: DayDetailRun | null | undefined): SegmentView[] {
    if (!run) return [];
    const units = run.run_units;
    const raw: DayDetailSegment[] = Array.isArray(run.structure) ? run.structure.filter(Boolean) : [];
    const list: DayDetailSegment[] = raw.length
      ? raw
      : [
          {
            part: "main",
            label: text(run.label) || "Run",
            text: text(run.session),
            km: run.km,
            mi: run.mi,
            reps: null,
            on: null,
            off: null,
            zone: run.zone?.key ?? null,
            hr:
              run.zone && run.zone.low_bpm && run.zone.high_bpm
                ? { low_bpm: run.zone.low_bpm, high_bpm: run.zone.high_bpm }
                : null,
            pace: run.pace
              ? {
                  text: run.pace.text,
                  slow_sec_per_km: run.pace.slow_sec_per_km,
                  fast_sec_per_km: run.pace.fast_sec_per_km,
                }
              : null,
          },
        ];
    const known = list.map((s) => (Number(s.km) > 0 ? Number(s.km) : 0));
    const knownSum = known.reduce((a, b) => a + b, 0);
    // An unsized part: a fifth of what is known, or an equal share when nothing is.
    const fallback = knownSum > 0 ? knownSum / 5 : 1;
    const weights = known.map((k) => (k > 0 ? k : fallback));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    return list.map((s, i) => ({
      part: s.part,
      label: text(s.label) || (s.part === "warm_up" ? "Warm-up" : s.part === "cool_down" ? "Cool-down" : "Run"),
      text: text(s.text),
      frac: weights[i] / total,
      zone: zoneClass(s.zone),
      zoneKey: zoneClass(s.zone).toUpperCase(),
      dist: distText(s.km, units),
      reps: Number(s.reps) > 1 ? Math.min(12, Math.round(Number(s.reps))) : 0,
      hr: s.hr ? bandText(s.hr.low_bpm, s.hr.high_bpm) : "",
      pace: paceText(s.pace, units),
    }));
  }

  // The plan's muscle words onto the body figure's regions. A compound word ("legs",
  // "posterior") lights every region it loads; an unknown word lights nothing.
  const REGIONS: Readonly<Record<string, readonly string[]>> = {
    chest: ["chest"],
    back: ["back"],
    lats: ["back"],
    "upper back": ["back"],
    shoulders: ["shoulders"],
    delts: ["shoulders"],
    "rear delts": ["rear delts"],
    biceps: ["biceps"],
    triceps: ["triceps"],
    arms: ["biceps", "triceps"],
    forearms: ["forearms"],
    grip: ["forearms"],
    core: ["core"],
    abs: ["core"],
    quads: ["quads"],
    hamstrings: ["hamstrings"],
    glutes: ["glutes"],
    calves: ["calves"],
    legs: ["quads", "glutes", "hamstrings"],
    "lower body": ["quads", "glutes", "hamstrings"],
    posterior: ["hamstrings", "glutes", "back"],
    "posterior chain": ["hamstrings", "glutes", "back"],
    "full body": ["chest", "back", "shoulders", "quads", "glutes", "hamstrings"],
  };
  const FRONT = new Set(["chest", "shoulders", "biceps", "forearms", "core", "quads", "calves"]);

  /**
   * The day's movements as body-figure tones: the anchor's regions lead ("high"), every
   * other worked region is "ok". `front`/`back` say which side has anything to show.
   */
  function muscleTones(exercises: readonly DayDetailExercise[] | null | undefined): {
    tones: Record<string, string>;
    front: boolean;
    back: boolean;
  } {
    const tones: Record<string, string> = {};
    for (const ex of exercises || []) {
      if (!ex || ex.mode === "mobility") continue;
      const regions =
        REGIONS[
          String(ex.muscle_group || "")
            .toLowerCase()
            .trim()
        ] || [];
      for (const region of regions) {
        if (ex.anchor) tones[region] = "high";
        else if (!tones[region]) tones[region] = "ok";
      }
    }
    const keys = Object.keys(tones);
    return { tones, front: keys.some((k) => FRONT.has(k)), back: keys.some((k) => !FRONT.has(k) || k === "calves") };
  }

  /**
   * The read's `why`, less a lead the hero's context line already says ("Lighter week ·
   * 5 weeks to Coastal half marathon."), so the day never states its week twice.
   */
  function whyRest(detail: Pick<DayDetail, "why" | "week">): string {
    const why = text(detail.why);
    const race = detail.week?.race;
    if (!why || !race) return why;
    const lead = why.match(/^[^.]*·[^.]*\bweeks? to\b[^.]*\.\s*/);
    return lead ? why.slice(lead[0].length).trim() : why;
  }

  /** The week's place in a line: "Lighter week · 5 weeks to Coastal half marathon · Block week 1 of 6". */
  function contextLine(detail: Pick<DayDetail, "week">): string {
    const bits: string[] = [];
    const race = detail.week?.race;
    if (race) {
      const weeks = Number(race.weeks_to_race);
      const to =
        race.kind === "race"
          ? text(race.event) || "Race week"
          : Number.isFinite(weeks) && weeks > 0 && race.event
            ? `${weeks} week${weeks === 1 ? "" : "s"} to ${text(race.event)}`
            : text(race.event);
      bits.push([text(race.word), to].filter(Boolean).join(" · "));
    }
    const block = detail.week?.block;
    if (block && Number(block.total_weeks) > 0) bits.push(`Block week ${block.week_index} of ${block.total_weeks}`);
    return bits.filter(Boolean).join(" · ");
  }

  /** One logged run in a line: "8.1 km · 48 min · 5:55 /km · easy". */
  function doneRunText(
    run: {
      km?: number | null;
      distance_km?: number | null;
      duration_min?: number | null;
      pace_sec_per_km?: number | null;
      pace?: string | null;
      effort?: string | null;
      note?: string | null;
    },
    units: unknown
  ): string {
    const km = run.km ?? run.distance_km ?? null;
    const sec = Number(run.pace_sec_per_km);
    const pace =
      Number.isFinite(sec) && sec > 0
        ? `${CairnFmt.pace(sec, units)} ${fmtRunUnitSuffix(units)}`
        : units === "mi"
          ? ""
          : text(run.pace);
    return [
      distText(km, units),
      Number(run.duration_min) > 0 ? `${Math.round(Number(run.duration_min))} min` : "",
      pace,
      text(run.effort),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const CAIRN_DAY_DETAIL_MODEL = {
    kicker,
    distText,
    paceText,
    bandText,
    zoneClass,
    runSegments,
    muscleTones,
    whyRest,
    contextLine,
    doneRunText,
  };

  Object.assign(globalThis, { CairnDayDetailModel: CAIRN_DAY_DETAIL_MODEL });
}
